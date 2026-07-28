import { instamartClient } from "../mcp/instamartClient.js";
import { runToolLoop } from "./toolLoop.js";
import { NeedsReauthError } from "../auth/oauthClient.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { extractItemsFromImage } from "./imageImport.js";
import { searchWeb } from "./webSearch.js";
import { createCompletionWithRetry } from "./groqClient.js";
import { config } from "../config.js";
import {
  listUsuals as dbListUsuals,
  addUsual as dbAddUsual,
  removeUsual as dbRemoveUsual,
} from "../db.js";

// Tool calls that mutate the cart — after any of these fire during a turn,
// the live cart is re-fetched independently rather than trusting the
// model's own tool-call result or text summary.
const CART_TOUCHING_TOOLS = new Set(["update_cart", "checkout", "clear_cart"]);

// How many variant cards to show per screen (initial results + each "show
// more" page). The card grid is auto-fill (frontend/src/index.css), so on
// the chat column's usual width this renders as two full rows of 4 rather
// than 6 with an empty gap.
const VARIANTS_PER_PAGE = 8;

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
const SYSTEM_PROMPT = `You are Insta-nt, a grocery assistant for Swiggy Instamart in a single-user dashboard. The delivery address is already set — never ask for it; it is added to every tool call automatically.

- SCOPE — this is a hard rule. You help the user SHOP on Swiggy Instamart, which is a general quick-commerce store: groceries and fresh produce, but ALSO household supplies, personal & baby care, apparel and innerwear (underwear, socks, vests…), stationery, electronics/accessories, pet supplies, and more. If it's a product someone could plausibly buy on Instamart, treat it as in scope and search for it — do NOT refuse it just because it isn't food. What you must NOT do is answer questions unrelated to shopping: general knowledge, trivia, capitals, math, coding, translation, current events, chit-chat, advice, or any other topic — do NOT answer those even if you know the answer. For an off-topic (non-shopping) request, reply with exactly one short sentence redirecting them (e.g. "I can only help you shop on Instamart — try \\"add milk\\" or \\"order things for biryani\\".") and nothing else. Never call a tool for an off-topic request.
- To find or add a product, call search_products with the best search term for what the user described (e.g. "milk", "chocolate cookies", "amul milk"). If they state a pack size or weight (e.g. "100g paneer", "1kg rice", "2 pieces chicken"), keep it in the query exactly as they said it — the app uses it to filter results to that exact size. The app automatically shows the user a brand choice or product cards right after your search — you never need to ask which brand or list results yourself, just search.
- For anything that isn't a fresh product search — removing an item, changing a quantity, clearing part of the cart, checking out — call get_cart first to see what's actually there, then update_cart with the full merged item list. You MUST actually call update_cart to make a change; never say you changed the cart without calling it.
- Never call checkout unless the user has explicitly confirmed in this chat. For Cash on Delivery, confirm first then paymentMethod="Cash"; for UPI, call get_payment_options first.
- The user has a personal "usuals" list (a saved reorder list). To LIST it, call get_usuals. To REMOVE something from it, call remove_from_usuals with the item name. To ADD something to it, just search_products for the item — every product card has a star (☆) the user taps to save it, so you don't add to usuals yourself; find the item and let them save it.
- If the user asks for everything needed to MAKE or COOK a dish/meal ("order things for biryani", "I want to make pasta"), call propose_ingredients with the dish name and its essential ingredient list. Each ingredient must be a short, generic Instamart search term (e.g. "basmati rice", "curd", "mint leaves") — no brands, no quantities, no steps. Keep it minimal: only what the dish genuinely needs. Use the COMMON INDIAN GROCERY NAME for each staple, because that's what an Indian quick-commerce catalogue stocks: "curd" (NOT "yogurt" — that surfaces sweetened Greek/flavoured tubs), "coriander leaves" (NOT "cilantro"), "capsicum" (NOT "bell pepper"), "paneer" (NOT "cottage cheese"), "chana"/"rajma" for the pulse rather than "garbanzo"/"kidney bean marketing names", "curd chilli"/"green chilli" (NOT "jalapeño"). The app shows the user the list to edit and confirm — do not search for the items yourself.
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
          query: {
            type: "string",
            description: "Product name, category, or brand — include a stated pack size/weight verbatim (e.g. \"100g paneer\")",
          },
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
      name: "propose_ingredients",
      description:
        "When the user wants to order everything needed to make/cook a dish or meal, propose its essential ingredient list. The app shows the list to the user for editing and confirmation — you generate the list, nothing else.",
      parameters: {
        type: "object",
        properties: {
          dish: { type: "string", description: "The dish/meal name, e.g. \"biryani\"" },
          ingredients: {
            type: "array",
            items: { type: "string" },
            description:
              "Essential ingredients as short generic grocery search terms (no brands/quantities), e.g. [\"basmati rice\", \"chicken\", \"curd\", \"fried onions\", \"mint leaves\", \"biryani masala\", \"ghee\"]",
          },
        },
        required: ["dish", "ingredients"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_usuals",
      description: "List the items on the user's saved 'usuals' list (their personal reorder list).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_from_usuals",
      description:
        "Remove one item from the user's saved 'usuals' list, matched by name. Pass the item's name or a distinctive word from it.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Name (or part of it) of the usual to remove" } },
        required: ["name"],
      },
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

// Swiggy's search flags a variant `isInStockAndAvailable: true` while its own
// cart step rejects it moments later — confirmed live, unpredictable from the
// search response alone (see friendlyCartError). There's no way to know this
// in advance, but once a REAL add attempt has proven a spinId can't actually
// be added, that's learned for the rest of the process's life: every later
// re-cache of this product (a new search, "show more") is forced back to
// out-of-stock here even if Swiggy's search still claims otherwise, so the
// user is never invited to retry a dead end. Reset only by a backend restart.
const knownOutOfStockIds = new Set();

// One web search per spinId, reused across every question asked about that
// item in the "Explain" popup — searching fresh per question would be both
// slower and unnecessary, since the underlying product doesn't change
// mid-conversation. `null` is cached too (search failed/unavailable) so a
// failed search isn't retried on every follow-up question either. Reset only
// by a backend restart, same lifetime as the other item-keyed caches here.
const itemSearchCache = new Map();

function isKnownOutOfStock(spinId) {
  return spinId != null && knownOutOfStockIds.has(String(spinId));
}

// Called after a real add attempt fails for a reason attributable to THIS
// item (see isItemUnavailableError) — not for cart-level problems like a
// stuck cart, which aren't this item's fault. Mutates the cached card object
// in place: enrichProducts hands out this same object reference (not a copy)
// to every past and future "products" transcript entry that resolves this
// spinId, so this single write also retroactively corrects any already-
// rendered history (e.g. what /chat/history returns after a reload).
function markSpinOutOfStock(spinId) {
  if (!spinId) return;
  const key = String(spinId);
  knownOutOfStockIds.add(key);
  const card = productBySpin.get(key) || productBySku.get(key);
  if (card) card.inStock = false;
}

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
        inStock: v.isInStockAndAvailable !== false && !isKnownOutOfStock(v.spinId),
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
    const hasInStock = (p.variations || []).some(
      (v) => v.isInStockAndAvailable !== false && !isKnownOutOfStock(v.spinId)
    );
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
        inStock: v.isInStockAndAvailable !== false && !isKnownOutOfStock(v.spinId),
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
// Cheap plural→singular folding so "tomatoes" matches a "Tomato" product and
// "cookies" matches "Cookie". The old version only stripped a trailing "s"
// ("tomatoes"→"tomatoe"), which never matched "tomato" — that's exactly why a
// "tomatoes" search fell through the relevance filter entirely and auto-added
// a carrot. Now also strip a trailing "es".
function tokenVariants(token) {
  const out = [token];
  if (token.length > 4 && token.endsWith("es")) out.push(token.slice(0, -2)); // tomatoes→tomato, boxes→box
  if (token.length > 3 && token.endsWith("s")) out.push(token.slice(0, -1)); // cookies→cookie, leaves→leave
  return out;
}

// A search whose literal matches are only a tiny slice of Swiggy's results is
// the signature of a category/synonym query our keyword filter can't handle —
// "underwear" returns 20 real products (Pepe, Jockey, XYXX…) but only 1
// literally contains the word "underwear" (a DaMENSCH pack), because the rest
// are named "trunk"/"brief"/"boxer". Filtering to that 1 literal match drops
// 19 genuinely relevant products. Below this fraction, trust Swiggy's own
// relevance instead — confirmed live this is the underwear-vs-underpants gap
// (underpants had 0 literal matches, tripped the existing all-or-nothing
// valve, and correctly showed everything). Food noise is unaffected: for
// "chicken", most results literally contain "chicken" (well above this
// threshold), so "Too Yumm Protein Chips"-class noise is still filtered out.
const RELEVANCE_MIN_FRACTION = 0.25;

function filterRelevantProducts(raw, query) {
  const products = Array.isArray(raw?.products) ? raw.products : [];
  const tokens = significantTokens(query);
  if (tokens.length === 0) return raw;
  const relevant = products.filter((p) => {
    const haystack = `${p.displayName || ""} ${p.brand || ""}`.toLowerCase();
    return tokens.some((t) => tokenVariants(t).some((v) => haystack.includes(v)));
  });
  // Keep the unfiltered set when either (a) nothing matched at all (Swiggy's
  // match was purely semantic — same don't-report-a-false-empty principle used
  // for forceBrand below), or (b) only a tiny fraction matched, which means the
  // keyword filter is over-pruning a category/synonym search (see above).
  if (relevant.length === 0) return raw;
  if (products.length >= 8 && relevant.length / products.length < RELEVANCE_MIN_FRACTION) return raw;
  return { ...raw, products: relevant };
}

// ---------------------------------------------------------------------------
// Requested-quantity filter — "add 100g of paneer" should only show 100 g
// packs, not every pack size Swiggy returns for "paneer". Parsed straight
// from the query text (no extra LLM call — SYSTEM_PROMPT tells the model to
// keep a stated weight/quantity verbatim in the search query) and matched
// against each variant's own quantityDescription ("100 g", "1 kg", "4
// Pieces", "65 g x 2" — the last parsed as its per-pack size, ignoring the
// "x 2" multiplier: "100g" most naturally means the pack the user sees, not
// a multipack's total).
// ---------------------------------------------------------------------------
const QUANTITY_PATTERN =
  /(\d+(?:\.\d+)?)\s*(kilograms?|kgs?|grams?|milliliters?|litres?|liters?|pieces?|pcs?|dozen|g|ml|l)\b/i;

function canonicalUnit(raw) {
  const u = raw.toLowerCase();
  if (/^(kilograms?|kgs?)$/.test(u)) return "kg";
  if (/^(grams?|g)$/.test(u)) return "g";
  if (/^(milliliters?|ml)$/.test(u)) return "ml";
  if (/^(litres?|liters?|l)$/.test(u)) return "l";
  if (/^(pieces?|pcs?)$/.test(u)) return "piece";
  if (u === "dozen") return "dozen";
  return null;
}

function toBaseQuantity(amount, unit) {
  switch (unit) {
    case "g": return { family: "weight", value: amount };
    case "kg": return { family: "weight", value: amount * 1000 };
    case "ml": return { family: "volume", value: amount };
    case "l": return { family: "volume", value: amount * 1000 };
    case "piece": return { family: "count", value: amount };
    case "dozen": return { family: "count", value: amount * 12 };
    default: return null;
  }
}

// Used both on the user's query ("100g paneer") and on a variant's own
// quantityDescription ("100 g") — same parser, so the two are guaranteed to
// compare on the same terms.
function parseQuantityFrom(text) {
  const m = String(text || "").match(QUANTITY_PATTERN);
  if (!m) return null;
  const unit = canonicalUnit(m[2]);
  if (!unit) return null;
  return toBaseQuantity(parseFloat(m[1]), unit);
}

function quantityMatches(requested, variantDesc) {
  const actual = parseQuantityFrom(variantDesc);
  if (!actual) return false; // can't confirm a match — exclude rather than guess
  return actual.family === requested.family && Math.abs(actual.value - requested.value) < 0.001;
}

function formatQty(q) {
  if (q.family === "weight") return q.value >= 1000 ? `${q.value / 1000} kg` : `${q.value} g`;
  if (q.family === "volume") return q.value >= 1000 ? `${q.value / 1000} l` : `${q.value} ml`;
  return `${q.value} pc${q.value === 1 ? "" : "s"}`;
}

// Narrows the raw product list to variants whose own pack size matches what
// was requested. If nothing at that size exists, falls back to the
// unfiltered set (same don't-report-a-false-empty principle as
// filterRelevantProducts above and forceBrand below) — sizeMatchedAny tells
// the caller whether to prepend a "couldn't find that exact size" notice.
function filterByRequestedQuantity(raw, requested) {
  if (!requested) return { raw, sizeMatchedAny: true };
  const products = Array.isArray(raw?.products) ? raw.products : [];
  const filtered = [];
  for (const p of products) {
    const keep = (p.variations || []).filter((v) => quantityMatches(requested, v.quantityDescription));
    if (keep.length > 0) filtered.push({ ...p, variations: keep });
  }
  if (filtered.length === 0) return { raw, sizeMatchedAny: false };
  return { raw: { ...raw, products: filtered }, sizeMatchedAny: true };
}

// ---------------------------------------------------------------------------
// Clothing-size filter — "show me only size L underpants" should show only L,
// not every size Swiggy returns. Separate from the weight/volume/count filter
// above because a clothing size is a different dimension: Swiggy encodes it in
// the SAME quantityDescription field as a suffix after the count ("1 L" = one,
// size Large; "2 XL" = two, size XL; "1 M x 2" = size M multipack). The "L"
// here is Large, NOT litre — so this only activates on a clear apparel/size
// signal (the word "size", a full size word, an unambiguous XS/XL/XXL token,
// or an apparel category word), never on a bare "1 L" volume (which the
// quantity parser already owns because it has a leading number+unit).
// ---------------------------------------------------------------------------
const SIZE_WORDS = { "extra small": "XS", small: "S", medium: "M", large: "L", "extra large": "XL", "double xl": "XXL" };
const APPAREL_WORDS =
  /\b(underwear|underpants|undies|trunk|trunks|brief|briefs|boxer|boxers|vest|banian|banyan|shirt|t-?shirt|tshirt|jean|jeans|trouser|trousers|pant|pants|sock|socks|innerwear|nightwear|lingerie|bra|panty|panties|kurta|legging|leggings|pyjama|pajama)\b/i;
// Capture groups, in priority order: full-word sizes, a letter after "size:",
// a bare unambiguous XS/XL/XXL(X), a letter before "size", or a lone S/M/L
// letter. The lone-letter branch (m[5]) is the loosest — it's only trusted
// when the apparel/size gate in parseSizeFrom passes, so "L underpants" (lone
// L + apparel) resolves but "add l" or "1 l milk" don't.
const SIZE_QUERY_PATTERN =
  /\b(extra small|extra large|double xl|small|medium|large)\b|\bsize[:\s-]+(xxxl|xxl|xl|xs|[sml])\b|\b(xxxl|xxl|xl|xs)\b|\b([sml])\s*size\b|\b([sml])\b/i;

// The size token trailing a variant's quantityDescription: "1 L" -> L,
// "2 XL" -> XL, "1 M x 2" -> M. Anchored right after the leading count so a
// volume like "500 ml" (unit, not a size) can't be read as a size.
const VARIANT_SIZE_PATTERN = /^\s*\d+\s*(XXXL|XXL|XL|XS|[SML])\b/i;

// Parse a requested clothing size out of the query, but only when there's a
// clear apparel/size signal — otherwise return null and let the weight/volume
// path (or no filter) handle it.
function parseSizeFrom(query) {
  const t = String(query || "").toLowerCase();
  const m = t.match(SIZE_QUERY_PATTERN);
  if (!m) return null;
  const wordMatch = m[1] && SIZE_WORDS[m[1]];
  const token = (wordMatch || m[2] || m[3] || m[4] || m[5] || "").toUpperCase();
  if (!token) return null;
  // A single-letter size (S/M/L) is only trusted when the query has the word
  // "size" or a clear apparel word — otherwise "1 l milk" / "small onions" /
  // "large pizza" would be misread as garment sizes. XS/XL/XXL and full size
  // words are unambiguous on their own.
  const unambiguous = token.length >= 2 || /\bsize\b/.test(t) || APPAREL_WORDS.test(t);
  return unambiguous ? token : null;
}

function variantSize(desc) {
  const m = String(desc || "").match(VARIANT_SIZE_PATTERN);
  return m ? m[1].toUpperCase() : null;
}

// Same shape/contract as filterByRequestedQuantity: narrow to the requested
// size, or fall back to everything with sizeMatchedAny=false so the caller can
// prepend a "couldn't find that size" notice.
function filterByRequestedSize(raw, size) {
  if (!size) return { raw, sizeMatchedAny: true };
  const products = Array.isArray(raw?.products) ? raw.products : [];
  const filtered = [];
  for (const p of products) {
    const keep = (p.variations || []).filter((v) => variantSize(v.quantityDescription) === size);
    if (keep.length > 0) filtered.push({ ...p, variations: keep });
  }
  if (filtered.length === 0) return { raw, sizeMatchedAny: false };
  return { raw: { ...raw, products: filtered }, sizeMatchedAny: true };
}

// Fuzzy-match a free-text name from the chat agent ("amul milk", "the bread")
// against the local usuals list. Token-overlap, not contiguous substring — so
// "amul milk" still matches "Amul Taaza Milky Milk" — picking the usual that
// shares the most query words (across name + brand), ties broken by list
// order. Reuses the same tokenizer as the search relevance filter above.
function matchUsualByName(name, usuals) {
  const tokens = significantTokens(name);
  if (tokens.length === 0 || usuals.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const u of usuals) {
    const hay = `${u.displayName || ""} ${u.brand || ""}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (tokenVariants(t).some((v) => hay.includes(v))) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = u;
    }
  }
  return bestScore > 0 ? best : null;
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

