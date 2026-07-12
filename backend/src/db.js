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

  -- Local, user-editable "usuals" list for Pantry Pal. Deliberately NOT
  -- Swiggy's your_go_to_items (that tool is read-only — there's no Swiggy API
  -- to edit it), so the app keeps its own list here. Starts empty; the user
  -- builds it by saving items found in chat. UNIQUE(spin_id, sku_id) makes a
  -- re-save of the same variant idempotent.
  CREATE TABLE IF NOT EXISTS usuals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spin_id TEXT NOT NULL,
    sku_id TEXT,
    name TEXT,
    brand TEXT,
    quantity_description TEXT,
    mrp REAL,
    offer_price REAL,
    image_url TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(spin_id, sku_id)
  );

  -- Single-row config for the daily auto-add-usuals-to-cart schedule.
  -- last_run_date + last_status let the scheduler fire at most once per day
  -- and let the UI show a notice when a run was skipped (token expired /
  -- backend was down past the grace window).
  CREATE TABLE IF NOT EXISTS usuals_schedule (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    time TEXT,
    last_run_date TEXT,
    last_status TEXT,
    last_status_at TEXT,
    updated_at TEXT NOT NULL
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

// --- Usuals (local, user-editable Pantry Pal list) ---
function rowToUsual(row) {
  return {
    spinId: row.spin_id,
    skuId: row.sku_id,
    displayName: row.name,
    brand: row.brand,
    quantityDescription: row.quantity_description,
    mrp: row.mrp,
    offerPrice: row.offer_price,
    imageUrl: row.image_url,
    quantity: row.quantity,
  };
}

export function listUsuals() {
  return db.prepare(`SELECT * FROM usuals ORDER BY created_at ASC, id ASC`).all().map(rowToUsual);
}

// Idempotent add: re-saving the same variant updates its details instead of
// inserting a duplicate (UNIQUE(spin_id, sku_id) + upsert).
export function addUsual(item) {
  db.prepare(
    `INSERT INTO usuals (spin_id, sku_id, name, brand, quantity_description, mrp, offer_price, image_url, quantity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(spin_id, sku_id) DO UPDATE SET
       name = excluded.name,
       brand = excluded.brand,
       quantity_description = excluded.quantity_description,
       mrp = excluded.mrp,
       offer_price = excluded.offer_price,
       image_url = excluded.image_url`
  ).run(
    String(item.spinId),
    item.skuId != null ? String(item.skuId) : null,
    item.displayName ?? null,
    item.brand ?? null,
    item.quantityDescription ?? null,
    item.mrp ?? null,
    item.offerPrice ?? null,
    item.imageUrl ?? null,
    item.quantity ?? 1
  );
  return listUsuals();
}

export function removeUsual(spinId, skuId) {
  if (skuId != null) {
    db.prepare(`DELETE FROM usuals WHERE spin_id = ? AND sku_id = ?`).run(String(spinId), String(skuId));
  } else {
    db.prepare(`DELETE FROM usuals WHERE spin_id = ?`).run(String(spinId));
  }
  return listUsuals();
}

// --- Usuals daily auto-add schedule (single row) ---
export function getUsualsSchedule() {
  const row = db.prepare(`SELECT * FROM usuals_schedule WHERE id = 1`).get();
  if (!row) {
    return { enabled: false, time: null, lastRunDate: null, lastStatus: null, lastStatusAt: null };
  }
  return {
    enabled: !!row.enabled,
    time: row.time,
    lastRunDate: row.last_run_date,
    lastStatus: row.last_status,
    lastStatusAt: row.last_status_at,
  };
}

export function setUsualsSchedule({ enabled, time }) {
  db.prepare(
    `INSERT INTO usuals_schedule (id, enabled, time, updated_at)
     VALUES (1, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       time = excluded.time,
       updated_at = excluded.updated_at`
  ).run(enabled ? 1 : 0, time ?? null);
  return getUsualsSchedule();
}

// When a schedule is (re)saved, prime today's run-marker so the new time
// takes effect from its NEXT occurrence rather than retroactively:
//  - if the chosen time already passed today, stamp today as handled with a
//    benign "scheduled" status (the scheduler skips a day already marked, and
//    the UI treats an unknown status as no-notice) → starts tomorrow;
//  - if the chosen time is still ahead today, clear the marker so it can fire
//    later today.
export function markScheduleScheduled(date) {
  db.prepare(
    `UPDATE usuals_schedule SET last_run_date = ?, last_status = 'scheduled', last_status_at = datetime('now') WHERE id = 1`
  ).run(date);
}

export function clearScheduleMarker() {
  db.prepare(
    `UPDATE usuals_schedule SET last_run_date = NULL, last_status = NULL, last_status_at = NULL WHERE id = 1`
  ).run();
}

// Records the outcome of a scheduled run (or a deliberately-flagged miss) so
// the next tick won't re-fire today and the UI can surface a skip notice.
export function recordScheduleRun({ date, status }) {
  db.prepare(
    `INSERT INTO usuals_schedule (id, enabled, time, last_run_date, last_status, last_status_at, updated_at)
     VALUES (1, COALESCE((SELECT enabled FROM usuals_schedule WHERE id = 1), 0),
                (SELECT time FROM usuals_schedule WHERE id = 1), ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       last_run_date = excluded.last_run_date,
       last_status = excluded.last_status,
       last_status_at = excluded.last_status_at,
       updated_at = excluded.updated_at`
  ).run(date, status);
}
