import { getUsualsSchedule, recordScheduleRun, listUsuals, getSavedAddress } from "./db.js";
import { getValidAccessToken, NeedsReauthError } from "./auth/oauthClient.js";
import { addUsualsToCart } from "./agent/instamartAgent.js";

// Daily "auto-add my usuals to the cart" scheduler. Deliberately a plain
// interval check, not a cron dependency — this is a single-user localhost app
// and the schedule is one time-of-day.
//
// HARD RULE: this only ever ADDS the usuals to the cart. It never checks out,
// never touches payment — that stays an explicit user action (project
// non-goal: "No automated checkout without an explicit user click"). Adding to
// a cart is reversible and safe to automate; placing an order is not.
//
// It also only works while this backend process is running and the Swiggy
// token is still valid (tokens last ~5 days with no refresh). Both of those
// can fail at trigger time; see the grace window + status flags below for how
// a skipped run is surfaced rather than silently lost.

const CHECK_INTERVAL_MS = 30 * 1000;

// Only auto-fire within this many minutes AFTER the set time. On a normally
// running backend the tick that first crosses the scheduled minute is well
// inside this. If the backend was down at the scheduled time and starts up
// (or wakes) later than this, we're past the window — that's a MISSED run,
// which per the user's choice is flagged, not caught up.
const GRACE_MINUTES = 10;

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function minutesSinceMidnight(d) {
  return d.getHours() * 60 + d.getMinutes();
}

function parseHHMM(t) {
  const [h, m] = String(t || "").split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

async function runAutoAdd(today) {
  const saved = getSavedAddress();
  if (!saved) {
    recordScheduleRun({ date: today, status: "no_address" });
    return;
  }
  // Cheap local check first (token missing / past its stored expiry). The
  // real add below can still surface a NeedsReauthError if Swiggy's JWT
  // expired earlier than the local window — both map to the same flag.
  try {
    getValidAccessToken();
  } catch {
    recordScheduleRun({ date: today, status: "needs_reauth" });
    console.log(`[scheduler] usuals auto-add for ${today} skipped — token expired`);
    return;
  }
  try {
    const res = await addUsualsToCart(saved.address_id); // ADD ONLY — never checkout
    const status = res.failed
      ? `partial:${res.added}/${res.added + res.failed}`
      : `added:${res.added}`;
    recordScheduleRun({ date: today, status });
    console.log(`[scheduler] usuals auto-add for ${today}: added ${res.added}, failed ${res.failed}`);
  } catch (err) {
    const status = err instanceof NeedsReauthError ? "needs_reauth" : "error";
    recordScheduleRun({ date: today, status });
    console.log(`[scheduler] usuals auto-add for ${today} failed (${status}): ${err.message}`);
  }
}

async function tick() {
  const sched = getUsualsSchedule();
  if (!sched.enabled || !sched.time) return;

  const now = new Date();
  const today = localDateStr(now);
  if (sched.lastRunDate === today) return; // already ran (or flagged) today

  const target = parseHHMM(sched.time);
  if (target == null) return;

  const nowMin = minutesSinceMidnight(now);
  if (nowMin < target) return; // not yet time today

  if (nowMin - target > GRACE_MINUTES) {
    // Past the grace window with no run recorded → the backend was down (or
    // asleep) at the actual scheduled time. Flag as missed, don't catch up.
    recordScheduleRun({ date: today, status: "missed" });
    console.log(`[scheduler] usuals auto-add for ${today} missed (past grace window)`);
    return;
  }

  // Empty list is a no-op worth flagging so the UI can nudge the user.
  if (listUsuals().length === 0) {
    recordScheduleRun({ date: today, status: "empty" });
    return;
  }

  await runAutoAdd(today);
}

export function startUsualsScheduler() {
  setInterval(() => {
    tick().catch((e) => console.error("[scheduler] tick error:", e));
  }, CHECK_INTERVAL_MS);
  console.log("[scheduler] usuals daily auto-add scheduler started");
}