// Used only for "pick the single best option" scenarios (recipe/import
// auto-add + top-3 alternatives) — deliberately NOT the guided browse/choose
// picker above, which sorts cheapest-first because there the user is actively
// comparing options themselves. Confirmed live: for "Relish Chicken Curry Cut
// Without Skin 450 g", Swiggy's own search already ranks real chicken cuts
// (Meat Window, JAPFA BEST, Godrej) ahead of "Suhana Chicken Masala" — the
// masala packet sits at position 19 of 20. But sortVariants' price-ascending
// tiebreak was promoting that ₹46 packet straight to the top over ₹150-290
// real chicken, overriding Swiggy's own correct relevance order — which is
// exactly why an imported "chicken curry cut" was auto-adding chicken masala.
// This keeps mostOrdered-first (the user's own past purchases are a stronger
// personal signal than Swiggy's generic ranking) but otherwise trusts
// Swiggy's original order — flattenVariants already preserves it — instead
// of re-sorting by price. Array.sort is stable (guaranteed since ES2019), so
// returning 0 for the "otherwise" case keeps that original order intact.
function sortForBestPick(variants) {
  return [...variants].sort((a, b) => {
    const moDiff = (b.mostOrdered ? 1 : 0) - (a.mostOrdered ? 1 : 0);
    if (moDiff !== 0) return moDiff;
    if (a.mostOrdered && b.mostOrdered) return (a.orderRank ?? 0) - (b.orderRank ?? 0);
    return 0;
  });
}

