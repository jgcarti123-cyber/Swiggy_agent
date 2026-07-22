import { foodClient } from "../mcp/foodClient.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { NeedsReauthError } from "../auth/oauthClient.js";
import { getFoodCartMeta, setFoodCartMeta, clearFoodCartMeta } from "../db.js";
import { withFoodCart } from "./foodCartLock.js";

// --- Shape helpers, all against the LIVE get_food_cart response verified in
// this repo: { statusCode, statusMessage, data: { cart_id, items[], item_count,
// pricing:{item_total,to_pay,...}, offers:{coupon_applied,coupon_discount,...},
// restaurant:{deliverySubtitle} } }. Each item is { menu_item_id (number),
// name, imageUrl, quantity, is_veg ("1"=veg,"2"=non-veg), subtotal,
// final_price, in_stock, variants[] }. Notably there is NO restaurantId/name
// anywhere in the response — hence the food_cart_meta row. mcpClient already
// unwraps Swiggy's {success,data} envelope, but this response uses
// statusCode/statusMessage (not success), so cartData also handles the case
// where an outer envelope did or didn't get stripped. ---

function cartData(raw) {
  if (!raw || typeof raw !== "object") return {};
  if (Array.isArray(raw.items) || raw.pricing) return raw;
  if (raw.data && (Array.isArray(raw.data.items) || raw.data.pricing)) return raw.data;
  if (raw.data?.data && (Array.isArray(raw.data.data.items) || raw.data.data.pricing)) return raw.data.data;
  return raw.data || raw;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalized, frontend-facing cart view. restaurantId/name come from the meta
// row (the response has none). Returns an explicit empty view when there are no
// items so every caller renders "empty" the same way.
export function normalizeFoodCart(raw, meta = getFoodCartMeta()) {
  const d = cartData(raw);
  const rawItems = Array.isArray(d.items) ? d.items : [];
  const items = rawItems.map((it) => ({
    menuItemId: String(it.menu_item_id ?? it.menuItemId ?? it.id ?? ""),
    name: it.name ?? it.itemName ?? "Item",
    quantity: num(it.quantity ?? it.qty) ?? 1,
    price: num(it.final_price ?? it.subtotal ?? it.total ?? it.price),
    imageUrl: it.imageUrl || it.image || null,
    isVeg: String(it.is_veg ?? it.isVeg ?? "") === "1",
    hasVariants: Array.isArray(it.variants) && it.variants.length > 0,
  }));
  const pricing = d.pricing || {};
  const offers = d.offers || {};
  return {
    empty: items.length === 0,
    restaurantId: meta.restaurantId || null,
    restaurantName: meta.restaurantName || null,
    items,
    itemTotal: num(pricing.item_total),
    toPay: num(pricing.to_pay),
    deliveryCharge: num(pricing.delivery_charge),
    couponCode: offers.coupon_applied || null,
    couponDiscount: num(offers.coupon_discount) || 0,
    freeDelivery: Boolean(offers.free_delivery_applied),
  };
}

const EMPTY_VIEW = () => ({
  empty: true,
  restaurantId: null,
  restaurantName: null,
  items: [],
  itemTotal: null,
  toPay: null,
  deliveryCharge: null,
  couponCode: null,
  couponDiscount: 0,
  freeDelivery: false,
});

// get_food_cart throws a tool error ("Cart not found or session expired...")
// for an empty cart rather than returning an empty list — the whole app treats
// that as a normal empty cart, not an error. A real auth failure is a
// different type (NeedsReauthError) and must still propagate.
async function readCart(addressId) {
  try {
    const raw = await foodClient.getFoodCart({ addressId });
    return normalizeFoodCart(raw);
  } catch (err) {
    if (err instanceof NeedsReauthError) throw err;
    return EMPTY_VIEW();
  }
}

// Build an update_food_cart entry from a scoped search_menu item, selecting the
// default (or first) variation for items that have variantsV2. Shared with
// couponCheck.js so both build cart items identically.
export function toCartItem(item, quantity = 1) {
  const entry = { menu_item_id: String(item.menu_item_id), quantity };
  if (Array.isArray(item.variantsV2) && item.variantsV2.length > 0) {
    entry.variantsV2 = item.variantsV2
      .map((group) => {
        const variations = Array.isArray(group.variations) ? group.variations : [];
        const chosen = variations.find((v) => v.default) || variations[0];
        if (!chosen) return null;
        return { group_id: String(group.groupId ?? group.group_id), variation_id: String(chosen.id) };
      })
      .filter(Boolean);
  }
  return entry;
}

// Scoped search at one restaurant, find a specific item by id (fallback: exact
// name). Re-searching rather than trusting a possibly-stale id/price from an
// earlier discovery render — same reasoning as couponCheck.
async function findMenuItem({ addressId, restaurantId, query, menuItemId, name }) {
  const menu = await foodClient.searchMenu({ addressId, query, restaurantIdOfAddedItem: restaurantId });
  const items = Array.isArray(menu?.items) ? menu.items : [];
  const byId = menuItemId
    ? items.find((i) => String(i.menu_item_id) === String(menuItemId) && i.inStock !== 0)
    : null;
  if (byId) return byId;
  if (name) {
    const byName = items.find((i) => i.name?.toLowerCase() === name.toLowerCase() && i.inStock !== 0);
    if (byName) return byName;
  }
  return null;
}

// Rebuild an update_food_cart entry for an item ALREADY in the cart. The common
// case (no variants) is a trivial {menu_item_id, quantity}. Only variant-
// bearing lines need a re-search to recover their variantsV2 faithfully (the
// cart response's `variants` shape isn't the same as update_food_cart's input),
// so the extra search is spent only when actually necessary.
async function reconstructLine(line, { addressId, restaurantId }) {
  const base = { menu_item_id: String(line.menuItemId), quantity: line.quantity };
  if (!line.hasVariants) return base;
  try {
    const found = await findMenuItem({
      addressId,
      restaurantId,
      query: line.name,
      menuItemId: line.menuItemId,
      name: line.name,
    });
    return found ? toCartItem(found, line.quantity) : base;
  } catch {
    return base;
  }
}

function reconstructItems(items, ctx) {
  return mapWithConcurrency(items, 4, (line) => reconstructLine(line, ctx));
}

// Write the full desired item set, then RE-READ and verify it actually landed —
// update_food_cart renders no widget and (confirmed on the Instamart sibling
// tool) can even silently drop an item on a non-throwing success, so a reply is
// never built from call-success alone. Retries the write once if the target id
// is missing. Returns the freshly-read, normalized cart.
async function writeCartAndVerify({ restaurantId, restaurantName, cartItems, addressId, expectId }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await foodClient.updateFoodCart({ restaurantId, cartItems, addressId, restaurantName });
    const view = await readCart(addressId);
    if (!expectId || view.items.some((i) => i.menuItemId === String(expectId))) {
      return view;
    }
  }
  return readCart(addressId);
}

