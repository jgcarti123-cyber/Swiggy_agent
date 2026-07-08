import { useState } from "react";
import { api } from "../api.js";
import { AddressPicker } from "./AddressPicker.jsx";
import { ReauthNotice, isReauthError } from "./ReauthNotice.jsx";

export function DishCompare() {
  const [hasAddress, setHasAddress] = useState(false);
  const [dish, setDish] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reauthError, setReauthError] = useState(null);

  async function search(e) {
    e.preventDefault();
    if (!dish.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.compareDish(dish.trim());
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

  if (reauthError) return <ReauthNotice message={reauthError} />;

  return (
    <section className="panel">
      <h2>Food dish compare</h2>
      <AddressPicker onSelected={() => setHasAddress(true)} />

      <form onSubmit={search}>
        <input
          value={dish}
          onChange={(e) => setDish(e.target.value)}
          placeholder="e.g. biryani, paneer tikka, margherita pizza"
          disabled={!hasAddress}
        />
        <button type="submit" disabled={!hasAddress || loading}>
          {loading ? "Searching (checking nearby restaurants)…" : "Compare"}
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
  const [coupon, setCoupon] = useState(null);
  const [checking, setChecking] = useState(false);
  const [couponError, setCouponError] = useState(null);

  async function checkDeal() {
    setChecking(true);
    setCouponError(null);
    try {
      const result = await api.couponCheck(r.restaurantId, dish, r.restaurantName);
      setCoupon(result);
    } catch (err) {
      setCouponError(err.message);
    } finally {
      setChecking(false);
    }
  }

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
      <div className="restaurant-card-item">
        {r.matchedItem?.name} — ₹{r.basePrice}
      </div>

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
                Pay ₹{coupon.toPay} for {coupon.itemName}
                <span className="savings"> (was ₹{coupon.itemTotal})</span>
              </div>
            </>
          ) : (
            <div className="coupon-line muted">
              {coupon.couponCode
                ? `Best coupon ${coupon.couponCode} needs a higher order value — doesn't apply to ${coupon.itemName} alone (₹${coupon.itemTotal}).`
                : `No coupon applies to ${coupon.itemName} alone (₹${coupon.itemTotal}).`}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