// From the top-N relevant variant refs, put the one to AUTO-ADD first (so the
// recipe/import UI marks it "in cart" at the top; the rest stay as swap
// options). Rule (the user's choice): a "most ordered by you" match wins even
// if pricier — a personal past purchase is the strongest signal; otherwise the
// cheapest by price. `sortForBestPick` already selected these N by relevance
// (§chicken-vs-masala: the ₹46 masala packet never reaches the top 3, so
// "cheapest of the 3" can't resurrect it), so this only decides WHICH of the
// genuinely-relevant options to add.
function orderBestFirst(refs) {
  if (refs.length <= 1) return refs;
  const mostOrdered = refs.filter((r) => r.mostOrdered);
  const best = mostOrdered.length
    ? mostOrdered.reduce((a, b) => ((a.orderRank ?? 0) <= (b.orderRank ?? 0) ? a : b))
    : refs.reduce((a, b) => ((a.price ?? Infinity) <= (b.price ?? Infinity) ? a : b));
  return [best, ...refs.filter((r) => r !== best)];
}

function plainTokens(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// The user's own free-text query can already name one of the brands Swiggy's
// fuzzy search fanned out into (e.g. "order SuperYou 10g Protein Wafer Bar"
// returning Yogabar/Ritebite/PHAB alongside SuperYou) — asking "which brand?"
// when they just said it is exactly the annoyance this exists to prevent.
// Word-boundary contiguous match (not a raw substring), so a short brand
// name can't accidentally match part of an unrelated word. Only trusted when
// exactly one candidate brand is named — if the query somehow names two,
// that's genuinely ambiguous and falls through to asking as normal, so this
// can never make a real multi-brand question disappear.
function detectExplicitBrand(query, brands) {
  const queryTokens = plainTokens(query);
  const matches = [];
  for (const brand of brands) {
    const brandTokens = plainTokens(brand);
    if (brandTokens.length === 0) continue;
    for (let i = 0; i + brandTokens.length <= queryTokens.length; i++) {
      if (brandTokens.every((t, j) => queryTokens[i + j] === t)) {
        matches.push(brand);
        break;
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
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
  const relevant = filterRelevantProducts(rawSearch, query);

  // If the user named a pack size ("100g paneer") or a clothing size ("size L
  // underpants"), narrow to matching variants BEFORE anything else (brand
  // grouping, sorting) sees the results — so a brand that only sells a
  // different size is never offered as a choice for this request, and "show
  // more" only pages through genuinely matching sizes. The two are mutually
  // exclusive per query (a weight and a garment size don't co-occur), so
  // whichever the query actually stated wins; parseSizeFrom only fires on a
  // clear apparel/size signal, never on a "1 L" volume.
  const requestedQty = parseQuantityFrom(query);
  const requestedSize = parseSizeFrom(query);
  const q = filterByRequestedQuantity(relevant, requestedQty);
  const s = filterByRequestedSize(q.raw, requestedSize);
  const raw = s.raw;
  const sizeMatchedAny = q.sizeMatchedAny && s.sizeMatchedAny;
  cacheProducts(raw);
  let variants = flattenVariants(raw, goToIndex);

  // Compute the brand list (post size-filter) whenever an ask would
  // otherwise be possible, so it can double as input to the explicit-brand
  // auto-detect below — same list either way, no extra work.
  const brands = !forceBrand && !skipBrandAsk ? distinctBrands(raw) : [];
  const effectiveForceBrand = forceBrand || (brands.length >= 2 ? detectExplicitBrand(query, brands) : null);

  if (effectiveForceBrand) {
    const target = effectiveForceBrand.toLowerCase();
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

  // "Couldn't find that size" notice — names whichever the user actually
  // asked for (pack weight/volume, or clothing size).
  let sizeNotice = null;
  if (!sizeMatchedAny) {
    if (requestedQty && !q.sizeMatchedAny) sizeNotice = `Couldn't find a ${formatQty(requestedQty)} pack — here's what's available:`;
    else if (requestedSize && !s.sizeMatchedAny) sizeNotice = `Couldn't find size ${requestedSize} — here's what's available:`;
  }

  if (!effectiveForceBrand && !skipBrandAsk && brands.length >= 2) {
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
      payload: {
        question: sizeNotice ? `${sizeNotice} Which brand would you like?` : `Which brand of ${query} would you like?`,
        options: [...options, ANY_BRAND_LABEL],
      },
    };
  }

  pendingBrandChoice = null;
  const shown = variants.slice(0, VARIANTS_PER_PAGE);
  lastSearchContext = { query, allVariants: variants, shown: shown.length };
  return {
    kind: "products",
    payload: { intro: sizeNotice || `Here's what I found for "${query}":`, items: enrichProducts(shown) },
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

// Every deterministic direct action below catches broadly so a Swiggy
// rejection (out of stock, stuck cart, etc.) becomes a friendly chat message
// instead of a 500. A mid-session auth failure (§mcpClient.js — Swiggy's JWT
// can expire before the locally tracked 5-day window does) must NOT go
// through that same path: it's not a cart problem the user can retry their
// way out of, it needs the app's real "please reconnect" prompt. Call this
// first in every catch block so it re-throws before any friendly-message
// building happens — the re-thrown error propagates uncaught up to the route
// and Express's central handler, which converts it to 401 NEEDS_REAUTH.
function rethrowIfReauth(err) {
  if (err instanceof NeedsReauthError) throw err;
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
// Notably, some items report as fully in-stock in search yet update_cart
// rejects them anyway — confirmed live (reproduced directly against the
// server) for two DIFFERENT real rejection reasons on two DIFFERENT items:
// "None of the requested items are currently in stock" (genuinely out of
// stock despite the search flag) and "no valid items remained..." (rejected
// for no reason visible in the search data at all — not a size/brand issue,
// Swiggy just won't take it right now). Both are unpredictable from search
// results, so neither gets a raw dump, but they're told apart so the advice
// matches what's actually true.
function friendlyCartError(err) {
  const first = String(err.message || "").split("\n")[0].trim();
  if (/partially available/i.test(first)) {
    return `the cart may be stuck — tap "Clear cart" below to reset it, then try again.`;
  }
  // Confirmed live: this is a cart-WIDE per-item quantity cap, not something
  // about the specific item just clicked — and it poisons get_cart the same
  // way "partially available" does (every read fails identically, not just
  // adds). Swiggy's raw text never names which item hit the cap, so there's
  // no way to fix just that one from the client side; the honest advice is
  // to reduce quantities or clear the cart, not "pick something else." Its
  // raw wording also reads like it's addressing an AI agent directly
  // ("Display the cart to the user...", "Do NOT proceed to checkout...") —
  // confirmed this is Swiggy's own live server text, not anything this app
  // added, but it's never shown to the user verbatim regardless of that.
  if (/quantity limit reached/i.test(first)) {
    return "you've hit Swiggy's order-quantity limit on one of your items — open the cart, reduce it, or clear the cart to start over.";
  }
  if (/out of stock|none of the requested items are (?:currently )?in stock/i.test(first)) {
    return "it's out of stock right now — try another option.";
  }
  if (/no valid items|not serviceable|cannot be added|couldn'?t be added|an error occurred|unavailable/i.test(first)) {
    return "Swiggy rejected this item right now — try again in a bit, or pick something else.";
  }
  return first || "something went wrong — try again.";
}

// Whether a thrown error means THIS item specifically can't be added — as
// opposed to a cart-level problem (a stuck/"partially available" cart, or a
// cart-wide quantity cap) that isn't this item's fault and could equally
// block a totally different item. Used to decide whether to call
// markSpinOutOfStock: only a real, item-attributable rejection should
// permanently hide a product for the rest of the session.
function isItemUnavailableError(err) {
  const first = String(err.message || "").split("\n")[0].trim();
  if (/partially available|quantity limit reached/i.test(first)) return false;
  return /out of stock|none of the requested items are (?:currently )?in stock|no valid items|not serviceable|cannot be added|couldn'?t be added|an error occurred|unavailable/i.test(
    first
  );
}

// ---------------------------------------------------------------------------
// Cart merge — shared by the deterministic direct-add/reorder actions below.
// update_cart replaces the whole cart, so always read the real current
// contents first and fold the new item(s) in by spinId+skuId.
// ---------------------------------------------------------------------------

// Confirmed live: Swiggy's update_cart can return a normal success response
// while silently NOT including a specific item in the resulting cart — no
// error thrown at all, so nothing downstream would notice without explicitly
// checking. These two helpers let every add path verify the real cart state
// instead of trusting "the call didn't throw" as proof an item landed.
//
// Keyed by spinId ALONE, not spinId+skuId. Confirmed live this matters: the
// same physical product's skuId isn't always stable — a "usual" saved at one
// point (skuId A) and the identical product already sitting in the cart from
// a different add (skuId B) are the same spinId but different skuId, and
// Swiggy's own cart consolidates them into ONE line by spinId regardless.
// Keying our own merge map by the spinId+skuId composite (the original
// design) meant a skuId mismatch made this code treat the same physical item
// as two "different" ones — merging in a second, separately-keyed entry
// alongside the first instead of recognizing it as already present. Swiggy's
// cart then silently combined those two entries into one line with a summed
// quantity, which looked identical to (and was initially misdiagnosed as)
// the retry-double-add bug fixed above, but has a different root cause and
// needed this separate fix.
function itemKey(spinId) {
  return String(spinId);
}

function keysInCart(cart) {
  const set = new Set();
  for (const i of cart?.items || []) set.add(itemKey(i.spinId));
  return set;
}

// Returns { cart, targetItems } — targetItems is the EXACT merged item list
// that was just written. Confirmed live: this is a real bug source, not just
// a theoretical one. Every caller here used to "retry" a not-yet-landed item
// by calling this function AGAIN, which re-reads the cart and re-merges
// (existing quantity + requested quantity) from scratch. But the read right
// after a write can race Swiggy's own eventual consistency — the write
// genuinely succeeded, the verification read just hadn't caught up yet. When
// that happened, the "retry" saw the (by-then-current) quantity as
// "existing" and added the requested amount ON TOP of it a second time,
// silently doubling real cart quantities with no error and no second click
// from the user — reproduced live across a bulk "Reorder my usuals" batch,
// where the same race can independently hit several items in one call.
// Callers must NEVER re-derive a fresh merge for a retry; update_cart is
// idempotent (replaying the identical item list is always safe — see
// instamartClient.js), so a retry should resend this exact targetItems list
// and re-verify, never recompute a new one from another read.
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
      merged.set(itemKey(i.spinId), { spinId: i.spinId, skuId: i.skuId, quantity: i.quantity });
    }
    for (const ni of newItems) {
      const key = itemKey(ni.spinId);
      const existing = merged.get(key);
      // Keyed by spinId only (see itemKey) — and prefer whichever skuId is
      // ALREADY settled in the live cart for this spinId, rather than the
      // new item's own skuId, so a re-add never introduces a second,
      // divergent skuId reference for a product already sitting in the cart.
      merged.set(key, {
        spinId: ni.spinId,
        skuId: existing?.skuId ?? ni.skuId,
        quantity: (existing?.quantity || 0) + (ni.quantity || 1),
      });
    }
    const targetItems = [...merged.values()];
    await instamartClient.updateCart({ selectedAddressId: addressId, items: targetItems });
    const cart = await instamartClient.getCartOrEmpty();
    return { cart, targetItems };
  } catch (err) {
    // No point attempting a resync read when the failure is itself an
    // expired/missing token — it would just fail identically.
    if (!(err instanceof NeedsReauthError)) {
      err.cart = await instamartClient.getCartOrEmpty().catch(() => null);
    }
    throw err;
  }
}

// Resend the exact item list from an earlier mergeAndUpdateCart call — never
// recompute a new merge for a retry (see the comment above).
async function resendCartTarget(addressId, targetItems) {
  await instamartClient.updateCart({ selectedAddressId: addressId, items: targetItems });
  return instamartClient.getCartOrEmpty();
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

// ---------------------------------------------------------------------------
// Recipe web-grounding — "search first, then generate" (see CLAUDE.md). The
// model's first-pass propose_ingredients call (in makeExecuteTool below)
// still recognizes the recipe intent and extracts the dish name from free
// text exactly as before; what changes is that its OWN ingredient list is
// now only a fallback. A real web search runs first, and a SECOND, narrowly
// scoped completion re-derives the ingredient list grounded in that search
// content. This is a genuine second Groq completion (this flow was "exactly
// one completion" before) — an explicit, user-approved trade of a bit more
// latency for a real recipe instead of pure model recall. Both the search
// and the grounding completion fail open: any error, missing TAVILY_API_KEY,
// or empty results silently falls back to the original ungrounded list, so
// the recipe flow can never break because of this.
// ---------------------------------------------------------------------------

function dedupeIngredients(raw) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const ing = String(item || "").trim();
    const key = ing.toLowerCase();
    if (!ing || seen.has(key)) continue;
    seen.add(key);
    out.push(ing);
    if (out.length >= 16) break; // "minimal" is the product requirement
  }
  return out;
}

const GROUND_INGREDIENTS_TOOL = {
  type: "function",
  function: {
    name: "propose_ingredients",
    description: "Report the final essential ingredient list, grounded in the real recipe content given.",
    parameters: {
      type: "object",
      properties: {
        ingredients: {
          type: "array",
          items: { type: "string" },
          description:
            "Essential ingredients as short generic Instamart grocery search terms (no brands/quantities/steps), using Indian grocery names.",
        },
      },
      required: ["ingredients"],
    },
  },
};

// Bounded, single-purpose completion (same pattern as discoveryAgent.js's
// judgeRelevantItems/estimateNutrition) — not routed through runToolLoop
// since there's no multi-turn tool use here, just one forced tool call.
async function groundIngredients(dish, search) {
  const sourceText = search.results
    .slice(0, 3)
    .map((r) => `Source: ${r.title || r.url || "unknown"}\n${r.content}`)
    .join("\n\n");
  const contextText = [search.answer ? `Summary: ${search.answer}` : null, sourceText]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 6000); // keep the completion's input bounded regardless of how much Tavily returns
  if (!contextText.trim()) return null;

  try {
    const completion = await createCompletionWithRetry({
      model: config.groqModel,
      reasoning_effort: "low",
      messages: [
        {
          role: "system",
          content: `You extract a real, essential ingredient list for "${dish}" from the recipe content given below — short generic Instamart grocery search terms, no brands, no quantities, no steps. Use the COMMON INDIAN GROCERY NAME for each staple: "curd" (not "yogurt"), "coriander leaves" (not "cilantro"), "capsicum" (not "bell pepper"), "paneer" (not "cottage cheese"), "chana"/"rajma" (not "garbanzo"/"kidney bean"), "green chilli" (not "jalapeño"). Ground your answer in the content given rather than general knowledge — if the content describes a specific recipe, follow it. Call propose_ingredients exactly once.`,
        },
        { role: "user", content: contextText },
      ],
      tools: [GROUND_INGREDIENTS_TOOL],
      tool_choice: { type: "function", function: { name: "propose_ingredients" } },
      max_tokens: 1024,
    });

    const choice = completion.choices[0];
    if (choice.finish_reason !== "tool_calls") {
      console.error(`[groundIngredients] non-terminal finish_reason="${choice.finish_reason}" for dish="${dish}"`);
      return null;
    }
    const toolCall = choice.message.tool_calls?.[0];
    if (!toolCall) return null;
    const args = JSON.parse(toolCall.function.arguments || "{}");
    const grounded = dedupeIngredients(args.ingredients);
    return grounded.length > 0 ? grounded : null;
  } catch (err) {
    console.error(`[groundIngredients] failed for dish="${dish}": ${err.message}`);
    return null;
  }
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
      case "propose_ingredients": {
        // The model's first-pass list is now only a FALLBACK — see the
        // web-grounding block above. Showing the (possibly grounded) list for
        // edit/confirm is still a fixed outcome, so this still ends the loop
        // (§6.4 pattern) rather than paying for a completion to restate a
        // decision already made. The Confirm click still comes back through
        // /recipe-confirm, a fully deterministic endpoint.
        const dish = String(args.dish || "").trim() || "your dish";
        const fallback = dedupeIngredients(args.ingredients);
        if (fallback.length === 0) {
          return { error: "ingredients array was empty — nothing to propose" };
        }

        let ingredients = fallback;
        let grounded = false;
        let sourceUrls = [];
        try {
          const search = await searchWeb({ query: `${dish} recipe ingredients` });
          if (search && (search.results.length > 0 || search.answer)) {
            const regrounded = await groundIngredients(dish, search);
            if (regrounded) {
              ingredients = regrounded;
              grounded = true;
              sourceUrls = search.results.slice(0, 3).map((r) => r.url).filter(Boolean);
            }
          }
        } catch (err) {
          console.error(`[propose_ingredients] web grounding failed for dish="${dish}": ${err.message}`);
        }

        return { __endLoop: true, kind: "ingredients", payload: { dish, ingredients, grounded, sourceUrls } };
      }
      case "get_usuals":
        return {
          usuals: dbListUsuals().map((u) => ({
            spinId: u.spinId,
            name: u.displayName,
            brand: u.brand,
            size: u.quantityDescription,
          })),
        };
      case "remove_from_usuals": {
        const match = matchUsualByName(args.name, dbListUsuals());
        if (!match) return { removed: false, message: "No matching item on the usuals list." };
        dbRemoveUsual(match.spinId, match.skuId);
        return { removed: true, name: match.displayName };
      }
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
  if (kind === "ingredients") {
    const { dish, ingredients, grounded, sourceUrls } = payload;
    return {
      entry: { role: "assistant", type: "ingredients", dish, ingredients, grounded, sourceUrls },
      responsePayload: { reply: "", ingredients: { dish, ingredients, grounded, sourceUrls } },
    };
  }
  if (kind === "empty") {
    const reply = `Couldn't find anything for "${payload.query}" — want to try a different search?`;
    return { entry: { role: "assistant", text: reply }, responsePayload: { reply } };
  }
  const reply = text || "(no reply)";
  return { entry: { role: "assistant", text: reply }, responsePayload: { reply } };
}

// userText goes to the LLM; displayText is what the transcript shows the user.
// ---------------------------------------------------------------------------
// Off-topic guardrail — a ZERO-Groq-call gate that refuses obvious non-grocery
// questions before they ever reach the model (Insta-nt was happily answering
// "what is the capital of india?", burning a completion per random question).
// Deliberately HIGH-PRECISION, not high-recall: it only short-circuits when
// it's confident a message is off-topic, so it can NEVER block a real grocery
// request. Anything it doesn't catch still reaches the model, whose system
// prompt now has its own hard "refuse off-topic" rule (§SYSTEM_PROMPT) as the
// backstop — so a miss here costs one small refusal completion, not a wrong
// answer. This is the pre-gate half of a pre-gate + LLM-backstop design.
// ---------------------------------------------------------------------------

// If any of these appear, the message plausibly concerns shopping — never
// refuse it deterministically, let the model handle it. (Bare product names
// like "milk" have none of these but also match no off-topic pattern below,
// so they fall through to the model too — the safe default.)
const SHOPPING_SIGNAL =
  /\b(add|order|buy|purchase|get|grab|want|need|pick|remove|delete|clear|empty|reorder|checkout|check\s?out|pay|deliver|restock|search|find|show|cart|carts|usual|usuals|basket|grocery|groceries|recipe|make|cook|prepare|ingredient|ingredients)\b|\d\s*(g|kg|gm|gms|ml|l|ltr|litre|liter|pack|packet|piece|pieces|pcs|dozen|bottle|can|box|bunch)\b/i;

// High-confidence off-topic patterns. Almost all are gated behind an
// interrogative or an explicit non-grocery task verb, so plain product phrases
// (a brand called "President", "add king chilli", etc.) don't trip them.
const OFFTOPIC_PATTERNS = [
  /\bcapital(s)? of\b/i,
  /\b(whos?|whats?|when|where|why|how)\b[\s\S]*\b(country|countries|city|cities|capital|president|prime minister|pm of|population|weather|temperature|climate|history|war|movie|film|actor|actress|singer|player|team|match|score|planet|solar system|ocean|mountain|river|continent|language|currency|religion|god|festival|election|stock|bitcoin|crypto)\b/i,
  /\bwhat('?s| is| are| was)\b[\s\S]*\b(meaning|definition|difference between|the time|the date|today'?s date|day today|square root|derivative|integral)\b/i,
  /\b(translate|conjugate|synonym|antonym|rhyme with|spell)\b/i,
  /\b(write|compose|draft|generate|create)\b[\s\S]*\b(poem|essay|story|song|code|program|script|email|letter|joke|paragraph|resume|cv)\b/i,
  /\b(solve|calculate|compute|what is|whats)\b[\s\S]*\d+\s*[-+*/x×÷]\s*\d+/i, // arithmetic
  /\b(how (are|r) (you|u|ya)|who are you|what('?s| is) your name|are you (an? )?(ai|bot|human|robot|chatgpt|gpt|llm|model))\b/i,
  /\b(tell me a joke|sing (me )?a song|dad joke|fun fact|riddle|tongue twister)\b/i,
  /\b(python|javascript|typescript|java|c\+\+|sql query|html|css|react|leetcode)\b/i,
  /\b(meaning of life|who made you|who created you|are you conscious)\b/i,
];

function looksOffTopic(userText) {
  const t = String(userText || "").trim().toLowerCase();
  if (!t) return false;
  if (SHOPPING_SIGNAL.test(t)) return false; // any shopping intent → let the model handle it
  return OFFTOPIC_PATTERNS.some((re) => re.test(t));
}

const OFFTOPIC_REPLY =
  'I can only help you shop on Instamart — try "add milk", "order things for biryani", or attach a cart screenshot.';

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

  // Off-topic guardrail (zero Groq calls) — refuse obvious non-grocery
  // questions here rather than letting the model answer and burn a completion.
  // Deliberately after the brand-follow-up branch (a one-word brand answer is
  // never off-topic) and only fires on high-confidence matches; everything
  // else falls through to the model, which refuses off-topic on its own.
  if (looksOffTopic(userText)) {
    displayTranscript.push({ role: "assistant", text: OFFTOPIC_REPLY });
    trimConversation();
    return { reply: OFFTOPIC_REPLY, cart: null };
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
      rethrowIfReauth(err);
      liveCart = { error: err.message };
    }
  }

  // If the model edited the usuals list this turn, hand the fresh list back so
  // the My Usuals panel re-renders without a separate round-trip.
  const usuals = executedTools.some((t) => t.name === "remove_from_usuals") ? dbListUsuals() : null;

  return { ...responsePayload, cart: liveCart, usuals };
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

  let becameOutOfStock = false;
  try {
    const first = await mergeAndUpdateCart(addressId, [{ spinId, skuId, quantity }]);
    cart = first.cart;
    let landed = keysInCart(cart).has(itemKey(spinId, skuId));
    if (!landed) {
      // Swiggy can report update_cart success while silently dropping this
      // specific item — confirmed live, reproducible for a given item/store
      // combo, no error thrown to catch. But the retry here must RESEND the
      // exact same target list already written above, not recompute a fresh
      // merge (which would re-read the cart and add this item's quantity ON
      // TOP of whatever's now there) — confirmed live that a stale
      // just-after-write read is what actually caused this branch to fire
      // most of the time, not a genuine drop, and recomputing on retry
      // silently doubled the real quantity as a result.
      cart = await resendCartTarget(addressId, first.targetItems);
      landed = keysInCart(cart).has(itemKey(spinId, skuId));
    }
    if (landed) {
      reply = `Added ${name} to your cart ✓`;
    } else {
      // Still didn't land after a retry — treat it the same as a thrown
      // "can't be added" rejection (see isItemUnavailableError) so it's
      // learned for the rest of the session, not just this one click.
      markSpinOutOfStock(spinId);
      becameOutOfStock = true;
      reply = `Couldn't add ${name} — Swiggy isn't letting this one be added right now, try again later.`;
    }
  } catch (err) {
    rethrowIfReauth(err);
    if (isItemUnavailableError(err)) {
      markSpinOutOfStock(spinId);
      becameOutOfStock = true;
    }
    reply = `Couldn't add ${name} — ${friendlyCartError(err)}`;
    cart = err.cart ?? null;
  }
  displayTranscript.push({ role: "assistant", text: reply });
  trimConversation();
  // outOfStockSpinId tells the frontend to retroactively greyed-out any
  // ALREADY-rendered card for this product in the current chat session (see
  // InstamartChat.jsx's runAction) — displayTranscript above is patched for
  // free since enrichProducts hands out the same cached object reference,
  // but the frontend's own already-fetched message list needs telling.
  return { reply, cart, ...(becameOutOfStock ? { outOfStockSpinId: String(spinId) } : {}) };
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
    rethrowIfReauth(err);
    reply = `Couldn't clear the cart — ${String(err.message || "").split("\n")[0]}`;
  }
  displayTranscript.push({ role: "assistant", text: reply });
  trimConversation();
  return { reply, cart };
}

