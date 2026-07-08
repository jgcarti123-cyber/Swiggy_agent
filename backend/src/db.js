import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "data", "app.db");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_client (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    client_id TEXT NOT NULL,
    client_secret TEXT,
    redirect_uri TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_token (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT NOT NULL,
    token_type TEXT NOT NULL,
    scope TEXT,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS saved_address (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    address_id TEXT NOT NULL,
    label TEXT,
    raw_json TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS coupon_cache (
    restaurant_id TEXT PRIMARY KEY,
    address_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    order_id TEXT,
    summary_json TEXT,
    created_at TEXT NOT NULL
  );
`);

// --- OAuth client registration (DCR result), single row ---
export function saveOAuthClient({ clientId, clientSecret, redirectUri }) {
  db.prepare(
    `INSERT INTO oauth_client (id, client_id, client_secret, redirect_uri, created_at)
     VALUES (1, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       client_id = excluded.client_id,
       client_secret = excluded.client_secret,
       redirect_uri = excluded.redirect_uri,
       created_at = excluded.created_at`
  ).run(clientId, clientSecret ?? null, redirectUri);
}

export function getOAuthClient() {
  return db.prepare(`SELECT * FROM oauth_client WHERE id = 1`).get() ?? null;
}

// --- OAuth token, single row (5-day-lived, no refresh token in v1) ---
export function saveToken({ accessToken, tokenType, scope, expiresAt }) {
  db.prepare(
    `INSERT INTO oauth_token (id, access_token, token_type, scope, expires_at, created_at)
     VALUES (1, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       token_type = excluded.token_type,
       scope = excluded.scope,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at`
  ).run(accessToken, tokenType, scope ?? null, expiresAt);
}

export function getToken() {
  return db.prepare(`SELECT * FROM oauth_token WHERE id = 1`).get() ?? null;
}

export function clearToken() {
  db.prepare(`DELETE FROM oauth_token WHERE id = 1`).run();
}

// --- Saved address (single user, one active delivery address at a time) ---
export function saveAddress({ addressId, label, raw }) {
  db.prepare(
    `INSERT INTO saved_address (id, address_id, label, raw_json, updated_at)
     VALUES (1, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       address_id = excluded.address_id,
       label = excluded.label,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`
  ).run(addressId, label ?? null, JSON.stringify(raw ?? null));
}

export function getSavedAddress() {
  const row = db.prepare(`SELECT * FROM saved_address WHERE id = 1`).get();
  if (!row) return null;
  return { ...row, raw: row.raw_json ? JSON.parse(row.raw_json) : null };
}

// --- Coupon cache (short-TTL, read in Feature 1 to avoid refetching on every keystroke) ---
const COUPON_CACHE_TTL_MS = 2 * 60 * 1000;

export function cacheCoupons(restaurantId, addressId, payload) {
  db.prepare(
    `INSERT INTO coupon_cache (restaurant_id, address_id, payload_json, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(restaurant_id) DO UPDATE SET
       address_id = excluded.address_id,
       payload_json = excluded.payload_json,
       fetched_at = excluded.fetched_at`
  ).run(restaurantId, addressId, JSON.stringify(payload), Date.now());
}

export function getCachedCoupons(restaurantId, addressId) {
  const row = db
    .prepare(`SELECT * FROM coupon_cache WHERE restaurant_id = ? AND address_id = ?`)
    .get(restaurantId, addressId);
  if (!row) return null;
  if (Date.now() - row.fetched_at > COUPON_CACHE_TTL_MS) return null;
  return JSON.parse(row.payload_json);
}

// --- Order history (log only, both domains) ---
export function recordOrder({ domain, orderId, summary }) {
  db.prepare(
    `INSERT INTO order_history (domain, order_id, summary_json, created_at)
     VALUES (?, ?, ?, datetime('now'))`
  ).run(domain, orderId ?? null, JSON.stringify(summary ?? null));
}
