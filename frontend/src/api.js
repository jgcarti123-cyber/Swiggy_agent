class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 || body?.error === "NEEDS_REAUTH") {
      throw new ApiError(body?.message || "Please re-authenticate with Swiggy", {
        status: 401,
        body,
      });
    }
    throw new ApiError(body?.message || `Request to ${path} failed`, { status: res.status, body });
  }
  return body;
}

export const api = {
  authStatus: () => request("/auth/status"),
  logout: () => request("/auth/logout", { method: "POST" }),

  foodAddresses: (page = 1) => request(`/api/food/addresses?page=${page}`),
  getSavedAddress: () => request("/api/food/address"),
  saveAddress: (addressId, label, raw) =>
    request("/api/food/address", { method: "POST", body: JSON.stringify({ addressId, label, raw }) }),
  compareDish: (dish, vegMode = "nonveg") =>
    request(`/api/food/compare?dish=${encodeURIComponent(dish)}&vegMode=${encodeURIComponent(vegMode)}`),
  couponCheck: (restaurantId, menuItemId, dish, restaurantName) =>
    request("/api/food/coupon-check", {
      method: "POST",
      body: JSON.stringify({ restaurantId, menuItemId, dish, restaurantName }),
    }),
  // Feaster cart. addToFoodCart takes { restaurantId, restaurantName,
  // dish, menuItemId, quantity?, confirmReplace? } and returns
  // { cart, added?, replaced?, needsConfirm?, currentRestaurantName?, error? }.
  addToFoodCart: (payload) =>
    request("/api/food/cart/add", { method: "POST", body: JSON.stringify(payload) }),
  getFoodCart: () => request("/api/food/cart"),
  setFoodCartQuantity: (menuItemId, quantity) =>
    request("/api/food/cart/set-quantity", {
      method: "POST",
      body: JSON.stringify({ menuItemId, quantity }),
    }),
  clearFoodCart: () => request("/api/food/cart/clear", { method: "POST" }),

  instamartCart: () => request("/api/instamart/cart"),
  instamartChatHistory: () => request("/api/instamart/chat/history"),
  instamartChatSend: (message) =>
    request("/api/instamart/chat", { method: "POST", body: JSON.stringify({ message }) }),
  instamartChatReset: () => request("/api/instamart/chat/reset", { method: "POST" }),

  // Deterministic actions — bypass the chat/LLM loop entirely for
  // interactions with only one correct outcome (see instamartAgent.js).
  instamartAddItem: (spinId, skuId, quantity, displayText) =>
    request("/api/instamart/add-item", { method: "POST", body: JSON.stringify({ spinId, skuId, quantity, displayText }) }),
  instamartShowMore: () => request("/api/instamart/show-more", { method: "POST" }),
  instamartClearCart: () => request("/api/instamart/clear-cart", { method: "POST" }),
  instamartReorderUsuals: () => request("/api/instamart/reorder-usuals", { method: "POST" }),
  instamartSetQuantity: (spinId, skuId, quantity) =>
    request("/api/instamart/set-quantity", { method: "POST", body: JSON.stringify({ spinId, skuId, quantity }) }),

  // Recipe flow: confirm the (edited) ingredient checklist, swap one pick.
  instamartRecipeConfirm: (dish, ingredients) =>
    request("/api/instamart/recipe-confirm", { method: "POST", body: JSON.stringify({ dish, ingredients }) }),
  instamartRecipeSwap: (payload) =>
    request("/api/instamart/recipe-swap", { method: "POST", body: JSON.stringify(payload) }),

  // Import-from-screenshot: send the image (+ optional caption that guides
  // extraction, e.g. "only get the snacks") for extraction, confirm the list.
  instamartImportImage: (image, note) =>
    request("/api/instamart/import-image", { method: "POST", body: JSON.stringify({ image, note }) }),
  instamartImportConfirm: (items) =>
    request("/api/instamart/import-confirm", { method: "POST", body: JSON.stringify({ items }) }),

  // Usuals (local editable reorder list) + daily auto-add schedule.
  instamartUsuals: () => request("/api/instamart/usuals"),
  instamartSaveUsual: (product) =>
    request("/api/instamart/usuals", { method: "POST", body: JSON.stringify(product) }),
  instamartRemoveUsual: (spinId, skuId) =>
    request("/api/instamart/usuals/remove", { method: "POST", body: JSON.stringify({ spinId, skuId }) }),
  instamartUsualsSchedule: () => request("/api/instamart/usuals/schedule"),
  instamartSetUsualsSchedule: (enabled, time) =>
    request("/api/instamart/usuals/schedule", { method: "PUT", body: JSON.stringify({ enabled, time }) }),
};

export { ApiError };
