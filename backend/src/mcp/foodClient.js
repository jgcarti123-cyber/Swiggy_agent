import { config } from "../config.js";
import { callSwiggyTool } from "./mcpClient.js";

const SERVER_URL = config.swiggy.foodServerUrl;
const call = (name, args) => callSwiggyTool(SERVER_URL, name, args);

export const foodClient = {
  getAddresses: ({ page = 1, pageSize = 10 } = {}) => call("get_addresses", { page, pageSize }),

  // Dish-level search. Omitting restaurantIdOfAddedItem searches across
  // restaurants near the address — this is the "find restaurants serving X" call.
  searchMenu: ({ addressId, query, restaurantIdOfAddedItem, vegFilter, offset = 0 }) =>
    call("search_menu", {
      addressId,
      query,
      ...(restaurantIdOfAddedItem ? { restaurantIdOfAddedItem } : {}),
      ...(vegFilter !== undefined ? { vegFilter } : {}),
      offset,
    }),

  searchRestaurants: ({ addressId, query, offset = 0 }) =>
    call("search_restaurants", { addressId, query, offset }),

  getRestaurantMenu: ({ addressId, restaurantId, page = 1, pageSize = 5 }) =>
    call("get_restaurant_menu", { addressId, restaurantId, page, pageSize }),

  // Read-only, no cart required — used to estimate price-after-coupon in parallel.
  fetchFoodCoupons: ({ restaurantId, addressId, couponCode }) =>
    call("fetch_food_coupons", { restaurantId, addressId, ...(couponCode ? { couponCode } : {}) }),

  applyFoodCoupon: ({ couponCode, addressId, cartId }) =>
    call("apply_food_coupon", { couponCode, addressId, ...(cartId ? { cartId } : {}) }),

  updateFoodCart: ({ restaurantId, cartItems, addressId, restaurantName }) =>
    call("update_food_cart", {
      restaurantId,
      cartItems,
      addressId,
      ...(restaurantName ? { restaurantName } : {}),
    }),

  getFoodCart: ({ addressId, restaurantName }) =>
    call("get_food_cart", { addressId, ...(restaurantName ? { restaurantName } : {}) }),

  placeFoodOrder: ({ addressId, paymentMethod, intentApp, generateUPIQR }) =>
    call("place_food_order", {
      addressId,
      ...(paymentMethod ? { paymentMethod } : {}),
      ...(intentApp ? { intentApp } : {}),
      ...(generateUPIQR !== undefined ? { generateUPIQR } : {}),
    }),

  trackFoodOrder: ({ orderId } = {}) => call("track_food_order", orderId ? { orderId } : {}),

  flushFoodCart: () => call("flush_food_cart", {}),

  reportError: (payload) => call("report_error", payload),
};