// ---------------------------------------------------------------------------
// Usuals list — LOCAL and user-editable (db.js `usuals` table), NOT Swiggy's
// read-only your_go_to_items. Saving happens from a ☆ on any product card;
// removing from the My Usuals panel or via the chat agent's remove_from_usuals
// tool. "Reorder now" and the daily scheduler both add this local list into
// the cart. (your_go_to_items still powers the "most ordered by you" search
// badge — §6.9 — that's a separate, live signal.)
// ---------------------------------------------------------------------------

// Merge a set of items into the cart, tolerant of individual failures, and
// tolerant of Swiggy's own silent ones. Fast path is one batch update_cart;
// if that THROWS (typically the whole batch rejected — §6.5), or if it
// succeeds but the resulting cart is quietly missing an item Swiggy never
// complained about (confirmed live: a 4-item batch update_cart returned
// success with no error, yet the cart afterward only had 3 of the 4 items —
// a different, more dangerous failure mode than the documented "whole batch
// rejected" one, because nothing here would have signaled a problem without
// checking) — either way, only the items actually missing get retried one at
// a time, and `added`/`failed` are always computed from the FINAL cart's real
// contents, never assumed from whether a call threw. Used by both "Reorder
// now" and the scheduler. Reauth errors propagate untouched.
async function addUsualsBestEffort(addressId, items) {
  let cart = null;
  let missing = items;
  const targetByKey = new Map();
  try {
    const first = await mergeAndUpdateCart(addressId, items);
    cart = first.cart;
    for (const t of first.targetItems) targetByKey.set(itemKey(t.spinId, t.skuId), t);
    const present = keysInCart(cart);
    missing = items.filter((it) => !present.has(itemKey(it.spinId, it.skuId)));
  } catch (err) {
    if (err instanceof NeedsReauthError) throw err;
    cart = await instamartClient.getCartOrEmpty().catch(() => null);
  }

  if (missing.length === 0) {
    return { cart, added: items.length, failed: 0 };
  }

  // Some items looked missing right after the batch write above — either a
  // genuine per-item rejection, or (confirmed live, and the more common
  // cause) a stale verification read that hadn't caught up to an
  // already-successful write yet. Retry them ONE AT A TIME so a single
  // genuinely-rejected item can't sink the rest (see ARCHITECTURE.md §6.11)
  // — each retry re-reads the cart fresh (so an item that already landed
  // from the batch write isn't accidentally dropped by update_cart's
  // replace semantics) but always sets the retried item to its ALREADY-
  // COMPUTED target quantity from the batch write above, never re-derived
  // as "whatever's there now + more". That re-derivation is exactly what
  // silently doubled real quantities before: an item that had actually
  // already landed got a stale read that didn't show it yet, so the retry
  // added its quantity a second time on top of the real, already-correct
  // amount.
  for (const it of missing) {
    const key = itemKey(it.spinId, it.skuId);
    const target = targetByKey.get(key) || { spinId: it.spinId, skuId: it.skuId, quantity: it.quantity || 1 };
    const base = await instamartClient.getCartOrEmpty().catch(() => ({ items: [] }));
    const trial = new Map();
    for (const i of base.items || []) {
      trial.set(itemKey(i.spinId, i.skuId), { spinId: i.spinId, skuId: i.skuId, quantity: i.quantity });
    }
    trial.set(key, target);
    try {
      await instamartClient.updateCart({ selectedAddressId: addressId, items: [...trial.values()] });
    } catch (e) {
      if (e instanceof NeedsReauthError) throw e;
      // Genuinely didn't land — counted as failed below.
    }
  }

  const finalCart = await instamartClient.getCartOrEmpty().catch(() => null);
  const finalPresent = keysInCart(finalCart);
  const failed = items.filter((it) => !finalPresent.has(itemKey(it.spinId, it.skuId))).length;
  return { cart: finalCart, added: items.length - failed, failed };
}