// Add one dish to the food cart.
//  - Same restaurant (or empty cart): merge — bump the line if the dish is
//    already there, else append; send the full merged set (update_food_cart is
//    replace-semantics, mirroring the Instamart update_cart sibling and the
//    order-food recipe's "pass all items in one call").
//  - Different restaurant: adding would silently flush the old cart (Swiggy is
//    single-restaurant), so unless confirmReplace is set, return needsConfirm
//    with the current restaurant name instead of mutating anything.
export function addDishToCart(params) {
  return withFoodCart(() => addDishToCartInner(params));
}

async function addDishToCartInner({
  addressId,
  restaurantId,
  restaurantName,
  dish,
  menuItemId,
  quantity = 1,
  confirmReplace = false,
}) {
  const current = await readCart(addressId);

  // Cart has items from a DIFFERENT (or unknown, pre-existing) restaurant.
  const differentRestaurant =
    !current.empty && (!current.restaurantId || String(current.restaurantId) !== String(restaurantId));
  if (differentRestaurant && !confirmReplace) {
    return { needsConfirm: true, currentRestaurantName: current.restaurantName, cart: current };
  }

  const target = await findMenuItem({ addressId, restaurantId, query: dish, menuItemId });
  if (!target) {
    return { error: "This dish is no longer available at that restaurant.", cart: current };
  }

  const sameRestaurant =
    !current.empty && current.restaurantId && String(current.restaurantId) === String(restaurantId);

  let cartItems;
  if (sameRestaurant) {
    const existing = await reconstructItems(current.items, { addressId, restaurantId });
    const match = existing.find((e) => e.menu_item_id === String(menuItemId));
    if (match) {
      match.quantity += quantity; // bump the existing line
      cartItems = existing;
    } else {
      cartItems = [...existing, toCartItem(target, quantity)];
    }
  } else {
    // Empty cart, or a confirmed replace of a different restaurant.
    cartItems = [toCartItem(target, quantity)];
  }

  const view = await writeCartAndVerify({
    restaurantId,
    restaurantName,
    cartItems,
    addressId,
    expectId: menuItemId,
  });
  setFoodCartMeta({ restaurantId, restaurantName });

  const added = view.items.some((i) => i.menuItemId === String(menuItemId));
  return {
    cart: view,
    added,
    replaced: differentRestaurant && confirmReplace,
    ...(added ? {} : { error: "Swiggy didn't accept that item — it may be unavailable right now." }),
  };
}

// Set an existing line's quantity (used by the cart's +/- stepper). quantity<=0
// removes it; removing the last item goes through flush_food_cart, because
// update_food_cart rejects an empty items array (confirmed on the Instamart
// sibling; treated as the same constraint here).
export function setDishQuantity(params) {
  return withFoodCart(() => setDishQuantityInner(params));
}

async function setDishQuantityInner({ addressId, menuItemId, quantity }) {
  const current = await readCart(addressId);
  if (current.empty) return { cart: current };

  const meta = getFoodCartMeta();
  const restaurantId = current.restaurantId || meta.restaurantId;
  const restaurantName = current.restaurantName || meta.restaurantName;

  const line = current.items.find((i) => i.menuItemId === String(menuItemId));
  if (!line) return { cart: current };

  const remaining = current.items.filter((i) => i.menuItemId !== String(menuItemId));

  // Removing the only item → flush (can't send an empty cart).
  if (quantity <= 0 && remaining.length === 0) {
    await foodClient.flushFoodCart().catch(() => {});
    clearFoodCartMeta();
    return { cart: EMPTY_VIEW() };
  }

  if (!restaurantId) {
    // Shouldn't happen for an app-built cart, but never guess a restaurant id.
    return { cart: current, error: "Can't adjust this cart — its restaurant is unknown. Clear it and re-add." };
  }

  const kept = await reconstructItems(remaining, { addressId, restaurantId });
  let cartItems = kept;
  if (quantity > 0) {
    const [rebuilt] = await reconstructItems([{ ...line, quantity }], { addressId, restaurantId });
    cartItems = [...kept, rebuilt];
  }

  const view = await writeCartAndVerify({ restaurantId, restaurantName, cartItems, addressId });
  setFoodCartMeta({ restaurantId, restaurantName });
  return { cart: view };
}

export function clearFoodCart() {
  return withFoodCart(async () => {
    await foodClient.flushFoodCart().catch(() => {});
    clearFoodCartMeta();
    return { cart: EMPTY_VIEW() };
  });
}

export function getFoodCartView({ addressId }) {
  return withFoodCart(() => readCart(addressId));
}
