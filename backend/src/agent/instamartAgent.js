import { instamartClient } from "../mcp/instamartClient.js";
import { runToolLoop } from "./toolLoop.js";

// Tool calls that mutate the cart — after any of these fire during a turn,
// the live cart is re-fetched independently rather than trusting the
// model's own tool-call result or text summary.
const CART_TOUCHING_TOOLS = new Set(["update_cart", "checkout", "clear_cart"]);

// The delivery addressId is resolved server-side (from the saved address the
// user picked in the UI) and injected into every tool call — the model never
// sees, asks for, or reasons about an address. That removes an entire
// get_addresses round-trip plus the large address-list JSON from the token
// budget, and guarantees the right address is always used.
const SYSTEM_PROMPT = `You are Pantry Pal, a grocery assistant for Swiggy Instamart in a single-user dashboard. The delivery address is already set — never ask for it; it is added to every tool call automatically.

Rules:
- update_cart REPLACES the whole cart (it is not additive). Before adding or removing an item, call get_cart and send back the full merged item list, keeping the items you are not changing.
- From search_products, add the specific variant (spinId + skuId), not the parent product.
- Never call checkout unless the user has explicitly confirmed the order in this chat. For Cash on Delivery, confirm first then paymentMethod="Cash"; for UPI, call get_payment_options first so the user can pick.
- Keep replies short — the live cart is shown separately, so don't restate it in full.`;

// Address parameters are intentionally omitted from these schemas: the server
// injects the addressId, so the model shouldn't spend tokens producing it or
// risk getting it wrong.
const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "Search Instamart products. Returns products with variants (spinId/skuId) — add the specific variant to cart, not the parent product.",
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
      parameters: {
        type: "object",
        properties: { offset: { type: "number" } },
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

// Product-search and go-to results are the biggest token sink — full listings
// with images, descriptions, marketing widgets, and dozens of variants, all
// re-sent every loop iteration. The model only needs a few top matches with
// the ids, name, and price to add to cart. Swiggy's exact product shape isn't
// documented, so this trims defensively by field-name pattern: it keeps scalar
// fields like spinId/skuId/name/price and only drops heavy media/marketing
// fields and over-long arrays/strings.
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

function compactProductResult(result) {
  let compacted = compactForModel(result, 6);
  // Hard ceiling: if it's somehow still huge, cut arrays down further.
  if (JSON.stringify(compacted).length > 6000) compacted = compactForModel(result, 3);
  return compacted;
}

// executeTool is built per-request as a closure over the resolved addressId,
// which it injects into every tool call — see the SYSTEM_PROMPT note.
function makeExecuteTool(addressId) {
  return async (name, args) => {
    switch (name) {
      case "search_products":
        return compactProductResult(await instamartClient.searchProducts({ ...args, addressId }));
      case "your_go_to_items":
        return compactProductResult(await instamartClient.yourGoToItems({ ...args, addressId }));
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

// In-memory, single-user conversation. No persistence across server
// restarts by design — this is a local personal tool, not a multi-user app.
let conversation = [{ role: "system", content: SYSTEM_PROMPT }];

// Keep the transcript (and therefore the per-request token cost) bounded.
// Trimming only ever happens at a user-message boundary — a user turn never
// has a pending tool_call before it, so the kept suffix always has valid
// assistant→tool pairing for the Groq API.
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
}

export async function sendMessage(userText, addressId) {
  conversation.push({ role: "user", content: userText });

  const { text, executedTools } = await runToolLoop({
    messages: conversation,
    tools: TOOLS,
    executeTool: makeExecuteTool(addressId),
    maxTokens: 1024,
  });

  trimConversation();

  let liveCart = null;
  if (executedTools.some((t) => CART_TOUCHING_TOOLS.has(t.name))) {
    // Re-fetch server-side rather than trust the model's own tool result —
    // per CLAUDE.md, the rendered cart must reflect real cart state. An empty
    // cart comes back as { items: [] }, not an error.
    try {
      liveCart = await instamartClient.getCartOrEmpty();
    } catch (err) {
      liveCart = { error: err.message };
    }
  }

  return { reply: text, toolCalls: executedTools, cart: liveCart };
}

export function resetConversation() {
  conversation = [{ role: "system", content: SYSTEM_PROMPT }];
}

export function getConversationForDisplay() {
  return conversation
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 0)
    .map((m) => ({ role: m.role, text: m.content }));
}
