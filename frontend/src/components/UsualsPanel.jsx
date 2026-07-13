import { useState } from "react";
import { ProductThumb } from "./ProductThumb.jsx";

// Turns the scheduler's last-run status code (set backend-side in scheduler.js
// / db.js) into a short human line. Problem states get a warning treatment;
// a normal run gets a muted confirmation.
function scheduleStatus(schedule) {
  const { lastStatus, lastRunDate } = schedule;
  if (!lastStatus || !lastRunDate) return null;
  const when = lastRunDate;
  if (lastStatus === "needs_reauth")
    return { level: "warn", text: `Auto-add on ${when} was skipped — Swiggy sign-in had expired. Reconnect and reorder manually.` };
  if (lastStatus === "missed")
    return { level: "warn", text: `Auto-add on ${when} was missed — the app wasn't running at the scheduled time.` };
  if (lastStatus === "empty")
    return { level: "warn", text: `Auto-add on ${when} did nothing — your usuals list was empty.` };
  if (lastStatus === "no_address")
    return { level: "warn", text: `Auto-add on ${when} was skipped — no delivery address was set.` };
  if (lastStatus === "error")
    return { level: "warn", text: `Auto-add on ${when} hit an error. Try reordering manually.` };
  if (lastStatus.startsWith("partial:"))
    return { level: "ok", text: `Auto-added your usuals on ${when} (some items were unavailable).` };
  if (lastStatus.startsWith("added:"))
    return { level: "ok", text: `Auto-added ${lastStatus.split(":")[1]} usual(s) to your cart on ${when}.` };
  return null;
}

function money(v) {
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : `₹${v}`;
}

export function UsualsPanel({ usuals, schedule, disabled, onRemove, onReorder, onScheduleChange }) {
  const [reordering, setReordering] = useState(false);
  const [open, setOpen] = useState(true); // collapsible, open by default
  const enabled = !!schedule?.enabled;
  const time = schedule?.time || "08:00";
  const status = scheduleStatus(schedule || {});

  async function reorder() {
    if (disabled || reordering || usuals.length === 0) return;
    setReordering(true);
    try {
      await onReorder();
    } finally {
      setReordering(false);
    }
  }

  return (
    <div className="usuals-panel">
      <button
        type="button"
        className="usuals-header usuals-header--toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <h3>My Usuals</h3>
        {usuals.length > 0 && <span className="usuals-count">{usuals.length}</span>}
        <span className={`usuals-chevron${open ? " usuals-chevron--open" : ""}`} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="usuals-body">
          {renderBody()}
        </div>
      )}
    </div>
  );

  function renderBody() {
    return (
      <>
      {usuals.length === 0 ? (
        <p className="usuals-empty">
          No usuals yet. Find items in chat and tap the <span className="usuals-star-hint">☆</span> on a card to save
          them here.
        </p>
      ) : (
        <>
          <ul className="usuals-list">
            {usuals.map((u) => (
              <li key={`${u.spinId}:${u.skuId}`} className="usuals-item">
                <ProductThumb src={u.imageUrl} alt={u.displayName} className="usuals-item-thumb" />
                <div className="usuals-item-info">
                  <span className="usuals-item-name">{u.displayName}</span>
                  <span className="usuals-item-meta">
                    {u.quantityDescription && <span>{u.quantityDescription}</span>}
                    {u.offerPrice != null && <span className="usuals-item-price">{money(u.offerPrice)}</span>}
                  </span>
                </div>
                <button
                  type="button"
                  className="usuals-remove"
                  onClick={() => onRemove(u)}
                  disabled={disabled}
                  aria-label={`Remove ${u.displayName} from usuals`}
                  title="Remove from usuals"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="usuals-reorder-btn" onClick={reorder} disabled={disabled || reordering}>
            {reordering ? "Adding…" : "Reorder now"}
          </button>
        </>
      )}

      <div className="usuals-schedule">
        <label className="usuals-schedule-toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled}
            onChange={(e) => onScheduleChange(e.target.checked, time)}
          />
          <span>Auto-add to cart daily</span>
        </label>
        {enabled && (
          <div className="usuals-schedule-time">
            <span>at</span>
            <input
              type="time"
              value={time}
              disabled={disabled}
              onChange={(e) => onScheduleChange(true, e.target.value)}
            />
          </div>
        )}
        <p className="usuals-schedule-note">
          Adds your usuals to the cart — never places the order. Only runs while this app is open and you're signed in.
        </p>
        {status && <p className={`usuals-status usuals-status--${status.level}`}>{status.text}</p>}
      </div>
      </>
    );
  }
}
