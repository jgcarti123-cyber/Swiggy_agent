import { useEffect, useState } from "react";
import { api } from "../api.js";
import { ReauthNotice, isReauthError } from "./ReauthNotice.jsx";

export function AddressPicker({ onSelected }) {
  const [saved, setSaved] = useState(undefined);
  const [addresses, setAddresses] = useState(null);
  const [error, setError] = useState(null);
  const [reauthError, setReauthError] = useState(null);

  useEffect(() => {
    api
      .getSavedAddress()
      .then((a) => setSaved(a))
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (saved) onSelected?.(saved);
  }, [saved]);

  useEffect(() => {
    if (saved === null && addresses === null) {
      api
        .foodAddresses()
        .then((r) => setAddresses(r.addresses || []))
        .catch((err) => {
          if (isReauthError(err)) setReauthError(err.message);
          else setError(err.message);
        });
    }
  }, [saved, addresses]);

  if (reauthError) return <ReauthNotice message={reauthError} />;
  if (error) return <p className="error-text">{error}</p>;
  if (saved === undefined) return <p>Loading address…</p>;

  if (saved) {
    return (
      <div className="address-picker">
        <span>Delivering to: {saved.label || saved.address_id}</span>{" "}
        <button onClick={() => setSaved(null)}>Change</button>
      </div>
    );
  }

  if (!addresses) return <p>Loading your saved addresses…</p>;

  return (
    <div className="address-picker">
      <p>Choose a delivery address:</p>
      <ul>
        {addresses.map((addr) => (
          <li key={addr.id}>
            <button
              onClick={() => {
                const label = addr.addressTag || addr.addressLine;
                api.saveAddress(addr.id, label, addr).then(() => {
                  setSaved({ address_id: addr.id, label, raw: addr });
                });
              }}
            >
              {addr.addressTag ? `${addr.addressTag} — ` : ""}
              {addr.addressLine}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