// Add the entire local usuals list into the cart (merge). Shared by the
// "Reorder now" button, the chat "reorder my usuals", and the daily scheduler.
export async function addUsualsToCart(addressId) {
  const usuals = dbListUsuals();
  if (usuals.length === 0) return { empty: true, added: 0, failed: 0, cart: null };
  const items = usuals.map((u) => ({ spinId: u.spinId, skuId: u.skuId, quantity: u.quantity || 1 }));
  const res = await addUsualsBestEffort(addressId, items);
  return { empty: false, ...res };
}

export async function reorderUsualsDirect({ addressId, displayText = "Reorder my usual items" }) {
  displayTranscript.push({ role: "user", text: displayText });
  let reply;
  let cart = null;
  try {
    const res = await addUsualsToCart(addressId);
    cart = res.cart;
    if (res.empty) {
      reply = "Your usuals list is empty — find items in chat and tap the ☆ to save them here first.";
    } else if (res.failed === 0) {
      reply = `Added ${res.added} usual item${res.added === 1 ? "" : "s"} to your cart ✓`;
    } else if (res.added === 0) {
      reply = "Couldn't add your usuals — none seem to be available right now.";
    } else {
      reply = `Added ${res.added} of ${res.added + res.failed} usuals — the rest are unavailable right now.`;
    }
  } catch (err) {
    rethrowIfReauth(err);
    reply = `Couldn't reorder your usuals — ${friendlyCartError(err)}`;
    cart = err.cart ?? null;
  }
  displayTranscript.push({ role: "assistant", text: reply });
  trimConversation();
  return { reply, cart };
}

