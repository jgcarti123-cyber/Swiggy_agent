import { useState, useEffect } from "react";
import { api } from "../api.js";
import { AddressPicker } from "./AddressPicker.jsx";
import { ReauthNotice, isReauthError } from "./ReauthNotice.jsx";
import { FoodCart } from "./FoodCart.jsx";
import { DISHES } from "../data/dishes.js";

const VEG_MODES = [
  { id: "veg", label: "Veg" },
  { id: "nonveg", label: "Non-veg" },
  { id: "all", label: "All" },
];

// "veg" filter only ever shows veg-tagged items (see DISHES), so the
// randomiser should only ever suggest dishes that can actually turn up
// something under the active filter — same reasoning for "nonveg".
function dishesForVegMode(vegMode) {
  if (vegMode === "veg") return DISHES.filter((d) => d.tag === "veg" || d.tag === "either");
  if (vegMode === "nonveg") return DISHES.filter((d) => d.tag === "nonveg" || d.tag === "either");
  return DISHES;
}

export function DishCompare() {
  const [hasAddress, setHasAddress] = useState(false);
  const [dish, setDish] = useState("");
  const [vegMode, setVegMode] = useState("nonveg");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reauthError, setReauthError] = useState(null);
  const [cart, setCart] = useState(null);
  // A pending cross-restaurant add awaiting confirmation (adding it would clear
  // the current cart): { restaurantId, restaurantName, dish, menuItemId,
  // currentRestaurantName }.
  const [pendingReplace, setPendingReplace] = useState(null);

  // Load the existing food cart once an address is chosen, so a cart built in
  // an earlier session is reflected immediately.
  useEffect(() => {
    if (!hasAddress) return;
    let cancelled = false;
    api
      .getFoodCart()
      .then((res) => {
        if (!cancelled) setCart(res.cart);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hasAddress]);

  // Core add: returns the raw result so the calling ItemRow can manage its own
  // per-button state. When Swiggy would clear a different restaurant's cart it
  // returns needsConfirm — surfaced as a modal rather than mutating anything.
  async function addToCart({ restaurantId, restaurantName, dish, menuItemId }, confirmReplace = false) {
    const result = await api.addToFoodCart({
      restaurantId,
      restaurantName,
      dish,
      menuItemId,
      quantity: 1,
      confirmReplace,
    });
    if (result.needsConfirm) {
      setPendingReplace({
        restaurantId,
        restaurantName,
        dish,
        menuItemId,
        currentRestaurantName: result.currentRestaurantName,
      });
      return result;
    }
    if (result.cart) setCart(result.cart);
    return result;
  }

  async function confirmReplace() {
    const p = pendingReplace;
    setPendingReplace(null);
    if (p) await addToCart(p, true);
  }

  async function runSearch(term, mode) {
    if (!term.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.compareDish(term.trim(), mode);
      setResults(data);
    } catch (err) {
      if (isReauthError(err)) {
        setReauthError(err.message);
      } else {
        setError(err.message);
      }
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  function search(e) {
    e.preventDefault();
    runSearch(dish, vegMode);
  }

  function selectVegMode(mode) {
    setVegMode(mode);
    // If a search already ran, re-run it immediately with the new filter
    // instead of leaving stale results on screen under the new label.
    if (results) runSearch(dish, mode);
  }

  // Fills the box only — does not auto-search — so a pick you don't feel
  // like eating can just be rerolled or typed over before hitting Compare.
  function surpriseMe() {
    const pool = dishesForVegMode(vegMode);
    const choices = pool.filter((d) => d.name !== dish);
    const pick = (choices.length > 0 ? choices : pool)[
      Math.floor(Math.random() * (choices.length > 0 ? choices.length : pool.length))
    ];
    if (pick) setDish(pick.name);
  }

  if (reauthError) return <ReauthNotice message={reauthError} />;

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Feaster</h2>
        <p className="panel-sub">
          Type a dish and see open restaurants near you, ranked by rating, with veg or non-veg
          options for that dish and their real coupon price.
        </p>
      </header>
      <AddressPicker onSelected={() => setHasAddress(true)} />

      <div className="veg-toggle" role="group" aria-label="Veg or non-veg filter">
        {VEG_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`veg-pill veg-pill-${m.id}${vegMode === m.id ? " veg-pill--active" : ""}`}
            aria-pressed={vegMode === m.id}
            onClick={() => selectVegMode(m.id)}
            disabled={loading}
          >
            {m.id !== "all" && <span className={`veg-dot veg-dot-${m.id}`} aria-hidden="true" />}
            {m.label}
          </button>
        ))}
      </div>

      <form className="search-row" onSubmit={search}>
        <input
          value={dish}
          onChange={(e) => setDish(e.target.value)}
          placeholder="e.g. biryani, paneer tikka, margherita pizza"
          disabled={!hasAddress}
        />
        <button
          type="button"
          className="surprise-button"
          onClick={surpriseMe}
          disabled={!hasAddress}
          title="Surprise me with a random dish"
          aria-label="Surprise me with a random dish"
        >
          <DiceIcon />
        </button>
        <button type="submit" disabled={!hasAddress || loading}>
          {loading ? "Searching…" : "Compare"}
        </button>
      </form>

      {error && <p className="error-text">{error}</p>}

      <FoodCart cart={cart} onCartUpdate={setCart} />

      {results && results.restaurants.length === 0 && (
        <div className="no-results">
          <p>No open restaurants found serving "{results.dish}" nearby.</p>
          {results.suggestedTerms?.length > 0 && (
            <div className="suggestion-chips">
              <span className="suggestion-label">Try instead:</span>
              {results.suggestedTerms.map((term) => (
                <button
                  key={term}
                  type="button"
                  className="suggestion-chip"
                  onClick={() => {
                    setDish(term);
                    runSearch(term, vegMode);
                  }}
                  disabled={loading}
                >
                  {term}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {results && results.restaurants.length > 0 && (
        <ul className="restaurant-list">
          {results.restaurants.map((r) => (
            <RestaurantCard
              key={r.restaurantId}
              restaurant={r}
              dish={results.dish}
              cart={cart}
              onAdd={addToCart}
            />
          ))}
        </ul>
      )}

      {pendingReplace && (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="Switch restaurant">
          <div className="confirm-card">
            <p className="confirm-title">Start a new cart?</p>
            <p className="confirm-body">
              Your cart{pendingReplace.currentRestaurantName ? ` from ${pendingReplace.currentRestaurantName}` : ""} will
              be cleared so you can order from{" "}
              <strong>{pendingReplace.restaurantName || "this restaurant"}</strong>. A Swiggy cart can only hold one
              restaurant at a time.
            </p>
            <div className="confirm-actions">
              <button type="button" className="link-button" onClick={() => setPendingReplace(null)}>
                Cancel
              </button>
              <button type="button" className="confirm-primary" onClick={confirmReplace}>
                Clear &amp; add
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function DiceIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="16" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="16" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="16" cy="16" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RestaurantCard({ restaurant: r, dish, cart, onAdd }) {
  return (
    <li className="restaurant-card">
      <div className="restaurant-card-main">
        <strong>{r.restaurantName || r.restaurantId}</strong>
        <span className="rating-badge">★ {r.rating ?? "—"}</span>
        <span className="eta-badge">
          {r.deliveryTimeMinutes ? `${r.deliveryTimeMinutes} min` : ""}
          {r.distanceKm ? ` · ${r.distanceKm} km` : ""}
        </span>
      </div>
      <ul className="item-list">
        {r.items.map((item) => (
          <ItemRow
            key={item.menuItemId}
            item={item}
            dish={dish}
            restaurantId={r.restaurantId}
            restaurantName={r.restaurantName}
            cart={cart}
            onAdd={onAdd}
          />
        ))}
      </ul>
    </li>
  );
}

function ItemRow({ item, dish, restaurantId, restaurantName, cart, onAdd }) {
  const [coupon, setCoupon] = useState(null);
  const [checking, setChecking] = useState(false);
  const [couponError, setCouponError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);

  // How many of THIS dish are currently in the cart (only counts when the cart
  // is at this restaurant — a Swiggy food cart holds one restaurant at a time).
  const inCartQty =
    cart && !cart.empty && String(cart.restaurantId) === String(restaurantId)
      ? cart.items.find((i) => i.menuItemId === String(item.menuItemId))?.quantity || 0
      : 0;

  async function handleAdd() {
    setAdding(true);
    setAddError(null);
    try {
      const result = await onAdd({ restaurantId, restaurantName, dish, menuItemId: item.menuItemId });
      if (result?.error) setAddError(result.error);
    } catch (err) {
      setAddError(err.message || "Couldn't add to cart");
    } finally {
      setAdding(false);
    }
  }

  async function checkDeal() {
    setChecking(true);
    setCouponError(null);
    try {
      const result = await api.couponCheck(restaurantId, item.menuItemId, dish, restaurantName);
      setCoupon(result);
    } catch (err) {
      setCouponError(err.message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <li className="item-row">
      <div className="item-photo">
        {item.imageUrl ? (
          <img src={item.imageUrl} alt={item.name} loading="lazy" />
        ) : (
          <span className="item-photo-placeholder">No photo available</span>
        )}
      </div>

      <div className="item-details">
        <div className="item-row-main">
          <span
            className={`veg-dot ${item.isVeg ? "veg-dot-veg" : "veg-dot-nonveg"}`}
            title={item.isVeg ? "Veg" : "Non-veg"}
            aria-label={item.isVeg ? "Veg" : "Non-veg"}
          />
          <span className="item-name">{item.name}</span>
          {item.rating !== null && <span className="item-rating">★ {item.rating}</span>}
          <span className="item-price">₹{item.price}</span>
        </div>

        {item.estimatedProteinGrams !== null && item.estimatedKcal !== null && (
          <div className="item-nutrition">
            Est. ~{item.estimatedProteinGrams}g protein · ~{item.estimatedKcal} kcal
          </div>
        )}

        <div className="item-actions">
          <button
            type="button"
            className={`add-cart-button${inCartQty > 0 ? " add-cart-button--in" : ""}`}
            onClick={handleAdd}
            disabled={adding}
          >
            {adding ? "Adding…" : inCartQty > 0 ? `Add another (${inCartQty} in cart)` : "Add to cart"}
          </button>
        </div>

        {addError && <p className="error-text">{addError}</p>}

        {!coupon && (
          <button className="deal-button" onClick={checkDeal} disabled={checking} type="button">
            {checking ? "Checking best deal…" : "Check best coupon & real price"}
          </button>
        )}

        {couponError && <p className="error-text">{couponError}</p>}

        {coupon && !coupon.available && (
          <div className="coupon-line muted">{coupon.reason || "No deal available."}</div>
        )}

        {coupon && coupon.available && (
          <div className="coupon-result">
            {coupon.applied ? (
              <>
                <div className="coupon-line">
                  <span className="coupon-code">{coupon.couponCode}</span> applied — save ₹
                  {coupon.couponDiscount}
                  {coupon.freeDelivery ? " · free delivery" : ""}
                </div>
                <div className="effective-price">
                  Pay ₹{coupon.toPay}
                  <span className="savings"> (was ₹{coupon.itemTotal})</span>
                </div>
              </>
            ) : (
              <div className="coupon-line muted">
                {coupon.couponCode
                  ? `Best coupon ${coupon.couponCode} needs a higher order value — doesn't apply to this item alone (₹${coupon.itemTotal}).`
                  : `No coupon applies to this item alone (₹${coupon.itemTotal}).`}
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
