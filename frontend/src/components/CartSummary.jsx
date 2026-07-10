// get_cart's exact response shape wasn't confirmed against a live non-error
// sample during development (the test account's address came back
// "not serviceable" for Instamart). This renders the common field-name
// variants defensively and falls back to raw JSON so real data is never
// hidden just because a field name guess was wrong.
function first(obj, keys) {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function normalizeCart(cart) {
  const items = first(cart, ["items", "cartItems", "products"]);
  if (!Array.isArray(items)) return null;
  return {
    items: items.map((item) => ({
      name: first(item, ["name", "displayName", "itemName"]),
      quantity: first(item, ["quantity", "qty"]) ?? 1,
      price: first(item, ["price", "offerPrice", "totalPrice"]),
    })),
    total: first(cart, ["total", "grandTotal", "payableAmount"]) ?? first(cart.billDetails ?? cart.bill ?? {}, [
      "grandTotal",
      "total",
    ]),
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

export function CartSummary({ cart }) {
  if (!cart) return <EmptyCart label="No cart activity yet" />;

  // A genuine failure (not the normal "no cart yet" case, which the backend
  // already turns into an empty cart) — keep it low-key rather than dumping a
  // raw support message.
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
          <ul>
            {normalized.items.map((item, i) => (
              <li key={i}>
                <span className="cart-item-qty">{item.quantity}×</span> {item.name}
                {item.price !== undefined ? <span className="cart-item-price">₹{item.price}</span> : null}
              </li>
            ))}
          </ul>
          {normalized.total !== undefined && <p className="cart-total">Total: ₹{normalized.total}</p>}
        </>
      ) : (
        <pre className="raw-cart">{JSON.stringify(cart, null, 2)}</pre>
      )}
    </div>
  );
}
