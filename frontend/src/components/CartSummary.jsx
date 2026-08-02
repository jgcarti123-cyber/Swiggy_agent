import { useState } from "react";
import { api } from "../api.js";
import { ProductThumb } from "./ProductThumb.jsx";

function first(obj, keys) {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

// Field names confirmed against a live get_cart response (items[] with
// itemName / quantity / mrp / discountedFinalPrice / imageUrl / spinId /
// skuId, plus cartTotalAmount and billBreakdown.toPay). Fallback key-name
// variants are kept so an unexpected shape still renders rather than hiding
// real data.
function normalizeCart(cart) {
  const items = first(cart, ["items", "cartItems", "products"]);
  if (!Array.isArray(items)) return null;
  return {
    items: items.map((item) => ({
      name: first(item, ["itemName", "name", "displayName"]),
      quantity: first(item, ["quantity", "qty"]) ?? 1,
      price: first(item, ["discountedFinalPrice", "offerPrice", "price", "totalPrice"]),
      mrp: first(item, ["mrp"]),
      imageUrl: first(item, ["imageUrl", "image", "img"]) || null,
      spinId: first(item, ["spinId"]) || null,
      skuId: first(item, ["skuId"]) || null,
    })),
    total:
      first(cart, ["cartTotalAmount", "total", "grandTotal", "payableAmount"]) ??
      first(cart.billBreakdown?.toPay ?? cart.billDetails ?? cart.bill ?? {}, ["value", "grandTotal", "total"]),
  };
}

// A second, separate address line was tried here (showing whatever address
// Swiggy's own get_cart reported) to catch this app's saved address drifting
// away from the account's actual selected one. Removed now that the real fix
// landed one layer down: every cart-touching call re-asserts this app's own
// saved address on the write itself (see instamartClient.js's updateCart doc
// comment), so the two can no longer disagree after any action this app
// performs — a second address line would just be redundant with the "Delivering
// to:" header above, not a safety net.
function EmptyCart({ label = "Your cart is empty" }) {
  return (
    <div className="cart-summary">
      <h3>Cart</h3>
      <div className="cart-empty-state">
        <span className="cart-empty-icon" aria-hidden="true">🛒</span>
        <p className="muted">{label}</p>
        <p className="cart-empty-hint">Ask Insta-nt to add something.</p>
      </div>
    </div>
  );
}

// Prices come back either as numbers (26) or pre-formatted strings ("₹153").
function money(value) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : `₹${value}`;
}

// onCartUpdate lets the stepper push a fresh cart up to the parent after a
// mutation, without going through the chat pipeline — a +/- click is a plain
// cart edit, not a chat event (see setItemQuantity on the backend).
//
// onMutate wraps that write in the parent's cart mutation guard. It matters
// here more than anywhere else: because this path deliberately skips the chat
// pipeline, it also skipped the `sending` flag the cart poller used to check,
// leaving the stepper completely unprotected — a background read in flight
// during the write would land afterwards and repaint the old quantity, which
// read as the change silently reverting a few seconds later. Defaulted so the
// component still works standalone, but InstamartChat always passes it.
export function CartSummary({ cart, onCartUpdate, onMutate = (fn) => fn() }) {
  const [pendingKey, setPendingKey] = useState(null);
  const [itemError, setItemError] = useState(null); // { key, message } | null

  async function changeQuantity(item, delta) {
    if (!item.spinId || !item.skuId) return;
    const key = `${item.spinId}:${item.skuId}`;
    setPendingKey(key);
    setItemError(null);
    try {
      const result = await onMutate(() =>
        api.instamartSetQuantity(item.spinId, item.skuId, item.quantity + delta)
      );
      if (result.error) setItemError({ key, message: result.error });
      if (result.cart) onCartUpdate?.(result.cart);
    } catch (err) {
      setItemError({ key, message: err.message || "Couldn't update quantity" });
    } finally {
      setPendingKey(null);
    }
  }

  if (!cart) return <EmptyCart label="No cart activity yet" />;

  if (cart.error) {
    return (
      <div className="cart-summary">
        <h3>Cart</h3>
        <p className="muted">Couldn't load your cart right now. Try again in a moment.</p>
      </div>
    );
  }

  const normalized = normalizeCart(cart);

  if (normalized && normalized.items.length === 0) return <EmptyCart />;

  return (
    <div className="cart-summary">
      <h3>Cart (live)</h3>
      {normalized ? (
        <>
          <ul className="cart-items">
            {normalized.items.map((item, i) => {
              const key = item.spinId && item.skuId ? `${item.spinId}:${item.skuId}` : `idx-${i}`;
              const isPending = pendingKey === key;
              return (
                <li key={i} className="cart-item">
                  <ProductThumb src={item.imageUrl} alt={item.name} className="cart-item-thumb" />
                  <div className="cart-item-info">
                    <span className="cart-item-name">{item.name}</span>
                    <span className="cart-item-meta">
                      {item.spinId && item.skuId ? (
                        <span className="qty-stepper">
                          <button
                            type="button"
                            className="qty-stepper-btn"
                            onClick={() => changeQuantity(item, -1)}
                            disabled={isPending}
                            aria-label={`Decrease ${item.name} quantity`}
                          >
                            −
                          </button>
                          <span className="qty-stepper-value">{item.quantity}</span>
                          <button
                            type="button"
                            className="qty-stepper-btn"
                            onClick={() => changeQuantity(item, 1)}
                            disabled={isPending}
                            aria-label={`Increase ${item.name} quantity`}
                          >
                            +
                          </button>
                        </span>
                      ) : (
                        <span className="cart-item-qty">{item.quantity}×</span>
                      )}
                      {item.price !== undefined && <span className="cart-item-price">{money(item.price)}</span>}
                    </span>
                    {itemError?.key === key && <span className="cart-item-error">{itemError.message}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
          {normalized.total !== undefined && normalized.total !== null && (
            <p className="cart-total">
              <span>Total</span>
              <span>{money(normalized.total)}</span>
            </p>
          )}
        </>
      ) : (
        <pre className="raw-cart">{JSON.stringify(cart, null, 2)}</pre>
      )}
    </div>
  );
}
