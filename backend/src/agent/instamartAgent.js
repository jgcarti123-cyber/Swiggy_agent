import { instamartClient } from "../mcp/instamartClient.js";
import { runToolLoop } from "./toolLoop.js";

// Tool calls that mutate the cart — after any of these fire during a turn,
// the live cart is re-fetched independently rather than trusting the
// model's own tool-call result or text summary.
const CART_TOUCHING_TOOLS = new Set(["update_cart", "checkout", "clear_cart"]);

// Turn-ending tools: instead of feeding a result back to the model, their args
// render UI (clickable choices / product cards) and hand control to the user.
const FINAL_TOOLS = ["ask_choice", "present_products"];

// The delivery addressId is resolved server-side (from the saved address the
// user picked in the UI) and injected into every tool call — the model never
// sees, asks for, or reasons about an address.
const SYSTEM_PROMPT = `You are Pantry Pal, a grocery assistant for Swiggy Instamart in a single-user dashboard. The delivery address is already set — never ask for it; it is added to every tool call automatically.

How to help the user fill their cart:
- If the user names a specific product AND size (e.g. "Amul Taaza 500 ml milk"), search_products then add it directly with update_cart.
- If the user names a broad category (e.g. "milk", "shampoo", "chips"), first call search_products to see what's actually available, then call ask_choice to ask which brand or type they want — offer the real brands/types from the results (see brandsAvailable) as options.
- After the user picks a brand/type, call search_products again narrowed to it (e.g. "amul milk"), then call present_products with up to 6 real variants (spinId + skuId from that search) so the user can pick the exact size/price. Order the most relevant or cheapest first.
- Only keep asking with ask_choice while the request is genuinely ambiguous — one or two rounds is plenty, never interrogate.

Cart rules:
- To add or remove ANY item you MUST actually call update_cart — never reply that you added/removed something without calling it. update_cart REPLACES the whole cart (it is not additive), so first call get_cart and send back the full merged item list, keeping the items you are not changing.
- Add the specific variant (spinId + skuId), not the parent product. If the user's message already contains a spinId/skuId, use those directly and skip re-searching.
- Never call checkout unless the user has explicitly confirmed the order in this chat. For Cash on Delivery, confirm first then paymentMethod="Cash"; for UPI, call get_payment_options first.
- Keep text replies short — product cards and the live cart show separately, so don't restate them in full.`;

