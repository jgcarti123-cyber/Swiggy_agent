import { instamartClient } from "../mcp/instamartClient.js";
import { runToolLoop } from "./toolLoop.js";

// Tool calls that mutate the cart — after any of these fire during a turn,
// the live cart is re-fetched independently rather than trusting the
// model's own tool-call result or text summary.
const CART_TOUCHING_TOOLS = new Set(["update_cart", "checkout", "clear_cart"]);

// How many variant cards to show per screen (initial results + each "show
// more" page).
const VARIANTS_PER_PAGE = 6;

// The delivery addressId is resolved server-side (from the saved address the
// user picked in the UI) and injected into every tool call — the model never
// sees, asks for, or reasons about an address.
//
// Deliberately short: this agent no longer asks the model to decide whether
// to ask a clarifying question or present results — search_products always
// ends in one of those two outcomes, decided in code (see runSearchAndBranch)
// from the real result count, not model judgment. That cut the guided-search
// path from 2-3 Groq completions per turn down to 1 (or 0 for a brand
// follow-up / card click — see the *Direct functions below), which is what
// actually fixed the latency: measured completions were taking 20-40s+ each
// despite tiny outputs, consistent with Groq's free-tier per-minute token
// quota queuing as a session's cumulative usage climbs — fewer, smaller
// completions is the lever that matters, more than shrinking any one of them.
const SYSTEM_PROMPT = `You are Pantry Pal, a grocery assistant for Swiggy Instamart in a single-user dashboard. The delivery address is already set — never ask for it; it is added to every tool call automatically.

- To find or add a product, call search_products with the best search term for what the user described (e.g. "milk", "chocolate cookies", "amul milk"). The app automatically shows the user a brand choice or product cards right after your search — you never need to ask which brand or list results yourself, just search.
- For anything that isn't a fresh product search — removing an item, changing a quantity, clearing part of the cart, checking out — call get_cart first to see what's actually there, then update_cart with the full merged item list. You MUST actually call update_cart to make a change; never say you changed the cart without calling it.
- Never call checkout unless the user has explicitly confirmed in this chat. For Cash on Delivery, confirm first then paymentMethod="Cash"; for UPI, call get_payment_options first.
- Keep replies short — cards and the live cart render separately, don't restate them.`;