// ---------------------------------------------------------------------------
// Recipe flow, step 2 of 2 — fully deterministic, zero Groq calls. Step 1 was
// the model calling propose_ingredients (one completion, ends the loop); the
// user then edits the checklist in the UI and hits Confirm, which lands here
// with the FINAL ingredient list. Each ingredient is searched in parallel
// (capped at 3 concurrent — same rate-limit reasoning as Feaster's
// scoped-menu fan-out), reusing the exact same pipeline as a normal guided
// search: relevance filter (§6.10), go-to cross-reference (§6.9), stock/price
// sort (§6.5). The best in-stock option per ingredient goes straight into the
// cart via addUsualsBestEffort (which verifies the real cart, §6.5's silent-
// drop lesson), and up to 3 compact options per ingredient go back for the
// swap UI.
// ---------------------------------------------------------------------------
const OPTIONS_PER_INGREDIENT = 3;

// Held so swapRecipeItemDirect can update which option is marked "added" on
// the rendered transcript entry (same object, by reference) — a swap is a
// cart mutation like the stepper, not a new chat message.
let lastRecipeEntry = null;

export async function confirmRecipeDirect({ dish, ingredients, addressId }) {
  const list = [...new Set((ingredients || []).map((i) => String(i || "").trim()).filter(Boolean))].slice(0, 16);
  displayTranscript.push({ role: "user", text: `Confirm ingredients for ${dish} (${list.length})` });

  // Mark the checklist entry consumed so a page reload renders it inert
  // instead of offering a second Confirm that would double-add everything.
  for (let i = displayTranscript.length - 1; i >= 0; i--) {
    if (displayTranscript[i].type === "ingredients" && !displayTranscript[i].confirmed) {
      displayTranscript[i].confirmed = true;
      break;
    }
  }

  if (list.length === 0) {
    const reply = "The ingredient list is empty — nothing to order.";
    displayTranscript.push({ role: "assistant", text: reply });
    trimConversation();
    return { reply, cart: null };
  }

  try {
    const goToIndex = await getGoToIndex(addressId);
    const groups = await mapWithConcurrency(list, 3, async (ingredient) => {
      try {
        const rawSearch = await instamartClient.searchProducts({ query: ingredient, addressId });
        const raw = filterRelevantProducts(rawSearch, ingredient);
        cacheProducts(raw);
        const inStock = sortForBestPick(flattenVariants(raw, goToIndex)).filter((v) => v.inStock !== false);
        // Top-3 by relevance, then reorder so the auto-add pick (cheapest, or a
        // past-ordered match) is first — options[0] is what gets added below.
        const options = enrichProducts(orderBestFirst(inStock.slice(0, OPTIONS_PER_INGREDIENT)));
        return { ingredient, options };
      } catch (err) {
        rethrowIfReauth(err);
        // One ingredient's search failing shouldn't sink the whole recipe.
        return { ingredient, options: [] };
      }
    });

    const found = groups.filter((g) => g.options.length > 0);
    const missing = groups.filter((g) => g.options.length === 0).map((g) => g.ingredient);

    let cart = null;
    let added = 0;
    if (found.length > 0) {
      const bestItems = found.map((g) => ({ spinId: g.options[0].spinId, skuId: g.options[0].skuId, quantity: 1 }));
      const res = await addUsualsBestEffort(addressId, bestItems);
      cart = res.cart;
      added = res.added;
      // Mark which option actually landed per group from the REAL cart —
      // never from call success (§6.5's silent-drop lesson applies here too).
      const present = keysInCart(cart);
      for (const g of found) {
        const best = g.options[0];
        g.addedSpinId = present.has(itemKey(best.spinId, best.skuId)) ? best.spinId : null;
      }
    }

    let reply;
    if (found.length === 0) {
      reply = `Couldn't find anything for those ingredients right now — try different search terms.`;
    } else {
      reply = `Added ${added} of ${found.length} ingredients for ${dish} — tap Swap below to change any pick.`;
      if (missing.length > 0) reply += ` Couldn't find: ${missing.join(", ")}.`;
    }

    const entry = { role: "assistant", type: "recipe", dish, reply, groups };
    lastRecipeEntry = entry;
    displayTranscript.push(entry);
    trimConversation();
    return { reply, recipe: { dish, groups }, cart };
  } catch (err) {
    rethrowIfReauth(err);
    const reply = `Couldn't put the ${dish} list together — ${friendlyCartError(err)}`;
    displayTranscript.push({ role: "assistant", text: reply });
    trimConversation();
    return { reply, cart: null };
  }
}

