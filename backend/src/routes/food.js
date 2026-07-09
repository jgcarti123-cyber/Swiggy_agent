import { Router } from "express";
import { foodClient } from "../mcp/foodClient.js";
import { getSavedAddress, saveAddress, recordOrder } from "../db.js";
import { discoverRestaurantsForDish } from "../food/discoveryAgent.js";
import { checkBestCoupon } from "../food/couponCheck.js";

export const foodRouter = Router();

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

const VEG_MODES = new Set(["veg", "nonveg", "all"]);

foodRouter.get("/compare", async (req, res) => {
  const dish = String(req.query.dish || "").trim();
  if (!dish) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "dish query is required" });
    return;
  }

  const vegMode = String(req.query.vegMode || "nonveg").trim();
  if (!VEG_MODES.has(vegMode)) {
    res
      .status(400)
      .json({ error: "VALIDATION_ERROR", message: "vegMode must be one of veg, nonveg, all" });
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
  // checking, rather than brute-force scanning every result. discoveryAgent
  // also applies the chosen veg filter and caps each restaurant at 6 items,
  // ranked by item rating.
  const discovery = await discoverRestaurantsForDish({ dish, addressId: saved.address_id, vegMode });

  if (discovery.restaurants.length === 0) {
    res.json({
      dish,
      addressId: saved.address_id,
      vegMode,
      restaurants: [],
      suggestedTerms: discovery.suggestedTerms || [],
    });
    return;
  }

  // Sorted by restaurant rating (highest first), ties broken by distance
  // (closest first). Coupons are NOT priced here: the read-only
  // fetch_food_coupons tool returns {} in the current beta, and the only way
  // to get a real coupon is to build a cart (single-restaurant, global,
  // destructive). That's done on demand per item via /coupon-check when the
  // user clicks, so the comparison itself stays fast and non-mutating.
  const ranked = [...discovery.restaurants].sort((a, b) => {
    const ratingDiff = (b.rating ?? -Infinity) - (a.rating ?? -Infinity);
    if (ratingDiff !== 0) return ratingDiff;
    return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
  });

  res.json({ dish, addressId: saved.address_id, vegMode, restaurants: ranked });
});

// On-demand best-coupon lookup for one specific menu item. Builds a
// throwaway cart to read the auto-applied coupon (fetch_food_coupons is
// non-functional in the beta), then flushes — see couponCheck.js. Only
// reached when the user explicitly clicks "check deal" on an item.
foodRouter.post("/coupon-check", async (req, res) => {
  const restaurantId = String(req.body?.restaurantId || "").trim();
  const dish = String(req.body?.dish || "").trim();
  const menuItemId = String(req.body?.menuItemId || "").trim();
  const restaurantName = req.body?.restaurantName;
  if (!restaurantId || !dish || !menuItemId) {
    res
      .status(400)
      .json({ error: "VALIDATION_ERROR", message: "restaurantId, dish, and menuItemId are required" });
    return;
  }
  const saved = getSavedAddress();
  if (!saved) {
    res.status(400).json({ error: "NO_ADDRESS", message: "Select a delivery address first" });
    return;
  }
  const result = await checkBestCoupon({
    restaurantId,
    dish,
    menuItemId,
    addressId: saved.address_id,
    restaurantName,
  });
  res.json(result);
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