// Address parameters are intentionally omitted from these schemas: the server
// injects the addressId, so the model shouldn't spend tokens producing it or
// risk getting it wrong. ask_choice/present_products from the earlier design
// are gone entirely — see runSearchAndBranch.
const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "Search Instamart products for what the user wants. The result is shown to the user automatically (as a brand question or product cards) — just pick a good search term, nothing else to do after calling this.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product name, category, or brand" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cart",
      description: "Get the current Instamart cart with items and total.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "update_cart",
      description:
        "Replace the ENTIRE Instamart cart with the given items. Not additive — always get_cart first and include existing items you want to keep.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                spinId: { type: "string" },
                skuId: { type: "string" },
                quantity: { type: "number" },
              },
              required: ["spinId", "skuId", "quantity"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_cart",
      description: "Remove all items from the Instamart cart.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "your_go_to_items",
      description: "Get the user's frequently/recently ordered items — use only when they ask about their order history, not for a normal reorder request.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_payment_options",
      description: "Get live payment methods (UPI apps, Cash on Delivery) available for the current cart.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "checkout",
      description:
        "Place the Instamart order and confirm payment. Only call after explicit user confirmation of items and payment method.",
      parameters: {
        type: "object",
        properties: {
          paymentMethod: { type: "string", description: "\"UPI\", \"Cash\", or \"SwiggyPay\"" },
          intentApp: { type: "string", description: "UPI app id, only with paymentMethod=UPI" },
          generateUPIQR: { type: "boolean" },
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Product cache — the image side-channel. search_products returns imageUrl per
// variant, but images are stripped before the model sees results (tokens). So
// the full variant records are stashed here keyed by id, and product cards /
// the frontend join photos + price back by spinId. The model never handles
// image URLs.
// ---------------------------------------------------------------------------
const productBySpin = new Map();
const productBySku = new Map();

function cacheProducts(raw) {
  const products = Array.isArray(raw?.products) ? raw.products : [];
  if (productBySpin.size > 500) {
    productBySpin.clear();
    productBySku.clear();
  }
  for (const p of products) {
    const variations = Array.isArray(p.variations) ? p.variations : [];
    for (const v of variations) {
      if (!v.spinId) continue;
      const card = {
        spinId: String(v.spinId),
        skuId: v.skuId ? String(v.skuId) : null,
        displayName: v.displayName || p.displayName || "Item",
        brand: v.brandName || p.brand || null,
        quantityDescription: v.quantityDescription || null,
        mrp: v.price?.mrp ?? null,
        offerPrice: v.price?.offerPrice ?? v.price?.mrp ?? null,
        imageUrl: v.imageUrl || null,
        inStock: v.isInStockAndAvailable !== false,
      };
      productBySpin.set(card.spinId, card);
      if (card.skuId) productBySku.set(card.skuId, card);
    }
  }
}

// Only offer a brand as a choice if it has at least one in-stock variant —
// otherwise picking it leads straight to a screen of unbuyable, greyed-out
// items. Swiggy's search freely returns out-of-stock products mixed in.
function distinctBrands(raw) {
  const products = Array.isArray(raw?.products) ? raw.products : [];
  const seen = new Set();
  const brands = [];
  for (const p of products) {
    const hasInStock = (p.variations || []).some((v) => v.isInStockAndAvailable !== false);
    if (!hasInStock) continue;
    const b = p.brand || p.variations?.[0]?.brandName;
    if (b && !seen.has(b)) {
      seen.add(b);
      brands.push(b);
    }
  }
  return brands.slice(0, 8);
}

// Every variant across every product, in the order Swiggy's own search
// already returned them — used as-is rather than re-ranked, per the decision
// to trust Swiggy's relevance/popularity ordering instead of spending an
// LLM call to "judge" the same thing from just a name and a price. Brand is
// kept alongside each ref so a brand follow-up (see runSearchAndBranch) can
// filter to it — Swiggy's search stays fuzzy even for a brand-qualified
// query ("amul milk" still returns Chitale, Gokul, etc as loose matches), so
// re-checking brand count on those results would wrongly ask again.
// `goToIndex`, when passed, tags each variant with the user's own go-to-items
// rank (see §"most ordered" below) so sortVariants can promote it.
function flattenVariants(raw, goToIndex) {
  const products = Array.isArray(raw?.products) ? raw.products : [];
  const out = [];
  for (const p of products) {
    const brand = p.brand || p.variations?.[0]?.brandName || null;
    for (const v of p.variations || []) {
      if (!v.spinId) continue;
      const displayName = v.displayName || p.displayName || null;
      const rank = goToIndex ? goToRankFor(v, brand, displayName, goToIndex) : undefined;
      out.push({
        spinId: String(v.spinId),
        skuId: v.skuId ? String(v.skuId) : null,
        brand: v.brandName || brand,
        displayName,
        inStock: v.isInStockAndAvailable !== false,
        price: v.price?.offerPrice ?? v.price?.mrp ?? null,
        mostOrdered: rank !== undefined,
        orderRank: rank,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// "Most ordered by you" — cross-references live search/brand results against
// Swiggy's own your_go_to_items (already used for "Reorder my usuals"), so a
// broad request like "add a protein bar" can surface which specific product
// the user actually buys, instead of an undifferentiated list. Deliberately
// built on Swiggy's live data rather than a local order log: this app has no
// durable per-item order history of its own, and your_go_to_items already IS
// Swiggy's real "what does this user usually order" signal (verified live:
// same products[]/variations[] shape as search_products, §2.5). Position in
// that list is trusted as Swiggy's own frequency/recency
// ranking, the same trust-Swiggy's-ordering principle already applied to
// variant sort order — no local scoring reinvented.
// ---------------------------------------------------------------------------
const GO_TO_CACHE_TTL_MS = 5 * 60 * 1000;
let goToCache = null; // { addressId, fetchedAt, bySpinId: Map, byKey: Map } | null

function normalizeKey(brand, name) {
  return `${(brand || "").toLowerCase().trim()}::${(name || "").toLowerCase().trim()}`;
}

// Primary match is the exact spinId (same pack/size the user actually
// bought). Fallback is brand+name so a *different* pack size of a product
// they buy regularly (e.g. go-to is the 1L pack, search surfaces the 500ml)
// still counts — still an exact deterministic key match, not fuzzy text
// similarity.
function goToRankFor(variant, brand, displayName, goToIndex) {
  const bySpin = goToIndex.bySpinId.get(String(variant.spinId));
  if (bySpin !== undefined) return bySpin;
  return goToIndex.byKey.get(normalizeKey(brand, displayName));
}

async function getGoToIndex(addressId) {
  if (goToCache && goToCache.addressId === addressId && Date.now() - goToCache.fetchedAt < GO_TO_CACHE_TTL_MS) {
    return goToCache;
  }
  const bySpinId = new Map();
  const byKey = new Map();
  try {
    const raw = await instamartClient.yourGoToItems({ addressId });
    const products = Array.isArray(raw?.products) ? raw.products : [];
    let rank = 0;
    for (const p of products) {
      const brand = p.brand || p.variations?.[0]?.brandName || null;
      for (const v of p.variations || []) {
        if (!v.spinId) continue;
        bySpinId.set(String(v.spinId), rank);
        const key = normalizeKey(brand, v.displayName || p.displayName);
        if (!byKey.has(key)) byKey.set(key, rank);
        rank++;
      }
    }
  } catch {
    // Best-effort signal only — your_go_to_items failing (e.g. brand-new
    // account with no history yet) must never block a normal search.
  }
  goToCache = { addressId, fetchedAt: Date.now(), bySpinId, byKey };
  return goToCache;
}

// Called after a successful checkout so the very next search reflects the
// order just placed, instead of waiting out the TTL.
function invalidateGoToCache() {
  goToCache = null;
}

// Aggregates per-variant go-to rank up to brand level (best/lowest rank among
// any of that brand's variants in these results) so the brand-choice screen
// can surface the same signal as the product-card badge.
function brandGoToRanks(raw, goToIndex) {
  const products = Array.isArray(raw?.products) ? raw.products : [];
  const ranks = new Map();
  for (const p of products) {
    const brand = p.brand || p.variations?.[0]?.brandName;
    if (!brand) continue;
    for (const v of p.variations || []) {
      if (!v.spinId) continue;
      const r = goToRankFor(v, brand, v.displayName || p.displayName, goToIndex);
      if (r === undefined) continue;
      if (!ranks.has(brand) || r < ranks.get(brand)) ranks.set(brand, r);
    }
  }
  return ranks;
}

// ---------------------------------------------------------------------------
// Search relevance filter — Swiggy's search_products, like search_menu on the
// Food server (ARCHITECTURE.md §2.4), falls back to loosely/semantically
// related items rather than an empty list. Confirmed live: "chicken" surfaced
// "Too Yumm Protein Chips" (no literal relation at all) alongside genuine
// chicken products. Fixed with a deterministic keyword filter, not a second
// LLM judgment call (§6.3's 129s incident is exactly the cost that decision
// avoids) — a product survives only if one of the query's own significant
// words appears in its name or brand. This can't distinguish "chicken breast"
// from "chicken masala" (both literally contain "chicken") — accepted
// trade-off for zero added latency/cost; a semantic pass would need an LLM
// call per search.
// ---------------------------------------------------------------------------
const QUERY_STOPWORDS = new Set([
  "a", "an", "the", "of", "for", "with", "and", "or", "to", "in", "on",
  "my", "some", "please", "add", "buy", "order", "get", "me", "pack", "packet",
]);

function significantTokens(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !QUERY_STOPWORDS.has(t));
}

// Cheap plural/singular tolerance ("cookies" query still matches a "Cookie"
// product name) without pulling in a stemming library.
function tokenVariants(token) {
  return token.length > 3 && token.endsWith("s") ? [token, token.slice(0, -1)] : [token];
}

function filterRelevantProducts(raw, query) {
  const products = Array.isArray(raw?.products) ? raw.products : [];
  const tokens = significantTokens(query);
  if (tokens.length === 0) return raw;
  const relevant = products.filter((p) => {
    const haystack = `${p.displayName || ""} ${p.brand || ""}`.toLowerCase();
    return tokens.some((t) => tokenVariants(t).some((v) => haystack.includes(v)));
  });
  // If the filter would wipe out every result (Swiggy's match was purely
  // semantic, no literal word overlap at all), keep the unfiltered set rather
  // than reporting a false "nothing found" — same fallback principle already
  // used for forceBrand below when a brand name doesn't match anything exactly.
  return relevant.length > 0 ? { ...raw, products: relevant } : raw;
}

// Resolve variant refs back to full cards (with photo + price) from the
// cache. Unknown ids are dropped so a bad ref never renders. A ref flagged
// mostOrdered (see goToRankFor) gets the existing `note` field set — the UI
// already renders product.note as a small badge line (originally added for
// this kind of annotation), so no frontend change is needed.
function enrichProducts(refs) {
  const out = [];
  for (const r of refs || []) {
    const card = productBySpin.get(String(r.spinId)) || productBySku.get(String(r.skuId));
    if (!card) continue;
    out.push(r.mostOrdered ? { ...card, note: "(Most ordered by you)" } : card);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic search branching — the core latency/token fix. Runs the real
// Swiggy search, then decides ask-vs-show purely from the result shape (brand
// count), no LLM involved. Called both from the tool-loop (when the model
// calls search_products) and directly (the zero-LLM brand-follow-up path in
// sendMessage), so the two entry points always behave identically.
// ---------------------------------------------------------------------------
let pendingBrandChoice = null; // { originalQuery, brandsOffered: string[] } | null
let lastSearchContext = null; // { query, allVariants, shown } | null — for "show more"

// Shown as one more chip alongside real brand names when a search spans 2+
// brands, for items where the brand genuinely doesn't matter to the user.
// Checked by exact/near-exact text match (see isAnyBrandChoice), never by
// substring against real brand names, so it can't collide with one.
const ANY_BRAND_LABEL = "Any brand";

function isAnyBrandChoice(userText) {
  const t = userText.trim().toLowerCase();
  return t === "any brand" || t === "any" || t === "all" || t === "all brands";
}

// Most-ordered-by-you first (see goToRankFor — lower rank = higher
// preference in Swiggy's own your_go_to_items ordering), then in-stock first
// (established earlier: an out-of-stock item in the mix makes Swiggy reject
// the whole update_cart, so buyable items must lead), then price ascending
// within each group — the ordering requested for every results screen, not
// just when "Any brand" is picked.
function sortVariants(variants) {
  return [...variants].sort((a, b) => {
    const moDiff = (b.mostOrdered ? 1 : 0) - (a.mostOrdered ? 1 : 0);
    if (moDiff !== 0) return moDiff;
    if (a.mostOrdered && b.mostOrdered) {
      const rankDiff = (a.orderRank ?? 0) - (b.orderRank ?? 0);
      if (rankDiff !== 0) return rankDiff;
    }
    const stockDiff = (b.inStock ? 1 : 0) - (a.inStock ? 1 : 0);
    if (stockDiff !== 0) return stockDiff;
    const pa = a.price ?? Infinity;
    const pb = b.price ?? Infinity;
    return pa - pb;
  });
}

// `forceBrand`, when set, means the user already answered "which brand" —
// there is nothing left to ask, no matter how many other brands Swiggy's
// fuzzy search mixes into these particular results. Filter down to the
// confirmed brand and go straight to variants.
// `skipBrandAsk` means the user explicitly doesn't care which brand (picked
// "Any brand") — show everything found, mixed brands, sorted by price.
async function runSearchAndBranch(query, addressId, { forceBrand, skipBrandAsk } = {}) {
  const [rawSearch, goToIndex] = await Promise.all([
    instamartClient.searchProducts({ query, addressId }),
    getGoToIndex(addressId),
  ]);
  const raw = filterRelevantProducts(rawSearch, query);
  cacheProducts(raw);
  let variants = flattenVariants(raw, goToIndex);

  if (forceBrand) {
    const target = forceBrand.toLowerCase();
    const filtered = variants.filter((v) => (v.brand || "").toLowerCase() === target);
    // If nothing matched exactly (brand-name casing/variant mismatch), fall
    // back to the unfiltered set rather than reporting a false "not found".
    if (filtered.length > 0) variants = filtered;
  }

  variants = sortVariants(variants);

  if (variants.length === 0) {
    pendingBrandChoice = null;
    return { kind: "empty", payload: { query } };
  }

  if (!forceBrand && !skipBrandAsk) {
    const brands = distinctBrands(raw);
    if (brands.length >= 2) {
      // brandsOffered stays the CLEAN brand-name list — matchOfferedBrand and
      // forceBrand filtering above key off these exact strings. Only the
      // *displayed* option labels get the "(most ordered by you)" suffix; a
      // click still sends that full label back, and matchOfferedBrand's
      // substring check (below) still resolves it to the clean name.
      const ranks = brandGoToRanks(raw, goToIndex);
      const ranked = [...brands].sort((a, b) => (ranks.get(a) ?? Infinity) - (ranks.get(b) ?? Infinity));
      pendingBrandChoice = { originalQuery: query, brandsOffered: ranked };
      const options = ranked.map((b) => (ranks.has(b) ? `${b} (most ordered by you)` : b));
      return {
        kind: "choice",
        payload: { question: `Which brand of ${query} would you like?`, options: [...options, ANY_BRAND_LABEL] },
      };
    }
  }

  pendingBrandChoice = null;
  const shown = variants.slice(0, VARIANTS_PER_PAGE);
  lastSearchContext = { query, allVariants: variants, shown: shown.length };
  return {
    kind: "products",
    payload: { intro: `Here's what I found for "${query}":`, items: enrichProducts(shown) },
  };
}

function matchOfferedBrand(userText, brandsOffered) {
  const t = userText.trim().toLowerCase();
  if (!t) return null;
  for (const b of brandsOffered) if (b.toLowerCase() === t) return b;
  for (const b of brandsOffered) {
    const bl = b.toLowerCase();
    if (t.includes(bl) || bl.includes(t)) return b;
  }
  return null;
}

// A get_cart failure over ONE item's stock state can "poison" the cart
// permanently — every subsequent read (including the one every add/reorder
// below starts with) fails identically until the cart is cleared. Confirmed
// live: clear_cart succeeds even while get_cart is stuck this way, and reads
// work normally again immediately after. Surface that as a concrete next
// step rather than leaving the user staring at Swiggy's raw error text with
// no way to self-recover.
// Maps Swiggy's raw tool errors to a short, actionable phrase that completes
// the sentence "Couldn't add X — ...". Swiggy's own text is verbose (multi-line
// with report ids/support email) and, for some errors, not user-actionable.
// Notably, some fresh-meat items report as fully in-stock in search yet
// update_cart rejects them ("No valid items in cart" / "An error occurred") —
// confirmed unpredictable from the search data, so those just get a clean
// "not available, try another" rather than a raw dump.
function friendlyCartError(err) {
  const first = String(err.message || "").split("\n")[0].trim();
  if (/partially available/i.test(first)) {
    return `the cart may be stuck — tap "Clear cart" below to reset it, then try again.`;
  }
  if (/out of stock/i.test(first)) {
    return "it's out of stock right now — try another option.";
  }
  if (/no valid items|not serviceable|cannot be added|couldn'?t be added|an error occurred|unavailable/i.test(first)) {
    return "Swiggy isn't letting this one be added right now — try a different size or brand.";
  }
  return first || "something went wrong — try again.";
}

// ---------------------------------------------------------------------------
// Cart merge — shared by the deterministic direct-add/reorder actions below.
// update_cart replaces the whole cart, so always read the real current
// contents first and fold the new item(s) in by spinId+skuId.
// ---------------------------------------------------------------------------
async function mergeAndUpdateCart(addressId, newItems) {
  // The whole body is wrapped, not just updateCart: observed live, Swiggy's
  // get_cart itself can throw "Item quantity is partially available" (a
  // stock-validation check on the EXISTING cart, not something caused by
  // this call) — from the very first read below, before update_cart is even
  // reached. Whatever step fails, always attempt one more resync so the
  // caller reports the real cart state instead of a stale/null guess.
  try {
    const current = await instamartClient.getCartOrEmpty();
    const merged = new Map();
    for (const i of current.items || []) {
      merged.set(`${i.spinId}:${i.skuId}`, { spinId: i.spinId, skuId: i.skuId, quantity: i.quantity });
    }
    for (const ni of newItems) {
      const key = `${ni.spinId}:${ni.skuId}`;
      const existing = merged.get(key);
      merged.set(key, { spinId: ni.spinId, skuId: ni.skuId, quantity: (existing?.quantity || 0) + (ni.quantity || 1) });
    }
    await instamartClient.updateCart({ selectedAddressId: addressId, items: [...merged.values()] });
    return instamartClient.getCartOrEmpty();
  } catch (err) {
    err.cart = await instamartClient.getCartOrEmpty().catch(() => null);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Token control for the LLM tool-calling path (still used for free-text cart
// edits and "your go-to items" questions — the cases that genuinely need the
// model to read data and reason, unlike the deterministic paths above).
// ---------------------------------------------------------------------------
const HEAVY_KEY =
  /image|img|url|photo|thumb|icon|banner|desc|gif|video|media|analytics|tracking|widget|meta|badge|review|offer_?text|coupon/i;

function compactForModel(value, maxArray) {
  if (Array.isArray(value)) return value.slice(0, maxArray).map((v) => compactForModel(v, maxArray));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (HEAVY_KEY.test(k)) continue;
      out[k] = compactForModel(v, maxArray);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 300) return value.slice(0, 300) + "…";
  return value;
}

function compactSearchResult(raw) {
  let compacted = compactForModel(raw, 6);
  if (JSON.stringify(compacted).length > 6000) compacted = compactForModel(raw, 3);
  return compacted;
}

// get_cart/update_cart's raw response carries a lot the model never needs to
// reason about a cart edit — full delivery-address details, formatted bill
// line items, store ids. Confirmed live: this alone was ~500-2000+ chars of
// dead weight per call, re-sent on every subsequent completion in the turn.
function compactCartForModel(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    items: items.map((i) => ({
      spinId: i.spinId,
      skuId: i.skuId,
      itemName: i.itemName,
      quantity: i.quantity,
      price: i.discountedFinalPrice ?? i.mrp ?? null,
    })),
    total: raw.cartTotalAmount ?? raw.billBreakdown?.toPay?.value ?? null,
  };
}

// executeTool is built per-request as a closure over the resolved addressId,
// which it injects into every tool call.
function makeExecuteTool(addressId) {
  return async (name, args) => {
    switch (name) {
      case "search_products": {
        const { kind, payload } = await runSearchAndBranch(args.query, addressId);
        return { __endLoop: true, kind, payload };
      }
      case "your_go_to_items": {
        const raw = await instamartClient.yourGoToItems({ addressId });
        cacheProducts(raw);
        return compactSearchResult(raw);
      }
      case "get_cart":
        return compactCartForModel(await instamartClient.getCart());
      case "update_cart": {
        // update_cart rejects an empty items array (confirmed live) — if the
        // model is trying to empty the cart (e.g. "remove my only item"),
        // that has to go through clear_cart instead.
        if (!Array.isArray(args.items) || args.items.length === 0) {
          return compactCartForModel(await instamartClient.clearCart().then(() => instamartClient.getCartOrEmpty()));
        }
        return compactCartForModel(await instamartClient.updateCart({ selectedAddressId: addressId, items: args.items }));
      }
      case "clear_cart":
        return instamartClient.clearCart();
      case "get_payment_options":
        return instamartClient.getPaymentOptions({ addressId });
      case "checkout": {
        const result = await instamartClient.checkout({ ...args, addressId });
        // The order just placed should count toward "most ordered" on the
        // very next search, not after a stale cache TTL expires.
        invalidateGoToCache();
        return result;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Two transcripts: `conversation` is what the LLM sees (compact, tool-shaped,
// only touched by the LLM tool-loop path); `displayTranscript` is what the UI
// renders (rich choice/product messages), updated by every path including
// the zero-LLM deterministic ones.
// ---------------------------------------------------------------------------
let conversation = [{ role: "system", content: SYSTEM_PROMPT }];
let displayTranscript = [];

const MAX_USER_TURNS = 8;
function trimConversation() {
  const userIdx = [];
  for (let i = 1; i < conversation.length; i++) {
    if (conversation[i].role === "user") userIdx.push(i);
  }
  if (userIdx.length > MAX_USER_TURNS) {
    const cut = userIdx[userIdx.length - MAX_USER_TURNS];
    conversation = [conversation[0], ...conversation.slice(cut)];
  }
  if (displayTranscript.length > 40) displayTranscript = displayTranscript.slice(-40);
}

// Turns a branch outcome (kind + payload from runSearchAndBranch, or plain
// text with kind=null) into the UI transcript entry + API response shape —
// shared by every path (LLM-driven or deterministic) so they render
// identically regardless of how the answer was produced.
function buildFromBranch(kind, payload, text) {
  if (kind === "choice") {
    const { question, options } = payload;
    return {
      entry: { role: "assistant", type: "choice", question, options },
      responsePayload: { reply: "", choice: { question, options } },
    };
  }
  if (kind === "products") {
    const { intro, items } = payload;
    if (items && items.length > 0) {
      return {
        entry: { role: "assistant", type: "products", intro, products: items },
        responsePayload: { reply: "", products: { intro, items } },
      };
    }
    const fallback = "I couldn't pull those options up — mind trying again?";
    return { entry: { role: "assistant", text: fallback }, responsePayload: { reply: fallback } };
  }
  if (kind === "empty") {
    const reply = `Couldn't find anything for "${payload.query}" — want to try a different search?`;
    return { entry: { role: "assistant", text: reply }, responsePayload: { reply } };
  }
  const reply = text || "(no reply)";
  return { entry: { role: "assistant", text: reply }, responsePayload: { reply } };
}

// userText goes to the LLM; displayText is what the transcript shows the user.
export async function sendMessage(userText, addressId, displayText = userText) {
  displayTranscript.push({ role: "user", text: displayText });

  // Deterministic brand follow-up: the previous turn asked "which brand?"
  // with a real, closed set of options, so if this message names one of
  // them there is exactly one correct action — search narrowed to it. No
  // ambiguity to resolve, so no reason to spend a Groq call resolving it.
  if (pendingBrandChoice) {
    if (isAnyBrandChoice(userText)) {
      const { kind, payload } = await runSearchAndBranch(pendingBrandChoice.originalQuery, addressId, {
        skipBrandAsk: true,
      });
      const { entry, responsePayload } = buildFromBranch(kind, payload, "");
      displayTranscript.push(entry);
      trimConversation();
      return { ...responsePayload, cart: null };
    }
    const matched = matchOfferedBrand(userText, pendingBrandChoice.brandsOffered);
    if (matched) {
      const { kind, payload } = await runSearchAndBranch(`${matched} ${pendingBrandChoice.originalQuery}`, addressId, {
        forceBrand: matched,
      });
      const { entry, responsePayload } = buildFromBranch(kind, payload, "");
      displayTranscript.push(entry);
      trimConversation();
      return { ...responsePayload, cart: null };
    }
  }

  conversation.push({ role: "user", content: userText });

  const { text, finalArgs, finalToolName, executedTools } = await runToolLoop({
    messages: conversation,
    tools: TOOLS,
    executeTool: makeExecuteTool(addressId),
    maxTokens: 1024,
  });

  const { entry, responsePayload } = buildFromBranch(finalToolName, finalArgs, text);
  displayTranscript.push(entry);
  trimConversation();

  let liveCart = null;
  if (executedTools.some((t) => CART_TOUCHING_TOOLS.has(t.name))) {
    // Re-fetch server-side rather than trust the model's own tool result.
    // An empty cart comes back as { items: [] }, not an error.
    try {
      liveCart = await instamartClient.getCartOrEmpty();
    } catch (err) {
      liveCart = { error: err.message };
    }
  }

  return { ...responsePayload, cart: liveCart };
}

// ---------------------------------------------------------------------------
// Deterministic direct actions — no Groq call at all. These back the UI
// affordances that only ever have one correct outcome once you know the
// input: clicking Add on a specific card, "show more", "reorder my usuals",
// "clear cart". Previously these went through the full chat loop (get_cart +
// update_cart + a reply completion — measured 3 Groq calls / ~100s for a
// single card click); now they're a couple of MCP network calls, typically
// under 2 seconds.
// ---------------------------------------------------------------------------
export async function addItemDirect({ spinId, skuId, quantity = 1, addressId, displayText }) {
  displayTranscript.push({ role: "user", text: displayText });
  const card = productBySpin.get(String(spinId)) || productBySku.get(String(skuId));
  const name = card?.displayName || "the item";
  let reply;
  let cart = null;

  // Refuse out-of-stock items up front. Swiggy rejects update_cart wholesale
  // if any item is out of stock ("All items in your cart are currently out of
  // stock"), which would also risk leaving the cart in a bad state — so never
  // even attempt it. The UI already marks these, but the button click is
  // guarded here too as the source of truth.
  if (card && card.inStock === false) {
    reply = `${name} is out of stock right now — pick another option.`;
    displayTranscript.push({ role: "assistant", text: reply });
    trimConversation();
    return { reply, cart: null };
  }

  try {
    cart = await mergeAndUpdateCart(addressId, [{ spinId, skuId, quantity }]);
    reply = `Added ${name} to your cart ✓`;
  } catch (err) {
    reply = `Couldn't add ${name} — ${friendlyCartError(err)}`;
    cart = err.cart ?? null;
  }
  displayTranscript.push({ role: "assistant", text: reply });
  trimConversation();
  return { reply, cart };
}

export async function showMoreDirect({ addressId, displayText = "Show more options" }) {
  displayTranscript.push({ role: "user", text: displayText });
  let entry;
  let responsePayload;

  if (!lastSearchContext || lastSearchContext.shown >= lastSearchContext.allVariants.length) {
    const reply = lastSearchContext
      ? `That's everything I found for "${lastSearchContext.query}".`
      : "Search for something first and I can show more once there's more to see.";
    entry = { role: "assistant", text: reply };
    responsePayload = { reply };
  } else {
    const next = lastSearchContext.allVariants.slice(
      lastSearchContext.shown,
      lastSearchContext.shown + VARIANTS_PER_PAGE
    );
    lastSearchContext.shown += next.length;
    const items = enrichProducts(next);
    const intro = "A few more options:";
    entry = { role: "assistant", type: "products", intro, products: items };
    responsePayload = { reply: "", products: { intro, items } };
  }

  displayTranscript.push(entry);
  trimConversation();
  return { ...responsePayload, cart: null };
}

export async function clearCartDirect({ addressId, displayText = "Clear my cart" }) {
  displayTranscript.push({ role: "user", text: displayText });
  let reply;
  let cart = null;
  try {
    await instamartClient.clearCart();
    cart = await instamartClient.getCartOrEmpty();
    reply = "Your cart is now empty.";
  } catch (err) {
    reply = `Couldn't clear the cart — ${String(err.message || "").split("\n")[0]}`;
  }
  displayTranscript.push({ role: "assistant", text: reply });
  trimConversation();
  return { reply, cart };
}

export async function reorderUsualsDirect({ addressId, displayText = "Reorder my usual items" }) {
  displayTranscript.push({ role: "user", text: displayText });
  let reply;
  let cart = null;
  try {
    const raw = await instamartClient.yourGoToItems({ addressId });
    cacheProducts(raw);
    // Only reorder in-stock items — including an out-of-stock one would make
    // Swiggy reject the whole update_cart (see addItemDirect).
    const variants = flattenVariants(raw)
      .filter((v) => v.inStock !== false)
      .slice(0, 8);
    if (variants.length === 0) {
      reply = "None of your usual items are in stock right now — try again later.";
    } else {
      cart = await mergeAndUpdateCart(
        addressId,
        variants.map((v) => ({ ...v, quantity: 1 }))
      );
      reply = `Added ${variants.length} of your usual items to your cart ✓`;
    }
  } catch (err) {
    reply = `Couldn't reorder your usuals — ${friendlyCartError(err)}`;
    cart = err.cart ?? null;
  }
  displayTranscript.push({ role: "assistant", text: reply });
  trimConversation();
  return { reply, cart };
}

// Cart quantity stepper (+/- on a cart line item). Unlike the other direct
// actions above, this deliberately does NOT push a displayTranscript entry —
// it's a plain cart-state mutation, not a chat event, matching how every
// real e-commerce cart stepper behaves (clicking + a few times shouldn't
// spam the conversation log). quantity <= 0 removes the item entirely.
export async function setItemQuantity({ addressId, spinId, skuId, quantity }) {
  try {
    const current = await instamartClient.getCartOrEmpty();
    const items = (current.items || [])
      .filter((i) => !(String(i.spinId) === String(spinId) && String(i.skuId) === String(skuId)))
      .map((i) => ({ spinId: i.spinId, skuId: i.skuId, quantity: i.quantity }));
    if (quantity > 0) items.push({ spinId, skuId, quantity });
    if (items.length === 0) {
      // update_cart rejects an empty items array ("items array is required
      // and must contain at least one item", confirmed live) — removing the
      // very last item in the cart has to go through clear_cart instead.
      await instamartClient.clearCart();
    } else {
      await instamartClient.updateCart({ selectedAddressId: addressId, items });
    }
    const cart = await instamartClient.getCartOrEmpty();
    return { cart };
  } catch (err) {
    const cart = await instamartClient.getCartOrEmpty().catch(() => null);
    return { cart, error: friendlyCartError(err) };
  }
}

export function resetConversation() {
  conversation = [{ role: "system", content: SYSTEM_PROMPT }];
  displayTranscript = [];
  pendingBrandChoice = null;
  lastSearchContext = null;
}

export function getConversationForDisplay() {
  return displayTranscript;
}
