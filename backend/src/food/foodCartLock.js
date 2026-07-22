// A Swiggy food cart is single-restaurant AND global to the account (not
// scoped per session), so ANY two operations that touch it concurrently can
// clobber each other: two "add to cart" clicks, or an add racing a coupon
// check (which builds a throwaway cart and restores it — see couponCheck.js).
// Every cart-touching operation runs through this one serialized queue so they
// happen strictly one at a time, regardless of how fast the user clicks.
let queue = Promise.resolve();

export function withFoodCart(fn) {
  const run = queue.then(fn);
  // Keep the chain alive regardless of individual success/failure.
  queue = run.catch(() => {});
  return run;
}
