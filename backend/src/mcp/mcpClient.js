import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getValidAccessToken, NeedsReauthError } from "../auth/oauthClient.js";

// One cached, connected MCP client per server URL, keyed alongside the token
// it was built with — reconnected transparently when the token changes
// (e.g. after a fresh /auth/login) or when the transport reports an error.
const cache = new Map();

async function getClient(serverUrl) {
  const token = getValidAccessToken(); // throws NeedsReauthError if missing/expired

  const cached = cache.get(serverUrl);
  if (cached && cached.token === token) {
    return cached.client;
  }
  if (cached) {
    await cached.client.close().catch(() => {});
    cache.delete(serverUrl);
  }

  const client = new Client({ name: "swiggy-personal-dashboard", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });

  client.onerror = () => cache.delete(serverUrl);
  client.onclose = () => cache.delete(serverUrl);

  await client.connect(transport);
  cache.set(serverUrl, { client, token });
  return client;
}

export class SwiggyToolError extends Error {
  constructor(message, { tool, statusCode } = {}) {
    super(message);
    this.name = "SwiggyToolError";
    this.tool = tool;
    this.statusCode = statusCode;
  }
}

function extractResult(result, toolName) {
  if (result.isError) {
    const message =
      result.content?.find((c) => c.type === "text")?.text || `${toolName} call failed`;
    throw new SwiggyToolError(message, { tool: toolName });
  }
  if (result.structuredContent) return result.structuredContent;

  const textBlocks = (result.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text);

  if (textBlocks.length === 0) return null;
  if (textBlocks.length === 1) {
    try {
      return JSON.parse(textBlocks[0]);
    } catch {
      return textBlocks[0];
    }
  }
  return textBlocks.join("\n");
}

// Not a Swiggy tool-level rejection (wrong item, out of stock, etc) — a raw
// transport/connection failure. Confirmed live: a long-running cached client
// kept failing every call with "fetch failed" while a brand-new connection to
// the identical server succeeded immediately, meaning the cached connection
// itself had gone bad, not the request. Retrying through the SAME cache entry
// just repeats the same failure.
const NETWORK_ERROR_PATTERN = /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network error|ETIMEDOUT/i;

export async function callSwiggyTool(serverUrl, name, args) {
  try {
    // getClient() is INSIDE the try, not before it: it isn't just a cache
    // lookup — on a cache miss it does the actual MCP handshake
    // (client.connect()), which is a network call that can itself throw the
    // same 401 a tool call can. Confirmed live: after one call's failure
    // evicted the cached connection (see below), every subsequent call tried
    // a fresh handshake with the same now-invalid token, and that failure
    // was propagating straight out of callSwiggyTool completely unclassified
    // — none of the auth-error handling below ever ran for it, because it
    // happened before this function's own try block used to start.
    const client = await getClient(serverUrl);
    const result = await client.callTool({ name, arguments: args });
    return extractResult(result, name);
  } catch (err) {
    // A 401 mid-session means the token was revoked/expired server-side; a
    // network-level failure means the cached connection is broken. Either
    // way, drop it so the next call (including instamartClient's retry)
    // reconnects from scratch instead of repeatedly hitting the same dead
    // connection.
    const isAuthError = err?.code === 401 || /401|unauthorized|invalid_token|token.?expired|jwt.*expired/i.test(String(err?.message));
    if (isAuthError || NETWORK_ERROR_PATTERN.test(String(err?.message))) {
      cache.delete(serverUrl);
    }
    // Confirmed live: getValidAccessToken()'s local expires_at check can
    // still pass (the 5-day window hasn't elapsed) while Swiggy's actual JWT
    // has already expired server-side — the transport throws a raw 401 here,
    // not through extractResult's SwiggyToolError path. Normalize it to the
    // same NeedsReauthError an already-expired local token produces, so every
    // caller — routes, the LLM tool loop, the deterministic direct actions —
    // treats a mid-session auth failure identically instead of some of them
    // treating it as a generic/cart error and swallowing it into a
    // confusing raw message.
    if (isAuthError) throw new NeedsReauthError();
    throw err;
  }
}
