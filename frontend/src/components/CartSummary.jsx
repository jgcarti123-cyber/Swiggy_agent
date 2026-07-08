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

export function CartSummary({ cart }) {
  if (!cart) {
    return (
      <div className="cart-summary">
        <h3>Cart</h3>
        <p className="muted">No cart activity yet.</p>
      </div>
    );
  }

  if (cart.error) {
    return (
      <div className="cart-summary">
        <h3>Cart</h3>
        <p className="error-text">{cart.error}</p>
      </div>
    );
  }

  const normalized = normalizeCart(cart);

  return (
    <div className="cart-summary">
      <h3>Cart (live)</h3>
      {normalized ? (
        <>
          {normalized.items.length === 0 && <p className="muted">Cart is empty.</p>}
          <ul>
            {normalized.items.map((item, i) => (
              <li key={i}>
                {item.quantity}× {item.name}
                {item.price !== undefined ? ` — ₹${item.price}` : ""}
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
