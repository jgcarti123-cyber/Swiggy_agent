import { foodClient } from "../mcp/foodClient.js";
import { withFoodCart } from "./foodCartLock.js";
import { normalizeFoodCart, toCartItem } from "./foodCart.js";
import { getFoodCartMeta, setFoodCartMeta, clearFoodCartMeta } from "../db.js";
import { NeedsReauthError } from "../auth/oauthClient.js";

// fetch_food_coupons returns {} in the current Swiggy MCP beta (verified live —
// empty with or without a cart, even for a specific couponCode). Coupons only
// surface through the cart's `offers` field: building a cart makes Swiggy
// auto-suggest the single best coupon, and applying it yields the real
// discount. So to price the best coupon for one item we build a throwaway
// cart with just that item, read the coupon, then RESTORE whatever cart was
// there before (see below).
//
// Food carts are single-restaurant and global, so this shares the one
// withFoodCart queue with the add-to-cart flow — a coupon check and a cart add
// can never run interleaved and clobber each other.

export function checkBestCoupon(params) {
  return withFoodCart(() => checkBestCouponInner(params));
}

async function checkBestCouponInner({ restaurantId, dish, menuItemId, addressId, restaurantName }) {
  // Snapshot whatever cart the user already has, so the throwaway probe cart
  // below can be undone. Feaster now keeps a real, persistent food cart
  // (the "Add to cart" feature) — an earlier version blindly flushed here,
  // which would silently wipe a cart the user had just built simply for
  // checking a coupon on another dish. Empty cart → nothing to restore.
  const savedMeta = getFoodCartMeta();
  const saved = await readCartSafe(addressId);

  // Re-search rather than trust a stale menuItemId from an earlier discovery
  // call — price/stock can change between when the comparison loaded and
  // when the user clicks "check deal".
  const menu = await foodClient.searchMenu({
    addressId,
    query: dish,
    restaurantIdOfAddedItem: restaurantId,
  });
  const items = Array.isArray(menu?.items) ? menu.items : [];
  const target = items.find((i) => String(i.menu_item_id) === menuItemId && i.inStock !== 0);
  if (!target) {
    await restoreCart({ saved, savedMeta, addressId });
    return { available: false, reason: "This item is no longer available here." };
  }

  const cartItems = [toCartItem(target)];

  try {
    const updated = await foodClient.updateFoodCart({
      restaurantId,
      cartItems,
      addressId,
      restaurantName,
    });
    const suggested = updated?.data?.offers?.coupon_applied || null;

    // update_food_cart reports the best coupon but with discount 0 (auto-
    // suggested, not applied). Apply it, then re-read the cart for the real
    // discount + to_pay.
    let cart = updated;
    if (suggested) {
      await foodClient.applyFoodCoupon({ couponCode: suggested, addressId });
      cart = await foodClient.getFoodCart({ addressId, restaurantName });
    }

    const offers = cart?.data?.offers || {};
    const pricing = cart?.data?.pricing || {};
    const discount = Number(offers.coupon_discount) || 0;

    return {
      available: true,
      itemName: target.name,
      itemPrice: target.price,
      itemTotal: pricing.item_total ?? target.price,
      toPay: pricing.to_pay ?? null,
      // The best coupon Swiggy surfaced for this cart. `applied` is true only
      // when it actually reduced the price (discount > 0); otherwise it's a
      // coupon that needs a higher order value than this single item.
      couponCode: suggested,
      couponDiscount: discount,
      applied: discount > 0,
      freeDelivery: Boolean(offers.free_delivery_applied),
    };
  } finally {
    // Put the user's original cart back exactly as it was (or flush the probe
    // if there was no cart to begin with).
    await restoreCart({ saved, savedMeta, addressId });
  }
}

async function readCartSafe(addressId) {
  try {
    return normalizeFoodCart(await foodClient.getFoodCart({ addressId }));
  } catch (err) {
    if (err instanceof NeedsReauthError) throw err;
    return { empty: true, items: [], restaurantId: null, restaurantName: null };
  }
}

// Restore the snapshotted cart after a probe. Same-restaurant lines are rebuilt
// as {menu_item_id, quantity} (variant recovery isn't worth a re-search on the
// restore path — the probe only ever displaced them briefly). If nothing was
// saved, flush the probe cart.
async function restoreCart({ saved, savedMeta, addressId }) {
  try {
    if (!saved || saved.empty || !savedMeta.restaurantId) {
      await foodClient.flushFoodCart().catch(() => {});
      // Only clear meta if there was genuinely nothing to restore.
      if (!saved || saved.empty) clearFoodCartMeta();
      return;
    }
    const cartItems = saved.items.map((i) => ({ menu_item_id: String(i.menuItemId), quantity: i.quantity }));
    await foodClient.updateFoodCart({
      restaurantId: savedMeta.restaurantId,
      cartItems,
      addressId,
      restaurantName: savedMeta.restaurantName,
    });
    setFoodCartMeta(savedMeta);
  } catch {
    // Best-effort restore; never let cleanup throw out of the coupon check.
  }
}
