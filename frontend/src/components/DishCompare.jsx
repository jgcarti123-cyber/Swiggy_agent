import { useState } from "react";
import { api } from "../api.js";
import { AddressPicker } from "./AddressPicker.jsx";
import { ReauthNotice, isReauthError } from "./ReauthNotice.jsx";

const VEG_MODES = [
  { id: "veg", label: "Veg" },
  { id: "nonveg", label: "Non-veg" },
  { id: "all", label: "All" },
];

export function DishCompare() {
  const [hasAddress, setHasAddress] = useState(false);
  const [dish, setDish] = useState("");
  const [vegMode, setVegMode] = useState("nonveg");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reauthError, setReauthError] = useState(null);

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

  if (reauthError) return <ReauthNotice message={reauthError} />;

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Feast Finder</h2>
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
        <button type="submit" disabled={!hasAddress || loading}>
          {loading ? "Searching…" : "Compare"}
        </button>
      </form>

      {error && <p className="error-text">{error}</p>}

      {results && results.restaurants.length === 0 && (
        <p>No open restaurants found serving "{results.dish}" nearby.</p>
      )}

      {results && results.restaurants.length > 0 && (
        <ul className="restaurant-list">
          {results.restaurants.map((r) => (
            <RestaurantCard key={r.restaurantId} restaurant={r} dish={results.dish} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RestaurantCard({ restaurant: r, dish }) {
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
          />
        ))}
      </ul>
    </li>
  );
}

function ItemRow({ item, dish, restaurantId, restaurantName }) {
  const [coupon, setCoupon] = useState(null);
  const [checking, setChecking] = useState(false);
  const [couponError, setCouponError] = useState(null);

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
