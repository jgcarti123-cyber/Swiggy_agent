import { config, redirectUri } from "../config.js";
import { generateCodeChallenge, generateCodeVerifier, generateState } from "./pkce.js";
import { getOAuthClient, saveOAuthClient, getToken, saveToken, clearToken } from "../db.js";

export class NeedsReauthError extends Error {
  constructor(message = "Swiggy access token missing or expired — re-authenticate") {
    super(message);
    this.name = "NeedsReauthError";
    this.statusCode = 401;
  }
}

// In-memory PKCE state, keyed by the OAuth `state` param. Single-user,
// single-process app — these only need to survive the few seconds between
// the redirect out and the callback coming back, so they don't belong in
// SQLite alongside the durable token/address state.
const pendingAuthorizations = new Map();

let metadataCache = null;

// Discover live endpoints via RFC 8414 metadata rather than hardcoding paths,
// per https://mcp.swiggy.com/builders/docs/start/authenticate.md
async function getServerMetadata() {
  if (metadataCache) return metadataCache;
  const res = await fetch(config.swiggy.metadataUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch Swiggy OAuth metadata: ${res.status}`);
  }
  metadataCache = await res.json();
  return metadataCache;
}

// Dynamic Client Registration (RFC 7591). Swiggy's docs say MCP-compatible
// clients call this transparently; we do it once and persist the client_id.
async function ensureClientRegistration() {
  const existing = getOAuthClient();
  if (existing && existing.redirect_uri === redirectUri()) {
    return existing;
  }

  const metadata = await getServerMetadata();
  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri()],
      token_endpoint_auth_method: "none", // public client, PKCE-only — advertised in metadata
      grant_types: ["authorization_code"],
      response_types: ["code"],
      client_name: "Swiggy Personal Dashboard (localhost)",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dynamic Client Registration failed: ${res.status} ${body}`);
  }

  const registration = await res.json();
  saveOAuthClient({
    clientId: registration.client_id,
    clientSecret: registration.client_secret ?? null,
    redirectUri: redirectUri(),
  });
  return getOAuthClient();
}

export async function buildAuthorizationUrl() {
  const metadata = await getServerMetadata();
  const client = await ensureClientRegistration();

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  pendingAuthorizations.set(state, { codeVerifier, createdAt: Date.now() });
  // Authorization codes are single-use and expire in 120s per the docs; prune
  // anything that's clearly stale so this map doesn't grow across retries.
  for (const [key, value] of pendingAuthorizations) {
    if (Date.now() - value.createdAt > 5 * 60 * 1000) pendingAuthorizations.delete(key);
  }

  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.client_id);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", config.swiggy.scope);
  return url.toString();
}

export async function handleAuthorizationCallback({ code, state }) {
  const pending = pendingAuthorizations.get(state);
  if (!pending) {
    throw new Error("Unknown or expired OAuth state — restart the login flow");
  }
  pendingAuthorizations.delete(state);

  const metadata = await getServerMetadata();
  const client = getOAuthClient();
  if (!client) {
    throw new Error("No registered OAuth client on file — restart the login flow");
  }

  // https://mcp.swiggy.com/builders/docs/start/authenticate.md shows a JSON
  // body without client_id, but per RFC 6749 §3.2.1 a public client (auth
  // method "none") must still identify itself at the token endpoint since
  // there's no secret to authenticate with — so it's included here too.
  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: pending.codeVerifier,
      redirect_uri: redirectUri(),
      client_id: client.client_id,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: ${res.status} ${body}`);
  }

  const tokenResponse = await res.json();
  const expiresAt = Date.now() + tokenResponse.expires_in * 1000;
  saveToken({
    accessToken: tokenResponse.access_token,
    tokenType: tokenResponse.token_type,
    scope: tokenResponse.scope,
    expiresAt,
  });
  return { expiresAt };
}

export function getAuthStatus() {
  const token = getToken();
  if (!token) return { authenticated: false };
  const expiresAt = token.expires_at;
  if (Date.now() >= expiresAt) return { authenticated: false, expired: true };
  return { authenticated: true, expiresAt };
}

// Every Swiggy tool call needs this. There is no refresh token in v1 — an
// expired/missing token means the user must click through /auth/login again.
export function getValidAccessToken() {
  const token = getToken();
  if (!token || Date.now() >= token.expires_at) {
    throw new NeedsReauthError();
  }
  return token.access_token;
}

export async function logout() {
  const token = getToken();
  if (token) {
    // Not in the RFC 8414 metadata (no revocation_endpoint field) — this is
    // the literal /auth/logout path from
    // https://mcp.swiggy.com/builders/docs/start/authenticate.md
    await fetch(`${config.swiggy.authIssuer}/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.access_token}` },
    }).catch(() => {
      // Best-effort revoke; local token clear below is what actually matters.
    });
  }
  clearToken();
}
