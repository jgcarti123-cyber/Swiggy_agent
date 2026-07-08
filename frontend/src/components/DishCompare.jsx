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
            <li key={r.restaurantId} className="restaurant-card">
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
              {r.coupon ? (
                <div className="coupon-line">
                  {r.coupon.code ? `${r.coupon.code}: ` : ""}
                  {r.coupon.description || "coupon applied"}
                  {r.coupon.minOrderValue ? ` (min order ₹${r.coupon.minOrderValue})` : ""}
                </div>
              ) : (
                <div className="coupon-line muted">No coupon found</div>
              )}
              <div className="effective-price">
                Est. effective price: ₹{r.effectivePrice}
                {r.effectivePrice !== r.basePrice && (
                  <span className="savings"> (save ₹{r.basePrice - r.effectivePrice})</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
