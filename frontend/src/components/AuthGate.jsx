import { useEffect, useState } from "react";
import { api } from "../api.js";

export function AuthGate({ children }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const refresh = () => {
    api
      .authStatus()
      .then(setStatus)
      .catch((err) => setError(err.message));
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("authenticated") || params.get("auth_error")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (params.get("auth_error")) setError(params.get("auth_error"));
    refresh();
  }, []);

  if (status === null && !error) {
    return <p>Checking Swiggy authentication…</p>;
  }

  if (!status?.authenticated) {
    return (
      <div className="auth-gate">
        <p>Connect your Swiggy account to use this dashboard.</p>
        {error && <p className="error-text">{error}</p>}
        <a className="button" href="/auth/login">
          Connect Swiggy account
        </a>
      </div>
    );
  }

  return children;
}
