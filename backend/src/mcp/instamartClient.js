import { config } from "../config.js";
import { callSwiggyTool, SwiggyToolError } from "./mcpClient.js";

const SERVER_URL = config.swiggy.instamartServerUrl;
const call = (name, args) => callSwiggyTool(SERVER_URL, name, args);

// get_cart raises a SwiggyToolError ("Cart not found or session expired…")
// when there is simply no active cart — which, for this single-user local
// dashboard, just means nothing has been added yet. This tells that specific
// "no cart" case apart from real failures (auth/reauth, network), which must
// still propagate.
const EMPTY_CART_MESSAGE = /cart not found|session expired|cart is empty|no items|no active cart|empty cart/i;

export const instamartClient = {
  getAddresses: ({ page = 1, pageSize = 10 } = {}) => call("get_addresses", { page, pageSize }),

  searchProducts: ({ addressId, query, offset = 0 }) =>
    call("search_products", { addressId, query, offset }),

  // Replaces the ENTIRE cart — never additive. Callers must get_cart first,
  // merge, then send the full item list back.
  updateCart: ({ selectedAddressId, items }) => call("update_cart", { selectedAddressId, items }),

  getCart: () => call("get_cart", {}),

  // getCart, but "no cart yet" comes back as a normal empty cart instead of a
  // thrown tool error — so the UI shows "Cart is empty" rather than a scary
  // support/report-id message. Only the empty case is swallowed.
  getCartOrEmpty: async () => {
    try {
      return await call("get_cart", {});
    } catch (err) {
      if (err instanceof SwiggyToolError && EMPTY_CART_MESSAGE.test(err.message)) {
        return { items: [], empty: true };
      }
      throw err;
    }
  },

  clearCart: () => call("clear_cart", {}),

  yourGoToItems: ({ addressId, offset = 0 }) => call("your_go_to_items", { addressId, offset }),

  // Creates the order and confirms payment in one call — only on explicit user confirmation.
  checkout: ({ addressId, paymentMethod, intentApp, generateUPIQR }) =>
    call("checkout", {
      addressId,
      ...(paymentMethod ? { paymentMethod } : {}),
      ...(intentApp ? { intentApp } : {}),
      ...(generateUPIQR !== undefined ? { generateUPIQR } : {}),
    }),

  getOrders: ({ activeOnly, count, orderType } = {}) =>
    call("get_orders", {
      ...(activeOnly !== undefined ? { activeOnly } : {}),
      ...(count !== undefined ? { count } : {}),
      ...(orderType ? { orderType } : {}),
    }),

  trackOrder: ({ orderId, lat, lng }) => call("track_order", { orderId, lat, lng }),

  getPaymentOptions: ({ addressId } = {}) =>
    call("get_payment_options", addressId ? { addressId } : {}),

  checkPaymentStatus: ({ paasId, orderId, cartId, addressId, lat, lng, finalize }) =>
    call("check_payment_status", {
      paasId,
      ...(orderId ? { orderId } : {}),
      ...(cartId ? { cartId } : {}),
      ...(addressId ? { addressId } : {}),
      ...(lat !== undefined ? { lat } : {}),
      ...(lng !== undefined ? { lng } : {}),
      ...(finalize !== undefined ? { finalize } : {}),
    }),

  confirmOrder: ({ orderId, paasId, transactionId, addressId, lat, lng, cartId }) =>
    call("confirm_order", {
      orderId,
      ...(paasId ? { paasId } : {}),
      ...(transactionId ? { transactionId } : {}),
      ...(addressId ? { addressId } : {}),
      ...(lat !== undefined ? { lat } : {}),
      ...(lng !== undefined ? { lng } : {}),
      ...(cartId ? { cartId } : {}),
    }),

  getDeliveryStatus: ({ orderId, addressId }) => call("get_delivery_status", { orderId, addressId }),

  reportError: (payload) => call("report_error", payload),
};
