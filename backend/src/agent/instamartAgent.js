import { instamartClient } from "../mcp/instamartClient.js";
import { runToolLoop } from "./toolLoop.js";

// Tool calls that mutate the cart — after any of these fire during a turn,
// the live cart is re-fetched independently rather than trusting the
// model's own tool-call result or text summary.
const CART_TOUCHING_TOOLS = new Set(["update_cart", "checkout", "clear_cart"]);

const SYSTEM_PROMPT = `You are a grocery-ordering assistant for Swiggy Instamart, embedded in a personal single-user dashboard.
Use the attached tools to look up addresses, search products, manage the cart, and check out.

Rules:
- You need an addressId before searching products or touching the cart. Call get_addresses, show the user their saved addresses, and ask which one to use — do not guess or invent an addressId.
- update_cart REPLACES the entire cart — it is not additive. Before adding or removing an item, call get_cart first and send back the full merged item list, not just the new item.
- Never call checkout unless the user has explicitly confirmed in this conversation that they want to place the order.
- For Cash on Delivery, confirm with the user first, then pass paymentMethod="Cash". For UPI, call get_payment_options first so the user can pick a method.
- Keep replies short — the UI shows the live cart separately, so don't re-describe it in full each turn.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_addresses",
      description: "Get the user's saved delivery addresses, most recently used first.",
      parameters: {
        type: "object",
        properties: {
          page: { type: "number", description: "Page number, default 1" },
          pageSize: { type: "number", description: "Results per page, default 10, max 10" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "Search Instamart products at the given address. Returns products with variants (spinId/skuId) — add the specific variant to cart, not the parent product.",
      parameters: {
        type: "object",
        properties: {
          addressId: { type: "string", description: "From get_addresses" },
          query: { type: "string", description: "Product name, category, or brand" },
          offset: { type: "number", description: "Pagination offset, default 0" },
        },
        required: ["addressId", "query"],
      },
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
          selectedAddressId: { type: "string" },
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
        required: ["selectedAddressId", "items"],
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
        properties: {
          addressId: { type: "string" },
          offset: { type: "number" },
        },
        required: ["addressId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_payment_options",
      description: "Get live payment methods (UPI apps, Cash on Delivery) available for the current cart.",
      parameters: {
        type: "object",
        properties: { addressId: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "checkout",
      description:
        "Place the Instamart order and confirm payment. Only call after explicit user confirmation of items, address, and payment method.",
      parameters: {
        type: "object",
        properties: {
          addressId: { type: "string" },
          paymentMethod: { type: "string", description: "\"UPI\", \"Cash\", or \"SwiggyPay\"" },
          intentApp: { type: "string", description: "UPI app id, only with paymentMethod=UPI" },
          generateUPIQR: { type: "boolean" },
        },
        required: ["addressId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_orders",
      description: "Get Instamart order history from the last 15 days.",
      parameters: {
        type: "object",
        properties: {
          activeOnly: { type: "boolean" },
          count: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "track_order",
      description: "Track a specific Instamart order's real-time status.",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          lat: { type: "number" },
          lng: { type: "number" },
        },
        required: ["orderId", "lat", "lng"],
      },
    },
  },
];

async function executeTool(name, args) {
  switch (name) {
    case "get_addresses":
      return instamartClient.getAddresses(args);
    case "search_products":
      return instamartClient.searchProducts(args);
    case "update_cart":
      return instamartClient.updateCart(args);
    case "get_cart":
      return instamartClient.getCart();
    case "clear_cart":
      return instamartClient.clearCart();
    case "your_go_to_items":
      return instamartClient.yourGoToItems(args);
    case "get_payment_options":
      return instamartClient.getPaymentOptions(args);
    case "checkout":
      return instamartClient.checkout(args);
    case "get_orders":
      return instamartClient.getOrders(args);
    case "track_order":
      return instamartClient.trackOrder(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// In-memory, single-user conversation. No persistence across server
// restarts by design — this is a local personal tool, not a multi-user app.
let conversation = [{ role: "system", content: SYSTEM_PROMPT }];

export async function sendMessage(userText) {
  conversation.push({ role: "user", content: userText });

  const { text, executedTools } = await runToolLoop({
    messages: conversation,
    tools: TOOLS,
    executeTool,
  });

  let liveCart = null;
  if (executedTools.some((t) => CART_TOUCHING_TOOLS.has(t.name))) {
    // Re-fetch server-side rather than trust the model's own tool result —
    // per CLAUDE.md, the rendered cart must reflect real cart state.
    try {
      liveCart = await instamartClient.getCart();
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
