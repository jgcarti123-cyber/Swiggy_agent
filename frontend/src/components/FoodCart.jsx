import { useState } from "react";
import { api } from "../api.js";

// Live food cart shown inside Feast Finder. A Swiggy food cart is
// single-restaurant, so the header names that one restaurant. The +/- stepper
// and "Clear cart" push a fresh cart back up via onCartUpdate — plain cart
// edits, no dish search involved.
export function FoodCart({ cart, onCartUpdate }) {
  const [pendingId, setPendingId] = useState(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState(null);

  if (!cart || cart.empty || cart.items.length === 0) return null;

  async function changeQuantity(item, nextQty) {
    setPendingId(item.menuItemId);
    setError(null);
    try {
      const result = await api.setFoodCartQuantity(item.menuItemId, nextQty);
      if (result.error) setError(result.error);
      if (result.cart) onCartUpdate?.(result.cart);
    } catch (err) {
      setError(err.message || "Couldn't update the cart");
    } finally {
      setPendingId(null);
    }
  }

  async function clearCart() {
    setClearing(true);
    setError(null);
    try {
      const result = await api.clearFoodCart();
      if (result.cart) onCartUpdate?.(result.cart);
    } catch (err) {
      setError(err.message || "Couldn't clear the cart");
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="cart-summary food-cart">
      <div className="food-cart-head">
        <h3>Your cart</h3>
        {cart.restaurantName && <span className="food-cart-restaurant">{cart.restaurantName}</span>}
      </div>

      <ul className="cart-items">
        {cart.items.map((item) => {
          const isPending = pendingId === item.menuItemId;
          return (
            <li key={item.menuItemId} className="cart-item">
              {item.imageUrl ? (
                <img className="cart-item-thumb" src={item.imageUrl} alt={item.name} loading="lazy" />
              ) : (
                <span className="cart-item-thumb cart-item-thumb--empty" aria-hidden="true" />
              )}
              <div className="cart-item-info">
                <span className="cart-item-name">
                  <span
                    className={`veg-dot ${item.isVeg ? "veg-dot-veg" : "veg-dot-nonveg"}`}
                    title={item.isVeg ? "Veg" : "Non-veg"}
                    aria-label={item.isVeg ? "Veg" : "Non-veg"}
                  />
                  {item.name}
                </span>
                <span className="cart-item-meta">
                  <span className="qty-stepper">
                    <button
                      type="button"
                      className="qty-stepper-btn"
                      onClick={() => changeQuantity(item, item.quantity - 1)}
                      disabled={isPending || clearing}
                      aria-label={`Decrease ${item.name} quantity`}
                    >
                      −
                    </button>
                    <span className="qty-stepper-value">{item.quantity}</span>
                    <button
                      type="button"
                      className="qty-stepper-btn"
                      onClick={() => changeQuantity(item, item.quantity + 1)}
                      disabled={isPending || clearing}
                      aria-label={`Increase ${item.name} quantity`}
                    >
                      +
                    </button>
                  </span>
                  {item.price !== null && item.price !== undefined && (
                    <span className="cart-item-price">₹{item.price}</span>
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      {error && <p className="cart-item-error">{error}</p>}

      {cart.itemTotal !== null && cart.itemTotal !== undefined && (
        <p className="cart-total">
          <span>Total</span>
          <span>₹{cart.itemTotal}</span>
        </p>
      )}
      {cart.toPay !== null && cart.toPay !== undefined && cart.toPay !== cart.itemTotal && (
        <p className="food-cart-topay">
          ₹{cart.toPay} to pay
          {cart.freeDelivery ? " · free delivery" : ""}
          {cart.couponDiscount > 0 && cart.couponCode ? ` · ${cart.couponCode} −₹${cart.couponDiscount}` : ""}
          <span className="food-cart-topay-note"> incl. taxes &amp; delivery</span>
        </p>
      )}

      <div className="food-cart-actions">
        <button type="button" className="link-button" onClick={clearCart} disabled={clearing}>
          {clearing ? "Clearing…" : "Clear cart"}
        </button>
        <span className="food-cart-hint">Place the order in the Swiggy app.</span>
      </div>
    </div>
  );
}
