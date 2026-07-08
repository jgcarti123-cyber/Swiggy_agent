const first = (obj, keys) => {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
};

// fetch_food_coupons is documented narratively ("best coupons, more offers,
// payment offers with applicability status, discount amounts, terms") but
// every live call in this account returned `{}` (no active coupons), so
// there was no non-empty sample to confirm exact field names either. This
// scans plausible key variants and always keeps the raw payload attached so
// the UI can show the original terms text if a field wasn't recognized.
function candidateCoupons(payload) {
  if (!payload) return [];
  const lists = [
    first(payload, ["bestCoupons", "best_coupons"]),
    first(payload, ["moreOffers", "more_offers"]),
    first(payload, ["paymentOffers", "payment_offers"]),
    first(payload, ["coupons", "offers"]),
  ].filter(Array.isArray);
  return lists.flat();
}

export function pickBestCoupon(couponPayload) {
  const candidates = candidateCoupons(couponPayload);
  if (candidates.length === 0) return null;

  const parsed = candidates
    .map((c) => ({
      code: first(c, ["couponCode", "code"]),
      description: first(c, ["description", "title", "termsAndConditions", "terms"]),
      discountAmount: Number(first(c, ["discountAmount", "discount_amount", "amount"]) ?? 0),
      minOrderValue: first(c, ["minOrderValue", "min_order_value", "minOrderAmount"]),
      applicable: first(c, ["applicable", "isApplicable", "is_applicable"]) !== false,
      raw: c,
    }))
    .filter((c) => c.applicable);

  if (parsed.length === 0) return null;
  return parsed.reduce((best, c) => (c.discountAmount > best.discountAmount ? c : best));
}

export function computeEffectivePrice(basePrice, coupon) {
  if (!coupon || !(coupon.discountAmount > 0)) {
    return { effectivePrice: basePrice, appliedDiscount: 0 };
  }
  const effectivePrice = Math.max(0, basePrice - coupon.discountAmount);
  return { effectivePrice, appliedDiscount: coupon.discountAmount };
}
