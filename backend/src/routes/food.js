import { Router } from "express";
import { foodClient } from "../mcp/foodClient.js";
import { getSavedAddress, saveAddress, cacheCoupons, getCachedCoupons, recordOrder } from "../db.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { pickBestCoupon, computeEffectivePrice } from "../food/normalize.js";
import { discoverRestaurantsForDish } from "../food/discoveryAgent.js";

export const foodRouter = Router();

const COUPON_FETCH_CONCURRENCY = 4; // stays under the documented ~4 req/s burst ceiling

foodRouter.get("/addresses", async (req, res) => {
  const page = Number(req.query.page || 1);
  const pageSize = Number(req.query.pageSize || 10);
  const result = await foodClient.getAddresses({ page, pageSize });
  res.json(result);
});

foodRouter.post("/address", (req, res) => {
  const { addressId, label, raw } = req.body;
  if (!addressId) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "addressId is required" });
    return;
  }
  saveAddress({ addressId, label, raw });
  res.json({ ok: true });
});

foodRouter.get("/address", (req, res) => {
  res.json(getSavedAddress());
});

foodRouter.get("/compare", async (req, res) => {
  const dish = String(req.query.dish || "").trim();
  if (!dish) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "dish query is required" });
    return;
  }

  const saved = getSavedAddress();
  if (!saved) {
    res
      .status(400)
      .json({ error: "NO_ADDRESS", message: "Select a delivery address before searching" });
    return;
  }

  // Unscoped search_menu (no restaurantIdOfAddedItem) — the mechanism
  // CLAUDE.md originally designed this around — was verified against the
  // live Swiggy MCP server to return zero results for every dish/address
  // tried. search_restaurants + scoped search_menu both work, so an agent
  // drives that path with judgment about which restaurants are worth
  // checking, rather than brute-force scanning every result.
  const discovery = await discoverRestaurantsForDish({ dish, addressId: saved.address_id });
  const restaurants = discovery.restaurants
    .filter((r) => r.availabilityStatus === "OPEN")
    .map((r) => ({
      restaurantId: r.restaurantId,
      restaurantName: r.restaurantName,
      availabilityStatus: r.availabilityStatus,
      distanceKm: r.distanceKm,
      deliveryTimeMinutes: r.deliveryTimeMinutes,
      rating: r.rating,
      items: [{ name: r.matchedItemName, price: Number(r.matchedItemPrice) || 0, isVeg: Boolean(r.isVeg) }],
    }));

  if (restaurants.length === 0) {
    res.json({ dish, addressId: saved.address_id, restaurants: [] });
    return;
  }

  const withCoupons = await mapWithConcurrency(
    restaurants,
    COUPON_FETCH_CONCURRENCY,
    async (restaurant) => {
      let couponPayload = getCachedCoupons(restaurant.restaurantId, saved.address_id);
      if (couponPayload === null) {
        try {
          couponPayload = await foodClient.fetchFoodCoupons({
            restaurantId: restaurant.restaurantId,
            addressId: saved.address_id,
          });
          cacheCoupons(restaurant.restaurantId, saved.address_id, couponPayload);
        } catch {
          couponPayload = null; // read-only lookup — a failure here just means "no coupon data"
        }
      }

      const bestCoupon = pickBestCoupon(couponPayload);
      const cheapestItem = restaurant.items.reduce(
        (min, item) => (min === null || item.price < min.price ? item : min),
        null
      );
      const basePrice = cheapestItem?.price ?? 0;
      const { effectivePrice, appliedDiscount } = computeEffectivePrice(basePrice, bestCoupon);

      return {
        restaurantId: restaurant.restaurantId,
        restaurantName: restaurant.restaurantName,
        availabilityStatus: restaurant.availabilityStatus,
        distanceKm: restaurant.distanceKm,
        deliveryTimeMinutes: restaurant.deliveryTimeMinutes,
        rating: restaurant.rating,
        matchedItem: cheapestItem,
        allMatchedItems: restaurant.items,
        coupon: bestCoupon
          ? {
              code: bestCoupon.code,
              description: bestCoupon.description,
              discountAmount: appliedDiscount,
              minOrderValue: bestCoupon.minOrderValue,
            }
          : null,
        basePrice,
        effectivePrice,
        estimated: true,
      };
    }
  );

  withCoupons.sort((a, b) => a.effectivePrice - b.effectivePrice);
  res.json({ dish, addressId: saved.address_id, restaurants: withCoupons });
});

// --- Cart-touching endpoints: only reached once the user clicks to order ---

foodRouter.post("/cart/add", async (req, res) => {
  const { restaurantId, cartItems, restaurantName } = req.body;
  const saved = getSavedAddress();
  if (!saved) {
    res.status(400).json({ error: "NO_ADDRESS", message: "Select a delivery address first" });
    return;
  }
  await foodClient.updateFoodCart({
    restaurantId,
    cartItems,
    addressId: saved.address_id,
    restaurantName,
  });
  // update_food_cart renders no widget of its own — always re-fetch the cart afterward.
  const cart = await foodClient.getFoodCart({ addressId: saved.address_id, restaurantName });
  res.json(cart);
});

foodRouter.get("/cart", async (req, res) => {
  const saved = getSavedAddress();
  if (!saved) {
    res.status(400).json({ error: "NO_ADDRESS", message: "Select a delivery address first" });
    return;
  }
  const cart = await foodClient.getFoodCart({
    addressId: saved.address_id,
    restaurantName: req.query.restaurantName,
  });
  res.json(cart);
});

foodRouter.post("/cart/apply-coupon", async (req, res) => {
  const { couponCode, cartId } = req.body;
  const saved = getSavedAddress();
  if (!saved) {
    res.status(400).json({ error: "NO_ADDRESS", message: "Select a delivery address first" });
    return;
  }
  const result = await foodClient.applyFoodCoupon({ couponCode, addressId: saved.address_id, cartId });
  res.json(result);
});

foodRouter.post("/cart/flush", async (req, res) => {
  const result = await foodClient.flushFoodCart();
  res.json(result);
});

foodRouter.post("/order", async (req, res) => {
  const { paymentMethod, intentApp, generateUPIQR } = req.body;
  const saved = getSavedAddress();
  if (!saved) {
    res.status(400).json({ error: "NO_ADDRESS", message: "Select a delivery address first" });
    return;
  }
  const result = await foodClient.placeFoodOrder({
    addressId: saved.address_id,
    paymentMethod,
    intentApp,
    generateUPIQR,
  });
  recordOrder({ domain: "food", orderId: result?.orderId, summary: result });
  res.json(result);
});

foodRouter.get("/order/:orderId/track", async (req, res) => {
  const result = await foodClient.trackFoodOrder({ orderId: req.params.orderId });
  res.json(result);
});
