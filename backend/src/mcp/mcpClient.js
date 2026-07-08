import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getValidAccessToken } from "../auth/oauthClient.js";

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

export async function callSwiggyTool(serverUrl, name, args) {
  const client = await getClient(serverUrl);
  try {
    const result = await client.callTool({ name, arguments: args });
    return extractResult(result, name);
  } catch (err) {
    // A 401 mid-session means the token was revoked/expired server-side;
    // drop the cached connection so the next call re-checks getValidAccessToken().
    if (err?.code === 401 || /401|unauthorized/i.test(String(err?.message))) {
      cache.delete(serverUrl);
    }
    throw err;
  }
}