// Swap the cart line for one ingredient: drop the previously-added option,
// add the tapped one (verified against the returned cart, one retry — same
// policy as addItemDirect). Not a chat event: no transcript entry, but the
// last recipe entry's "added" marker is updated in place so a reload renders
// the current truth.
export async function swapRecipeItemDirect({ addressId, ingredient, removeSpinId, removeSkuId, spinId, skuId, quantity = 1 }) {
  const qty = Math.max(1, Math.min(20, Number(quantity) || 1));
  try {
    const current = await instamartClient.getCartOrEmpty();
    const items = (current.items || [])
      .filter((i) => !(String(i.spinId) === String(removeSpinId) && String(i.skuId) === String(removeSkuId)))
      .map((i) => ({ spinId: i.spinId, skuId: i.skuId, quantity: i.quantity }));
    const already = items.find((i) => String(i.spinId) === String(spinId) && String(i.skuId) === String(skuId));
    if (already) already.quantity += qty;
    else items.push({ spinId, skuId, quantity: qty });
    await instamartClient.updateCart({ selectedAddressId: addressId, items });

    let cart = await instamartClient.getCartOrEmpty();
    if (!keysInCart(cart).has(itemKey(spinId, skuId))) {
      await instamartClient.updateCart({ selectedAddressId: addressId, items });
      cart = await instamartClient.getCartOrEmpty();
    }
    const landed = keysInCart(cart).has(itemKey(spinId, skuId));

    if (landed && lastRecipeEntry) {
      const group = lastRecipeEntry.groups.find((g) => g.ingredient === ingredient);
      if (group) group.addedSpinId = String(spinId);
    }
    return landed
      ? { cart, addedSpinId: String(spinId) }
      : { cart, error: "Swiggy isn't letting that option be added right now — try another." };
  } catch (err) {
    rethrowIfReauth(err);
    const cart = await instamartClient.getCartOrEmpty().catch(() => null);
    return { cart, error: friendlyCartError(err) };
  }
}

// ---------------------------------------------------------------------------
// Import-from-screenshot flow. Step 1 (importImageDirect) is the one vision
// call — it reads product line items off an uploaded screenshot of another
// app's cart. Step 2 (confirmImportDirect) is fully deterministic: it runs
// each item through the SAME search/relevance/size/stock pipeline a typed
// order uses, auto-adds the ones with an exact in-stock size match (at the
// quantity from the screenshot), and shows up to 3 alternatives for the rest.
// Renders through the same `recipe` message shape as §6.13 so the swap/add
// UI is reused — a group's `quantity` (from the screenshot) flows into the
// add so quantities are reproduced, and `note` distinguishes exact matches
// from "couldn't find that exact item" fallbacks.
// ---------------------------------------------------------------------------

// Short display label for an extracted item, e.g. "SuperYou Protein Bar (40 g) ×2".
function importItemLabel(item) {
  const size = item.size ? ` (${item.size})` : "";
  const qty = item.quantity > 1 ? ` ×${item.quantity}` : "";
  return `${item.name}${size}${qty}`;
}

export async function importImageDirect({ image, note }) {
  const cleanNote = String(note || "").trim().slice(0, 300) || null;
  displayTranscript.push({ role: "user", text: cleanNote || "Imported a screenshot" });
  let items;
  try {
    items = await extractItemsFromImage(image, cleanNote);
  } catch (err) {
    // Vision runs on Groq, not Swiggy — this won't be a reauth case, but the
    // guard is harmless and keeps the pattern uniform.
    rethrowIfReauth(err);
    const reply = "I couldn't read that image — try a clearer screenshot of the cart or item list.";
    displayTranscript.push({ role: "assistant", text: reply });
    trimConversation();
    return { reply };
  }

  if (items.length === 0) {
    const reply = "I couldn't spot any products in that image. Make sure it shows a cart or list of items, not just one product page.";
    displayTranscript.push({ role: "assistant", text: reply });
    trimConversation();
    return { reply };
  }

  const entry = { role: "assistant", type: "import", items };
  displayTranscript.push(entry);
  trimConversation();
  return { reply: "", import: { items } };
}

