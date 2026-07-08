import { foodClient } from "../mcp/foodClient.js";

// fetch_food_coupons returns {} in the current Swiggy MCP beta (verified live —
// empty with or without a cart, even for a specific couponCode). Coupons only
// surface through the cart's `offers` field: building a cart makes Swiggy
// auto-suggest the single best coupon, and applying it yields the real
// discount. So to price the best coupon for one item we build a throwaway
// cart with just that item, read the coupon, then flush.
//
// Food carts are single-restaurant and global, so two of these running at once
// would clobber each other's cart — serialize with a simple promise chain.
let queue = Promise.resolve();

export function checkBestCoupon(params) {
  const run = queue.then(() => checkBestCouponInner(params));
  // Keep the chain alive regardless of individual success/failure.
  queue = run.catch(() => {});
  return run;
}

async function checkBestCouponInner({ restaurantId, dish, menuItemId, addressId, restaurantName }) {
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
    // Always clean up — this app keeps no persistent food cart.
    await foodClient.flushFoodCart().catch(() => {});
  }
}

// Build an update_food_cart entry from a scoped search_menu item, selecting the
// default (or first) variation for items that have variantsV2.
function toCartItem(item) {
  const entry = { menu_item_id: String(item.menu_item_id), quantity: 1 };
  if (Array.isArray(item.variantsV2) && item.variantsV2.length > 0) {
    entry.variantsV2 = item.variantsV2
      .map((group) => {
        const variations = Array.isArray(group.variations) ? group.variations : [];
        const chosen = variations.find((v) => v.default) || variations[0];
        if (!chosen) return null;
        return {
          group_id: String(group.groupId ?? group.group_id),
          variation_id: String(chosen.id),
        };
      })
      .filter(Boolean);
  }
  return entry;
}
