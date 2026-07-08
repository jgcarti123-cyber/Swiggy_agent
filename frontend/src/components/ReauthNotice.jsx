export function ReauthNotice({ message }) {
  return (
    <div className="reauth-notice">
      <p>{message || "Your Swiggy session expired."}</p>
      <a className="button" href="/auth/login">
        Re-authenticate with Swiggy
      </a>
    </div>
  );
}

export function isReauthError(err) {
  return err?.status === 401;
}
