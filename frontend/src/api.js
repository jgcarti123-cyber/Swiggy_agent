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
  compareDish: (dish) => request(`/api/food/compare?dish=${encodeURIComponent(dish)}`),
  addToFoodCart: (payload) =>
    request("/api/food/cart/add", { method: "POST", body: JSON.stringify(payload) }),
  getFoodCart: () => request("/api/food/cart"),

  instamartCart: () => request("/api/instamart/cart"),
  instamartChatHistory: () => request("/api/instamart/chat/history"),
  instamartChatSend: (message) =>
    request("/api/instamart/chat", { method: "POST", body: JSON.stringify({ message }) }),
  instamartChatReset: () => request("/api/instamart/chat/reset", { method: "POST" }),
};

export { ApiError };