export async function confirmImportDirect({ items, addressId }) {
  const clean = (items || [])
    .map((it) => ({
      name: String(it?.name || "").trim(),
      size: it?.size ? String(it.size).trim() : null,
      quantity: Math.max(1, Math.min(20, Math.round(Number(it?.quantity) || 1))),
    }))
    .filter((it) => it.name)
    .slice(0, 20);

  displayTranscript.push({ role: "user", text: `Import ${clean.length} item${clean.length === 1 ? "" : "s"} from the screenshot` });

  // Consume the checklist entry so a reload can't re-add everything.
  for (let i = displayTranscript.length - 1; i >= 0; i--) {
    if (displayTranscript[i].type === "import" && !displayTranscript[i].confirmed) {
      displayTranscript[i].confirmed = true;
      break;
    }
  }

  if (clean.length === 0) {
    const reply = "Nothing left on the list to import.";
    displayTranscript.push({ role: "assistant", text: reply });
    trimConversation();
    return { reply, cart: null };
  }

  try {
    const goToIndex = await getGoToIndex(addressId);
    // Each item -> its own group with up to 3 options and an `exact` flag.
    // Labels are made unique so swapRecipeItemDirect can key on them.
    const usedLabels = new Set();
    const groups = await mapWithConcurrency(clean, 3, async (item) => {
      let label = importItemLabel(item);
      while (usedLabels.has(label)) label += " ·";
      usedLabels.add(label);

      try {
        const query = item.size ? `${item.name} ${item.size}` : item.name;
        const rawSearch = await instamartClient.searchProducts({ query, addressId });
        const relevant = filterRelevantProducts(rawSearch, item.name);
        cacheProducts(relevant);

        const allInStock = sortForBestPick(flattenVariants(relevant, goToIndex)).filter((v) => v.inStock !== false);

        // Strict size match (the user's choice): an item counts as "exact"
        // only when a same-size in-stock variant exists. A size-only mismatch
        // is treated as not-found so the user picks from options instead.
        const req = item.size ? parseQuantityFrom(item.size) : null;
        const sizeMatched = req ? allInStock.filter((v) => quantityMatches(req, v.quantityDescription)) : allInStock;
        const exact = item.size ? sizeMatched.length > 0 : allInStock.length > 0;

        const source = exact ? sizeMatched : allInStock;
        // Top-3, then reorder so the auto-add pick (cheapest, or a past-ordered
        // match) is first — options[0] is what an exact match auto-adds.
        const options = enrichProducts(orderBestFirst(source.slice(0, OPTIONS_PER_INGREDIENT)));
        return {
          ingredient: label,
          quantity: item.quantity,
          exact,
          size: item.size,
          options,
        };
      } catch (err) {
        rethrowIfReauth(err);
        return { ingredient: label, quantity: item.quantity, exact: false, size: item.size, options: [] };
      }
    });

    // Auto-add only the exact matches, at the screenshot's quantity, in one
    // real-cart-verified batch (§6.5 silent-drop lesson).
    const exactGroups = groups.filter((g) => g.exact && g.options.length > 0);
    let cart = null;
    let addedCount = 0;
    if (exactGroups.length > 0) {
      const bestItems = exactGroups.map((g) => ({
        spinId: g.options[0].spinId,
        skuId: g.options[0].skuId,
        quantity: g.quantity,
      }));
      const res = await addUsualsBestEffort(addressId, bestItems);
      cart = res.cart;
      const present = keysInCart(cart);
      for (const g of exactGroups) {
        const best = g.options[0];
        if (present.has(itemKey(best.spinId, best.skuId))) {
          g.addedSpinId = best.spinId;
          addedCount++;
        } else {
          g.addedSpinId = null;
        }
      }
    } else {
      cart = await instamartClient.getCartOrEmpty().catch(() => null);
    }

    // Groups needing the user to choose: exact match not found (but options
    // exist), plus any exact-match that failed to actually land.
    for (const g of groups) {
      if (g.addedSpinId) g.note = "Exact match added";
      else if (g.options.length > 0) g.note = "No exact match — pick one:";
    }

    const notFound = groups.filter((g) => g.options.length === 0).map((g) => g.ingredient);
    const needChoice = groups.filter((g) => !g.addedSpinId && g.options.length > 0).length;

    let reply = `Read ${clean.length} item${clean.length === 1 ? "" : "s"} from your screenshot. Added ${addedCount} exact match${addedCount === 1 ? "" : "es"} to your cart`;
    if (needChoice > 0) reply += `; ${needChoice} need${needChoice === 1 ? "s" : ""} you to pick from the options below`;
    reply += ".";
    if (notFound.length > 0) reply += ` Couldn't find: ${notFound.join(", ")}.`;

    const entry = { role: "assistant", type: "recipe", dish: "your screenshot", reply, groups };
    lastRecipeEntry = entry;
    displayTranscript.push(entry);
    trimConversation();
    return { reply, recipe: { dish: "your screenshot", groups }, cart };
  } catch (err) {
    rethrowIfReauth(err);
    const reply = `Couldn't import that list — ${friendlyCartError(err)}`;
    displayTranscript.push({ role: "assistant", text: reply });
    trimConversation();
    return { reply, cart: null };
  }
}

// Deterministic usuals editing (UI-driven, no LLM, no chat transcript entry —
// these are list-config actions like the cart stepper, not chat events). The
// full card details come from the client (which already rendered them), with
// the server-side product cache as a fallback for anything missing.
export function saveUsualDirect(product = {}) {
  const cached = productBySpin.get(String(product.spinId)) || productBySku.get(String(product.skuId));
  const merged = { ...(cached || {}), ...product };
  const usuals = dbAddUsual({
    spinId: merged.spinId,
    skuId: merged.skuId ?? null,
    displayName: merged.displayName,
    brand: merged.brand,
    quantityDescription: merged.quantityDescription,
    mrp: merged.mrp,
    offerPrice: merged.offerPrice,
    imageUrl: merged.imageUrl,
  });
  return { usuals };
}

export function removeUsualDirect({ spinId, skuId }) {
  const usuals = dbRemoveUsual(String(spinId), skuId != null ? String(skuId) : null);
  return { usuals };
}

export function getUsuals() {
  return dbListUsuals();
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
    rethrowIfReauth(err);
    const cart = await instamartClient.getCartOrEmpty().catch(() => null);
    return { cart, error: friendlyCartError(err) };
  }
}

// ---------------------------------------------------------------------------
// Per-item "Explain" popup — web-grounded Q&A scoped to one product. Entirely
// separate from the main cart-building chat (its own frontend-only modal, no
// server-side transcript) — this function is stateless per call except for
// the shared search cache above; the frontend resends the running Q&A
// history each time so the model has context for follow-ups.
// ---------------------------------------------------------------------------
export async function explainItem({ spinId, skuId, displayName, brand, quantityDescription, price, question, history }) {
  const q = String(question || "").trim();
  if (!q) return { error: "question is required" };

  const name = displayName || "this item";
  const key = String(spinId || skuId || name);

  let search = itemSearchCache.get(key);
  if (search === undefined) {
    const searchQuery = [name, brand].filter(Boolean).join(" ") + " ingredients nutrition review";
    search = await searchWeb({ query: searchQuery }).catch(() => null);
    itemSearchCache.set(key, search);
  }

  const productLine = [
    `Product: ${name}`,
    brand ? `Brand: ${brand}` : null,
    quantityDescription ? `Size: ${quantityDescription}` : null,
    price != null ? `Price: ₹${price}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const webParts = [];
  if (search?.answer) webParts.push(`Web summary: ${search.answer}`);
  if (search?.results?.length) {
    webParts.push(
      search.results
        .slice(0, 3)
        .map((r) => `Source: ${r.title || r.url || "unknown"}\n${r.content}`)
        .join("\n\n")
    );
  }
  const webContext = webParts.join("\n\n").slice(0, 6000);

  const messages = [
    {
      role: "system",
      content: `You answer questions about a specific Instamart product for the user shopping in this app. Be concise (2-4 sentences unless the question genuinely needs more). Ground your answer in the product details and web content below — if they don't cover what's asked, say so honestly rather than inventing ingredients, nutrition facts, or claims.\n\n${productLine}\n\n${webContext || "No web content is available for this item."}`,
    },
    ...(Array.isArray(history) ? history : [])
      .slice(-6)
      .map((h) => ({ role: h?.role === "assistant" ? "assistant" : "user", content: String(h?.content || "") })),
    { role: "user", content: q },
  ];

  const completion = await createCompletionWithRetry({
    model: config.groqModel,
    reasoning_effort: "low",
    messages,
    max_tokens: 512,
  });

  const answer = completion.choices[0]?.message?.content?.trim() || "I couldn't find an answer to that.";
  return {
    answer,
    grounded: Boolean(search && (search.results?.length || search.answer)),
    sourceUrls: (search?.results || []).slice(0, 3).map((r) => r.url).filter(Boolean),
  };
}

export function resetConversation() {
  conversation = [{ role: "system", content: SYSTEM_PROMPT }];
  displayTranscript = [];
  pendingBrandChoice = null;
  lastSearchContext = null;
  lastRecipeEntry = null;
}

export function getConversationForDisplay() {
  return displayTranscript;
}