// Address parameters are intentionally omitted from these schemas: the server
// injects the addressId, so the model shouldn't spend tokens producing it or
// risk getting it wrong.
const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "Search Instamart products. Returns products grouped with variants (spinId/skuId, size, price) plus a brandsAvailable summary. Add the specific variant to cart, not the parent product.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product name, category, or brand" },
          offset: { type: "number", description: "Pagination offset, default 0" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_choice",
      description:
        "Ask the user ONE short clarifying question with clickable options, when their request is a broad category spanning multiple brands or types. Call search_products first so the options are real (e.g. the brands that actually carry the item). Do NOT use when the user already named a specific product and size.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to show, e.g. 'Which brand of milk?'" },
          options: {
            type: "array",
            items: { type: "string" },
            description: "2-8 short option labels (e.g. brand names)",
          },
        },
        required: ["question", "options"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "present_products",
      description:
        "Show the user specific product variants as cards (photo, size, price, Add button) so they can pick which to add. Call after narrowing to a brand/type. Provide spinId and skuId (from search_products) for each; up to 6, most relevant or cheapest first.",
      parameters: {
        type: "object",
        properties: {
          intro: {
            type: "string",
            description: "One short line introducing the options, e.g. \"Here are Amul's milk options:\"",
          },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                spinId: { type: "string" },
                skuId: { type: "string" },
                note: { type: "string", description: "Optional one-line highlight" },
              },
              required: ["spinId", "skuId"],
            },
          },
        },
        required: ["intro", "items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cart",
      description: "Get the current Instamart cart with items and bill breakdown.",
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
      description: "Get the user's frequently/recently ordered items for quick reorder.",
      parameters: { type: "object", properties: { offset: { type: "number" } } },
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
// the full variant records are stashed here keyed by id, and present_products
// / the frontend join photos + price back by spinId. The model never handles
// image URLs.
// ---------------------------------------------------------------------------
const productBySpin = new Map();
const productBySku = new Map();

function cacheProducts(raw) {
  const products = Array.isArray(raw?.products) ? raw.products : [];
  // Keep the cache from growing without bound across a long session — it only
  // needs the current interaction's results, so a periodic reset is harmless.
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

function distinctBrands(raw) {
  const products = Array.isArray(raw?.products) ? raw.products : [];
  const seen = new Set();
  const brands = [];
  for (const p of products) {
    const b = p.brand || p.variations?.[0]?.brandName;
    if (b && !seen.has(b)) {
      seen.add(b);
      brands.push(b);
    }
  }
  return brands.slice(0, 10);
}

// Resolve the model's picked refs back to full cards (with photo + price) from
// the cache. Unknown ids are dropped so a hallucinated ref never renders.
function enrichProducts(items) {
  const out = [];
  for (const it of items || []) {
    const card = productBySpin.get(String(it.spinId)) || productBySku.get(String(it.skuId));
    if (!card) continue;
    out.push({ ...card, note: it.note || null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Token control: product-search results are the biggest sink. Strip heavy
// media/marketing fields and cap arrays before the compacted result goes into
// the transcript (re-sent every loop iteration). Defensive by field-name
// pattern; keeps scalar fields like spinId/skuId/displayName/brand/price.
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
  const brands = distinctBrands(raw);
  if (brands.length && compacted && typeof compacted === "object") {
    compacted.brandsAvailable = brands;
  }
  return compacted;
}

// executeTool is built per-request as a closure over the resolved addressId,
// which it injects into every tool call.
function makeExecuteTool(addressId) {
  return async (name, args) => {
    switch (name) {
      case "search_products": {
        const raw = await instamartClient.searchProducts({ ...args, addressId });
        cacheProducts(raw);
        return compactSearchResult(raw);
      }
      case "your_go_to_items": {
        const raw = await instamartClient.yourGoToItems({ ...args, addressId });
        cacheProducts(raw);
        return compactSearchResult(raw);
      }
      case "update_cart":
        return instamartClient.updateCart({ selectedAddressId: addressId, items: args.items });
      case "get_cart":
        return instamartClient.getCart();
      case "clear_cart":
        return instamartClient.clearCart();
      case "get_payment_options":
        return instamartClient.getPaymentOptions({ addressId });
      case "checkout":
        return instamartClient.checkout({ ...args, addressId });
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Two transcripts: `conversation` is what the LLM sees (compact, tool-shaped);
// `displayTranscript` is what the UI renders (rich choice/product messages).
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

// userText goes to the LLM; displayText is what the transcript shows the user
// (they differ when an Add-button click sends explicit ids to the model but a
// clean label to the transcript).
export async function sendMessage(userText, addressId, displayText = userText) {
  conversation.push({ role: "user", content: userText });
  displayTranscript.push({ role: "user", text: displayText });

  const { text, finalArgs, finalToolName, executedTools } = await runToolLoop({
    messages: conversation,
    tools: TOOLS,
    executeTool: makeExecuteTool(addressId),
    finalToolNames: FINAL_TOOLS,
    maxTokens: 1024,
  });

  let responsePayload;
  let assistantEntry;

  if (finalToolName === "ask_choice") {
    const question = finalArgs?.question || text || "Which one?";
    const options = Array.isArray(finalArgs?.options) ? finalArgs.options.filter(Boolean) : [];
    assistantEntry = { role: "assistant", type: "choice", question, options };
    responsePayload = { reply: text || "", choice: { question, options } };
  } else if (finalToolName === "present_products") {
    const products = enrichProducts(finalArgs?.items);
    const intro = finalArgs?.intro || text || "Here are some options:";
    if (products.length > 0) {
      assistantEntry = { role: "assistant", type: "products", intro, products };
      responsePayload = { reply: text || "", products: { intro, items: products } };
    } else {
      // Cache miss / bad refs — fall back to plain text rather than an empty grid.
      const fallback = text || "I couldn't pull those options up — mind trying again?";
      assistantEntry = { role: "assistant", text: fallback };
      responsePayload = { reply: fallback };
    }
  } else {
    const reply = text || "(no reply)";
    assistantEntry = { role: "assistant", text: reply };
    responsePayload = { reply };
  }

  displayTranscript.push(assistantEntry);
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

export function resetConversation() {
  conversation = [{ role: "system", content: SYSTEM_PROMPT }];
  displayTranscript = [];
}

export function getConversationForDisplay() {
  return displayTranscript;
}
