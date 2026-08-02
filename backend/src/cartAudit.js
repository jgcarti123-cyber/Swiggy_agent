import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Cart audit trail — a temporary diagnostic, off unless CART_AUDIT=1.
//
// The cart bug ("the item I added disappears", "the cart won't clear") has now
// survived two rounds of fixes that each addressed a REAL, separately-proven
// defect. That pattern — a fix that is demonstrably correct yet doesn't make
// the symptom go away — usually means the symptom has more than one cause, and
// arguing about which one from the code alone has stopped being productive.
//
// So: record what actually happens, in order, with timestamps, on the real
// account. Every HTTP request to /api/instamart gets an id; every Swiggy cart
// tool call made while serving it is logged under that id with its arguments
// and its result; and the browser posts what it actually RENDERED, so a
// "the panel flipped" report can be tied to the exact response that caused it.
//
// One JSONL file, `backend/data/cart-audit.log`, safe to hand over whole:
// deliberately no OAuth token, no address block, no phone number — only cart
// item ids, names and quantities.
// ---------------------------------------------------------------------------

export const auditEnabled = process.env.CART_AUDIT === "1";

const LOG_PATH = resolve(process.cwd(), "data", "cart-audit.log");
const store = new AsyncLocalStorage();
let seq = 0;

function write(record) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(record) + "\n");
  } catch {
    // A diagnostic must never be able to break the app it's diagnosing.
  }
}

// Summarise a cart to the few fields that matter here. Never log the raw
// response: it carries the full delivery address and phone number.
export function summarizeCart(cart) {
  if (!cart || typeof cart !== "object") return null;
  const items = Array.isArray(cart.items) ? cart.items : [];
  return {
    cartId: cart.cartId ?? null,
    addressId: cart.selectedAddress ?? null,
    total: cart.cartTotalAmount ?? null,
    items: items.map((i) => ({ spinId: i.spinId, skuId: i.skuId, name: i.itemName, qty: i.quantity })),
  };
}

export function logEvent(type, data) {
  if (!auditEnabled) return;
  write({ t: new Date().toISOString(), ms: Date.now(), req: store.getStore()?.id ?? null, type, ...data });
}

// Wrap one HTTP request so every Swiggy call it triggers shares its id.
export function runWithRequest(label, fn) {
  if (!auditEnabled) return fn();
  const id = `r${++seq}`;
  return store.run({ id, label }, fn);
}

export function currentRequestId() {
  return store.getStore()?.id ?? null;
}

// Express middleware: one line in, one line out, per /api/instamart request.
export function cartAuditMiddleware(req, res, next) {
  if (!auditEnabled) return next();
  const started = Date.now();
  runWithRequest(`${req.method} ${req.path}`, () => {
    logEvent("http:start", { method: req.method, path: req.path, body: safeBody(req.body) });
    res.on("finish", () => {
      logEvent("http:finish", { method: req.method, path: req.path, status: res.statusCode, durMs: Date.now() - started });
    });
    next();
  });
}

// Request bodies here are small and non-sensitive (ids and quantities), but an
// import posts a multi-MB base64 image — never let that into the log.
function safeBody(body) {
  if (!body || typeof body !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string" && v.length > 200) out[k] = `<${v.length} chars omitted>`;
    else out[k] = v;
  }
  return out;
}
