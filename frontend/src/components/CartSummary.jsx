import { ProductThumb } from "./ProductThumb.jsx";

function first(obj, keys) {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

// Field names confirmed against a live get_cart response (items[] with
// itemName / quantity / mrp / discountedFinalPrice / imageUrl, plus
// cartTotalAmount and billBreakdown.toPay). Fallback key-name variants are
// kept so an unexpected shape still renders rather than hiding real data.
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
    })),
    total:
      first(cart, ["cartTotalAmount", "total", "grandTotal", "payableAmount"]) ??
      first(cart.billBreakdown?.toPay ?? cart.billDetails ?? cart.bill ?? {}, ["value", "grandTotal", "total"]),
  };
}

function EmptyCart({ label = "Your cart is empty" }) {
  return (
    <div className="cart-summary">
      <h3>Cart</h3>
      <div className="cart-empty-state">
        <span className="cart-empty-icon" aria-hidden="true">🛒</span>
        <p className="muted">{label}</p>
        <p className="cart-empty-hint">Ask Pantry Pal to add something.</p>
      </div>
    </div>
  );
}

// Prices come back either as numbers (26) or pre-formatted strings ("₹153").
function money(value) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : `₹${value}`;
}

export function CartSummary({ cart }) {
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
            {normalized.items.map((item, i) => (
              <li key={i} className="cart-item">
                <ProductThumb src={item.imageUrl} alt={item.name} className="cart-item-thumb" />
                <div className="cart-item-info">
                  <span className="cart-item-name">{item.name}</span>
                  <span className="cart-item-meta">
                    <span className="cart-item-qty">{item.quantity}×</span>
                    {item.price !== undefined && <span className="cart-item-price">{money(item.price)}</span>}
                  </span>
                </div>
              </li>
            ))}
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
