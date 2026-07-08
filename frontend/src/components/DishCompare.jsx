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
      <header className="panel-header">
        <h2>Feast Finder</h2>
        <p className="panel-sub">
          Type a dish and see open restaurants near you, ranked by rating, with non-veg options for
          that dish and their real coupon price.
        </p>
      </header>
      <AddressPicker onSelected={() => setHasAddress(true)} />

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
          <span className="item-name">{item.name}</span>
          {item.rating !== null && <span className="item-rating">★ {item.rating}</span>}
          <span className="item-price">₹{item.price}</span>
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
