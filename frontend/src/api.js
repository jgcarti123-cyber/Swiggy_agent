class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch {
    // fetch() itself throws for a genuine network-level failure — rare in
    // this app's setup (the frontend only ever calls same-origin /api paths,
    // proxied by Vite), but a real possibility outside dev (e.g. a build
    // hitting a different origin directly). Kept as a fallback alongside the
    // 502 case below, which is what an actually-down backend looks like here.
    throw new ApiError("Can't reach the backend — make sure it's running (npm run dev in the backend folder), then try again.", {
      status: 0,
    });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 || body?.error === "NEEDS_REAUTH") {
      throw new ApiError(body?.message || "Please re-authenticate with Swiggy", {
        status: 401,
        body,
      });
    }
    // The actual failure mode confirmed live: Vite's dev proxy returns a
    // plain 502 with a non-JSON body (so `body` is null here) when it can't
    // reach the backend on :8787 — the browser DID successfully reach Vite on
    // :5173, so fetch() itself never throws; this is what a down backend
    // looks like from here. Without this check, a "Clear cart" click while
    // the backend was down failed with the generic message below and no hint
    // of why — the click never even reached Swiggy, so the phone app's cart
    // correctly never changed, but nothing on screen explained that.
    if (body === null && [502, 503, 504].includes(res.status)) {
      throw new ApiError("Can't reach the backend — make sure it's running (npm run dev in the backend folder), then try again.", {
        status: res.status,
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

  // Per-item "Explain" popup: web-grounded Q&A about one product. `product`
  // is the same card data already rendered (spinId, skuId, displayName,
  // brand, quantityDescription, price); `history` is the running Q&A for
  // this modal session so far ({role, content}[]), sent back each question
  // so the model has context for follow-ups.
  instamartExplainItem: (product, question, history) =>
    request("/api/instamart/explain-item", {
      method: "POST",
      body: JSON.stringify({ ...product, question, history }),
    }),

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
