import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";
import { AddressPicker } from "./AddressPicker.jsx";
import { CartSummary } from "./CartSummary.jsx";
import { UsualsPanel } from "./UsualsPanel.jsx";
import { ProductThumb } from "./ProductThumb.jsx";
import { ReauthNotice, isReauthError } from "./ReauthNotice.jsx";

const usualKey = (item) => `${item.spinId}:${item.skuId}`;

// "+" on the round attach button — matches the line-icon style used in
// Sidebar.jsx (stroke, currentColor, rounded caps).
function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

// "Explain" button icon — a plain info glyph, matching the stroke/currentColor
// style of every other icon in this file.
function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

// Send — a paper plane. Replaces the "Send" text label so the composer's two
// ends are matching circular icon buttons instead of a circle and a pill.
function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

// Shopping-bag glyph for the empty state's avatar — same family as the
// sidebar's Insta-nt icon so the panel reads as one identity.
function BagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
      <path d="M3 6h18M16 10a4 4 0 0 1-8 0" />
    </svg>
  );
}

// Tap-to-try starters for the empty state. These are the app's own canonical
// example phrasings (they match SYSTEM_PROMPT's examples and the recipe
// pre-gate), so a first-time user lands on a working path rather than
// guessing at what the agent understands.
const CHAT_STARTERS = ["add milk", "order things for making biryani", "add Amul Taaza 500ml"];

// Turn a /chat response into a renderable transcript message.
function assistantMessageFromResult(result) {
  if (result.choice) {
    return { role: "assistant", type: "choice", question: result.choice.question, options: result.choice.options || [] };
  }
  if (result.products) {
    return { role: "assistant", type: "products", intro: result.products.intro, products: result.products.items || [] };
  }
  if (result.ingredients) {
    return {
      role: "assistant",
      type: "ingredients",
      dish: result.ingredients.dish,
      ingredients: result.ingredients.ingredients || [],
      grounded: result.ingredients.grounded,
      sourceUrls: result.ingredients.sourceUrls || [],
    };
  }
  if (result.recipe) {
    return { role: "assistant", type: "recipe", dish: result.recipe.dish, reply: result.reply, groups: result.recipe.groups || [] };
  }
  if (result.import) {
    return { role: "assistant", type: "import", items: result.import.items || [] };
  }
  return { role: "assistant", text: result.reply || "(no reply)" };
}

// Downscale + JPEG-compress an uploaded image in the browser before sending —
// a phone screenshot PNG can be several MB, and Groq's vision endpoint caps a
// base64 image at 4MB. Cap the long edge at 1600px (plenty for reading text)
// and encode JPEG at 0.82; a full cart screenshot lands well under 1MB.
function downscaleImage(file, maxEdge = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That doesn't look like an image"));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Rotating status shown with the typing dots while Insta-nt works. Advances
// every couple of seconds and parks on the last line (never loops back —
// "Almost there…" restarting as "Thinking…" reads like a hang).
const THINKING_LINES = ["Thinking…", "Searching Instamart…", "Checking prices…", "Sorting the good stuff…", "Almost there…"];

// How long after a cart mutation finishes before background polling is allowed
// to speak again. Purely a settle margin for Swiggy's own eventual consistency
// (a get_cart moments after a write can still report the pre-write state — see
// mergeAndUpdateCart's note in instamartAgent.js); the generation guard below
// is what actually prevents the stale-overwrite bug. Comfortably inside the
// 12s poll interval, so this costs at most one skipped tick.
const CART_SETTLE_MS = 4000;

export function InstamartChat({ isActive = true }) {
  const [hasAddress, setHasAddress] = useState(false);
  const [messages, setMessages] = useState([]);
  const [cart, setCart] = useState(null);
  const [usuals, setUsuals] = useState([]);
  const [schedule, setSchedule] = useState({ enabled: false, time: null });
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState(null); // staged screenshot data URL, or null
  const [sending, setSending] = useState(false);
  const [thinkingStep, setThinkingStep] = useState(0);
  const [error, setError] = useState(null);
  const [reauthError, setReauthError] = useState(null);
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);
  // Read by the polling effect below without needing `sending` in its
  // dependency array — that would tear down and restart the interval on
  // every send, which is harmless but pointless churn.
  const sendingRef = useRef(false);
  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  // --- Cart mutation guard -------------------------------------------------
  // Background polling used to clobber the result of an action the user had
  // just taken, which looked exactly like the cart "undoing itself" a few
  // seconds later — reproduced live: clear the cart, watch it go empty, watch
  // the item reappear 2s later, while the very next server read confirmed the
  // cart really was empty. The item was never on the server; it came from a
  // GET /cart that had been issued BEFORE the clear and only resolved after
  // it, overwriting the fresh state with its stale snapshot.
  //
  // `sendingRef` alone couldn't stop this: it's checked when a poll STARTS, so
  // it only skips polls that begin during an action — it says nothing about a
  // read already in flight when the action begins. And whether that read wins
  // is pure luck: measured live, cart reads take 0.34-1.2s and a clear-cart
  // write takes 0.9-1.0s, so the two distributions overlap outright. The
  // quantity stepper had no guard at all (it calls the API directly, outside
  // runAction, so `sending` never even flips), which is why quantity changes
  // were the most reliable to revert.
  //
  // Fix: a generation counter bumped at both ends of every cart mutation. A
  // poll records the generation when it starts and throws its own result away
  // if that generation has moved on — i.e. the data it's holding is provably
  // older than something the user did. Plus a short settle window afterwards
  // for Swiggy's own eventual consistency.
  const cartGenRef = useRef(0);
  const cartMutatingRef = useRef(0);
  const cartSettleUntilRef = useRef(0);

  // Wrap anything that can change the cart. Every caller must go through this
  // — including the ones that bypass runAction (the cart stepper, recipe
  // swaps), since those are exactly the paths that were unprotected.
  async function withCartMutation(fn) {
    cartGenRef.current += 1;
    cartMutatingRef.current += 1;
    try {
      return await fn();
    } finally {
      cartMutatingRef.current -= 1;
      cartGenRef.current += 1;
      cartSettleUntilRef.current = Date.now() + CART_SETTLE_MS;
    }
  }

  // Reads refs only, so it always sees current values even from the closure
  // the polling effect captured on an earlier render.
  function cartPollBlocked() {
    return cartMutatingRef.current > 0 || Date.now() < cartSettleUntilRef.current;
  }

  // --- Diagnostic: every cart the panel actually renders ---------------------
  // Two rounds of provably-correct fixes haven't made the reported symptom go
  // away, and the server-side logs have consistently shown the server being
  // right — which means the disagreement is here, in what gets rendered. So
  // every single write to `cart` state goes through this one function, tagged
  // with where it came from, and is mirrored into the backend's audit log so
  // the client and server halves share one timeline. No-op unless CART_AUDIT=1
  // server-side. Route ALL cart updates through this, never bare setCart —
  // an unlogged path is precisely the blind spot this is meant to remove.
  function applyCart(source, next) {
    api.instamartAudit("render:cart", {
      source,
      items: (next?.items || []).map((i) => ({ spinId: i.spinId, skuId: i.skuId, name: i.itemName, qty: i.quantity })),
      cartId: next?.cartId ?? null,
      error: next?.error ?? null,
    });
    setCart(next);
  }

  useEffect(() => {
    if (!sending) {
      setThinkingStep(0);
      return undefined;
    }
    const id = setInterval(() => setThinkingStep((s) => Math.min(s + 1, THINKING_LINES.length - 1)), 2000);
    return () => clearInterval(id);
  }, [sending]);

  const savedKeys = useMemo(() => new Set(usuals.map(usualKey)), [usuals]);

  useEffect(() => {
    api.instamartChatHistory().then((r) => setMessages(r.messages)).catch(() => {});
    api
      .instamartCart()
      .then((c) => applyCart("mount", c))
      .catch((err) => {
        if (isReauthError(err)) setReauthError(err.message);
        else applyCart("mount:error", { error: err.message });
      });
    api.instamartUsuals().then((r) => setUsuals(r.usuals || [])).catch(() => {});
    api.instamartUsualsSchedule().then((s) => setSchedule(s)).catch(() => {});
  }, []);

  // Background cart polling. get_cart already reflects anything added from
  // OUTSIDE this app (e.g. the real Instamart phone app) — Swiggy's cart is
  // the single source of truth, there's no local mirror to go stale. The
  // actual gap was that this frontend only ever re-fetched it after ITS OWN
  // mutations, so an external change wouldn't show up here until the next
  // local action or a full reload. Polling closes that gap.
  //
  // Scoped to when it's actually useful: only while this panel is the one
  // visible (`isActive`, passed down from App.jsx's tab state) and the
  // browser tab itself has focus (`document.hidden`) — no point spending
  // calls refreshing a cart nobody's looking at.
  //
  // A poll is skipped outright while an action is in flight, and — critically
  // — a poll that has ALREADY STARTED discards its own result if the cart
  // generation moved while it was waiting. Never trust arrival order here:
  // the whole bug this guards against was a slow read landing after a fast
  // write and winning by virtue of being last. See the cart mutation guard
  // above for the measured latencies that make that a coin flip, not an edge
  // case.
  useEffect(() => {
    if (!isActive || !hasAddress) return undefined;

    let cancelled = false;

    async function poll() {
      if (document.hidden || sendingRef.current || cartPollBlocked()) {
        api.instamartAudit("poll:skipped", {
          hidden: document.hidden,
          sending: sendingRef.current,
          blocked: cartPollBlocked(),
        });
        return;
      }
      const gen = cartGenRef.current;
      try {
        const c = await api.instamartCart();
        // Anything the user did while this read was in flight is newer than
        // what it's holding — drop it rather than repaint the cart backwards.
        // The action's own response already set the fresh cart.
        if (!cancelled && gen === cartGenRef.current && !cartPollBlocked()) {
          applyCart("poll", c);
        } else {
          // Logged too: if the guard is firing when it shouldn't (or never
          // firing when it should), that's visible here rather than inferred.
          api.instamartAudit("poll:discarded", {
            cancelled,
            genAtStart: gen,
            genNow: cartGenRef.current,
            blocked: cartPollBlocked(),
            wouldHaveRendered: (c?.items || []).map((i) => ({ name: i.itemName, qty: i.quantity })),
          });
        }
      } catch (err) {
        // A background refresh failing shouldn't clobber an already-good,
        // already-displayed cart with an error state — that would read as
        // the cart "breaking" every ~12s on any transient hiccup. The one
        // exception is a genuinely expired token: that's real and actionable
        // regardless of what triggered the check.
        if (!cancelled && isReauthError(err)) setReauthError(err.message);
      }
    }

    poll(); // refresh immediately on becoming the active panel, not after a full interval
    const id = setInterval(poll, 12000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isActive, hasAddress]);

  // Scroll the transcript container itself, NOT via scrollIntoView on a
  // sentinel: scrollIntoView walks every scrollable ancestor, so with the chat
  // card now sized to the viewport it dragged the whole page down on each new
  // message. Setting scrollTop only ever moves this one element.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  // Shared by every user action (typed message, Add-button click, quick
  // action, show-more): push the user bubble immediately, run whichever API
  // call actually answers it, then render the response the same way
  // regardless of whether that call went through the LLM chat loop or one of
  // the deterministic direct-action endpoints. `userExtra` merges extra
  // fields into the pushed user bubble — currently only the image thumbnail
  // for an uploaded screenshot.
  async function runAction(displayText, apiCall, userExtra) {
    if (sending || !hasAddress) return;
    setError(null);
    setMessages((prev) => [...prev, { role: "user", text: displayText, ...userExtra }]);
    setSending(true);
    try {
      // Every action routed through here can end up changing the cart (an
      // add, a clear, a reorder, a recipe/import confirm, or a free-text chat
      // message that edits it), so all of them hold the cart mutation guard.
      const result = await withCartMutation(apiCall);
      setMessages((prev) => {
        const next = [...prev, assistantMessageFromResult(result)];
        // A real add attempt just proved this spinId can't actually be added
        // right now (Swiggy's search said it was fine — see
        // instamartAgent.js's markSpinOutOfStock). Grey out every already-
        // rendered card for it in this transcript immediately, not just the
        // one that was clicked, rather than leaving a stale "Add" button the
        // user could click again.
        if (!result.outOfStockSpinId) return next;
        return next.map((m) =>
          m.type === "products"
            ? {
                ...m,
                products: m.products.map((p) =>
                  p.spinId === result.outOfStockSpinId ? { ...p, inStock: false } : p
                ),
              }
            : m
        );
      });
      if (result.cart) applyCart(`action:${displayText.slice(0, 40)}`, result.cart);
      if (result.usuals) setUsuals(result.usuals);
    } catch (err) {
      if (isReauthError(err)) setReauthError(err.message);
      else setError(err.message);
    } finally {
      setSending(false);
    }
  }

  function sendMsg(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    runAction(trimmed, () => api.instamartChatSend(trimmed));
  }

  function onSubmit(e) {
    e.preventDefault();
    if (pendingImage) sendPendingImage(input);
    else sendMsg(input);
    setInput("");
  }

  function addProduct(p) {
    const size = p.quantityDescription ? ` (${p.quantityDescription})` : "";
    const displayText = `Add ${p.displayName}${size}`;
    // Deterministic — the exact spinId/skuId is already known, so this skips
    // the LLM loop entirely (get_cart + merge + update_cart in code).
    runAction(displayText, () => api.instamartAddItem(p.spinId, p.skuId, 1, displayText));
  }

  function showMore() {
    runAction("Show more options", () => api.instamartShowMore());
  }

  function reorderUsuals() {
    return runAction("Reorder my usual items", () => api.instamartReorderUsuals());
  }

  function clearCart() {
    runAction("Clear my cart", () => api.instamartClearCart());
  }

  // Screenshot upload is staged, not auto-sent: picking a file downscales it
  // locally and shows a preview above the input row, where the user can type
  // an optional caption (forwarded as an extraction instruction, e.g. "only
  // get the snacks") before actually hitting Send — same as attaching a photo
  // in any normal chat app, and the user's explicit ask: know what's being
  // sent, and get a chance to say something about it first.
  async function onImageChosen(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file || sending || !hasAddress) return;
    setError(null);
    try {
      setPendingImage(await downscaleImage(file));
    } catch (err) {
      setError(err.message);
    }
  }

  function sendPendingImage(caption) {
    if (sending || !hasAddress || !pendingImage) return;
    const trimmed = (caption || "").trim();
    const dataUrl = pendingImage;
    setPendingImage(null);
    runAction(trimmed || "Imported a screenshot", () => api.instamartImportImage(dataUrl, trimmed || undefined), {
      image: dataUrl,
    });
  }

  // Import checklist confirmed (possibly edited): mark it consumed locally,
  // then run the deterministic size-strict search-and-add.
  function confirmImport(message, items) {
    setMessages((prev) => prev.map((m) => (m === message ? { ...m, confirmed: true } : m)));
    runAction(`Import ${items.length} item${items.length === 1 ? "" : "s"} from the screenshot`, () =>
      api.instamartImportConfirm(items)
    );
  }

  // Recipe checklist confirmed (possibly after edits): mark the checklist
  // message consumed locally (the server does the same to its transcript
  // copy), then run the deterministic search-and-add step.
  function confirmRecipe(message, ingredients) {
    setMessages((prev) => prev.map((m) => (m === message ? { ...m, confirmed: true } : m)));
    runAction(`Confirm ingredients for ${message.dish} (${ingredients.length})`, () =>
      api.instamartRecipeConfirm(message.dish, ingredients)
    );
  }

  // Swap which option is in the cart for one recipe ingredient. Like the cart
  // stepper this is a cart mutation, not a chat event — no new bubble, just
  // update the recipe message's "added" marker and the live cart.
  async function swapRecipeOption(message, group, option) {
    setError(null);
    try {
      const prevAdded = group.addedSpinId ? group.options.find((o) => o.spinId === group.addedSpinId) : null;
      // Guarded like every other cart write — this one bypasses runAction (it
      // deliberately produces no chat bubble), so it needs the guard applied
      // directly or a background poll can undo the swap.
      const res = await withCartMutation(() =>
        api.instamartRecipeSwap({
          ingredient: group.ingredient,
          removeSpinId: prevAdded?.spinId,
          removeSkuId: prevAdded?.skuId,
          spinId: option.spinId,
          skuId: option.skuId,
          quantity: group.quantity, // undefined for recipes (server defaults to 1)
        })
      );
      if (res.error) setError(res.error);
      if (res.cart) applyCart("recipe-swap", res.cart);
      if (res.addedSpinId) {
        setMessages((prev) =>
          prev.map((m) =>
            m === message
              ? {
                  ...m,
                  groups: m.groups.map((g) =>
                    g.ingredient === group.ingredient ? { ...g, addedSpinId: res.addedSpinId } : g
                  ),
                }
              : m
          )
        );
      }
    } catch (err) {
      if (isReauthError(err)) setReauthError(err.message);
      else setError(err.message);
    }
  }

  // Star toggle on a product card — saves the item to / removes it from the
  // local usuals list. No chat message; it's a list-config action.
  async function toggleSaveUsual(product) {
    const isSaved = savedKeys.has(usualKey(product));
    setError(null);
    try {
      const res = isSaved
        ? await api.instamartRemoveUsual(product.spinId, product.skuId)
        : await api.instamartSaveUsual(product);
      setUsuals(res.usuals || []);
    } catch (err) {
      if (isReauthError(err)) setReauthError(err.message);
      else setError(err.message);
    }
  }

  async function removeUsual(item) {
    setError(null);
    try {
      const res = await api.instamartRemoveUsual(item.spinId, item.skuId);
      setUsuals(res.usuals || []);
    } catch (err) {
      if (isReauthError(err)) setReauthError(err.message);
      else setError(err.message);
    }
  }

  async function changeSchedule(enabled, time) {
    setError(null);
    // Optimistic so the toggle/time feel instant; reconciled with the server's
    // returned row (which also carries last-run status).
    setSchedule((prev) => ({ ...prev, enabled, time }));
    try {
      const res = await api.instamartSetUsualsSchedule(enabled, enabled ? time : null);
      setSchedule(res);
    } catch (err) {
      if (isReauthError(err)) setReauthError(err.message);
      else setError(err.message);
      api.instamartUsualsSchedule().then((s) => setSchedule(s)).catch(() => {});
    }
  }

  async function reset() {
    await api.instamartChatReset();
    setMessages([]);
  }

  if (reauthError) return <ReauthNotice message={reauthError} />;

  return (
    <section className="panel instamart-panel">
      <header className="panel-header">
        <h2>Insta-nt</h2>
        <p className="panel-sub">
          Tell me what you need in plain words and I'll help you pick the right brand and size.
        </p>
      </header>

      <AddressPicker onSelected={() => setHasAddress(true)} />

      <div className="instamart-layout">
        <div className="chat-column">
          <div className="chat-messages" ref={scrollRef}>
            {messages.length === 0 && !sending && (
              <div className="chat-empty">
                <div className="chat-empty-avatar" aria-hidden="true">
                  <BagIcon />
                </div>
                <p className="chat-empty-title">Hi, I'm Insta-nt</p>
                <p className="chat-empty-sub">
                  Tell me what you need in plain words — I'll find the right brand and size, and you can attach a cart
                  screenshot from another app with the <strong>+</strong> button.
                </p>
                <div className="chat-starters">
                  {CHAT_STARTERS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="chat-starter"
                      onClick={() => sendMsg(s)}
                      disabled={sending || !hasAddress}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <ChatMessage
                key={i}
                message={m}
                disabled={sending || !hasAddress}
                savedKeys={savedKeys}
                onChoose={(opt) => sendMsg(opt)}
                onAdd={addProduct}
                onToggleSave={toggleSaveUsual}
                onShowMore={showMore}
                onConfirmRecipe={confirmRecipe}
                onSwapRecipe={swapRecipeOption}
                onConfirmImport={confirmImport}
              />
            ))}

            {sending && (
              <div className="chat-message chat-message-assistant chat-typing" aria-label="Insta-nt is thinking">
                <span className="chat-typing-dots" aria-hidden="true">
                  <span></span>
                  <span></span>
                  <span></span>
                </span>
                <span className="chat-typing-status" key={thinkingStep}>
                  {THINKING_LINES[thinkingStep]}
                </span>
              </div>
            )}
          </div>

          {/* Composer + footer live inside the same card as the transcript —
              see .chat-column / .chat-composer. */}
          <div className="chat-composer">
            {error && <p className="error-text chat-error">{error}</p>}

            {pendingImage && (
              <div className="pending-attachment">
                <img src={pendingImage} alt="Screenshot to import" className="pending-attachment-thumb" />
                <div className="pending-attachment-info">
                  <span className="pending-attachment-label">Ready to send</span>
                  <span className="pending-attachment-hint">
                    Add a note below if you want (e.g. "only the snacks"), then hit Send.
                  </span>
                </div>
                <button
                  type="button"
                  className="pending-attachment-remove"
                  onClick={() => setPendingImage(null)}
                  disabled={sending}
                  aria-label="Remove attached screenshot"
                >
                  ×
                </button>
              </div>
            )}

            {/* One utility row: the cart shortcuts on the left, Reset pushed
                to the right. Reset used to own a whole 44px footer strip of
                its own below the composer — a lot of the chat card's height
                for one small link. */}
            <div className="quick-actions">
              <button type="button" className="quick-action" onClick={clearCart} disabled={sending || !hasAddress}>
                Clear cart
              </button>
              <button
                type="button"
                className="quick-action"
                onClick={reorderUsuals}
                disabled={sending || !hasAddress || usuals.length === 0}
                title={usuals.length === 0 ? "Save an item with ☆ first" : "Add every saved usual to the cart"}
              >
                Reorder usuals
              </button>
              {/* "conversation" is hidden under 820px so all three utility
                  controls stay on one row on a phone instead of the reset
                  wrapping to a second row and doubling this row's height.
                  aria-label keeps the full wording for screen readers. */}
              <button
                className="link-button quick-actions-reset"
                onClick={reset}
                type="button"
                disabled={sending || messages.length === 0}
                aria-label="Reset conversation"
              >
                Reset<span className="quick-actions-reset-word"> conversation</span>
              </button>
            </div>

            <form onSubmit={onSubmit} className="chat-input-row">
              <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onImageChosen} />
              <button
                type="button"
                className="chat-attach-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={sending || !hasAddress}
                title="Attach a screenshot of another app's cart"
                aria-label="Attach a screenshot"
              >
                <PlusIcon />
              </button>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  !hasAddress
                    ? "Pick a delivery address first…"
                    : pendingImage
                      ? "Add a note (optional)…"
                      : "What do you want to order?"
                }
                disabled={sending || !hasAddress}
              />
              {/* Disabled unless there's something to send — an enabled Send
                  with an empty box is a button that lies about what it does.
                  A staged screenshot counts, since the note is optional. */}
              <button
                type="submit"
                disabled={sending || !hasAddress || (!input.trim() && !pendingImage)}
                aria-label="Send"
                title="Send"
              >
                <SendIcon />
              </button>
            </form>
          </div>
        </div>

        <div className="cart-column">
          {/* onMutate is not optional in practice: the +/- stepper is a cart
              write that never goes through runAction, so without it a poll can
              revert a quantity change (the most reproducible form of this bug
              — see the cart mutation guard above). */}
          <CartSummary
            cart={cart}
            onCartUpdate={(c) => applyCart("stepper", c)}
            onMutate={withCartMutation}
          />
          <UsualsPanel
            usuals={usuals}
            schedule={schedule}
            disabled={sending || !hasAddress}
            onRemove={removeUsual}
            onReorder={reorderUsuals}
            onScheduleChange={changeSchedule}
          />
        </div>
      </div>
    </section>
  );
}

function ChatMessage({ message, disabled, savedKeys, onChoose, onAdd, onToggleSave, onShowMore, onConfirmRecipe, onSwapRecipe, onConfirmImport }) {
  if (message.type === "ingredients") {
    return <IngredientChecklist message={message} disabled={disabled} onConfirm={onConfirmRecipe} />;
  }

  if (message.type === "import") {
    return <ImportChecklist message={message} disabled={disabled} onConfirm={onConfirmImport} />;
  }

  if (message.type === "recipe") {
    return <RecipeMessage message={message} disabled={disabled} onSwap={onSwapRecipe} />;
  }

  if (message.type === "choice") {
    return (
      <div className="chat-block chat-block-assistant">
        <div className="chat-message chat-message-assistant">{message.question}</div>
        <div className="choice-chips">
          {message.options.map((opt) => (
            <button
              key={opt}
              type="button"
              className={`choice-chip${opt === "Any brand" ? " choice-chip--any" : ""}`}
              onClick={() => onChoose(opt)}
              disabled={disabled}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (message.type === "products") {
    return (
      <div className="chat-block chat-block-assistant">
        {message.intro && <div className="chat-message chat-message-assistant">{message.intro}</div>}
        <div className="product-grid">
          {/* The index is in the key deliberately. Swiggy's search can return
              the same product twice (same spinId AND same skuId — see
              flattenVariants, which now dedupes it at the source), and when it
              does, enrichProducts hands back the SAME cached object reference
              for both, so no field of the product can tell the two apart. The
              index is the only discriminator that exists. Safe here because
              this list is append-only and never reorders — a rendered
              transcript message's products array is only ever rewritten
              in place (the out-of-stock patch in runAction), preserving order. */}
          {message.products.map((p, i) => (
            <ProductCard
              key={`${p.spinId}:${p.skuId}:${i}`}
              product={p}
              disabled={disabled}
              saved={savedKeys?.has(`${p.spinId}:${p.skuId}`)}
              onAdd={() => onAdd(p)}
              onToggleSave={() => onToggleSave(p)}
            />
          ))}
        </div>
        <button type="button" className="choice-chip show-more-chip" onClick={onShowMore} disabled={disabled}>
          Show more options
        </button>
      </div>
    );
  }

  if (message.image) {
    return (
      <div className={`chat-message chat-message-${message.role} chat-message--image`}>
        <img src={message.image} alt="Uploaded screenshot" className="chat-message-thumb" />
        {message.text && <span>{message.text}</span>}
      </div>
    );
  }

  return <div className={`chat-message chat-message-${message.role}`}>{message.text}</div>;
}

// Editable ingredient checklist the model proposed for a recipe request.
// Edits (remove ×, add via the small input) are local state until Confirm —
// only the final list is sent to the deterministic search-and-add endpoint.
// Once confirmed (or after a reload of a confirmed one), it renders inert.
function IngredientChecklist({ message, disabled, onConfirm }) {
  const [items, setItems] = useState(message.ingredients || []);
  const [draft, setDraft] = useState("");
  const confirmed = !!message.confirmed;

  function addDraft() {
    const v = draft.trim();
    if (!v) return;
    if (!items.some((i) => i.toLowerCase() === v.toLowerCase())) setItems([...items, v]);
    setDraft("");
  }

  return (
    <div className="chat-block chat-block-assistant">
      <div className="chat-message chat-message-assistant">
        Here's what you'll need for <strong>{message.dish}</strong> — remove anything you have, add anything I missed,
        then confirm:
      </div>
      {message.grounded && (
        <p className="ingredient-grounded-note">
          🔎 Based on real recipes from the web
          {message.sourceUrls?.length > 0 && (
            <>
              {" — "}
              {message.sourceUrls.map((u, i) => (
                <a key={u} href={u} target="_blank" rel="noreferrer">
                  [{i + 1}]
                </a>
              ))}
            </>
          )}
        </p>
      )}
      <div className={`ingredient-list${confirmed ? " ingredient-list--done" : ""}`}>
        <div className="ingredient-chips">
          {items.map((ing) => (
            <span key={ing} className="ingredient-chip">
              {ing}
              {!confirmed && (
                <button
                  type="button"
                  className="ingredient-chip-x"
                  onClick={() => setItems(items.filter((i) => i !== ing))}
                  disabled={disabled}
                  aria-label={`Remove ${ing}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {items.length === 0 && <span className="muted">Nothing left — add something below.</span>}
        </div>
        {!confirmed && (
          <div className="ingredient-actions">
            <div className="ingredient-add-row">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addDraft();
                  }
                }}
                placeholder="Add an ingredient…"
                disabled={disabled}
              />
              <button type="button" className="choice-chip" onClick={addDraft} disabled={disabled || !draft.trim()}>
                + Add
              </button>
            </div>
            <button
              type="button"
              className="ingredient-confirm-btn"
              onClick={() => onConfirm(message, items)}
              disabled={disabled || items.length === 0}
            >
              Confirm — find these {items.length} items
            </button>
          </div>
        )}
        {confirmed && <p className="ingredient-confirmed-note">✓ Confirmed</p>}
      </div>
    </div>
  );
}

// The items read off an uploaded screenshot, shown for review before anything
// touches the cart (the user chose review-first). Each row is editable: adjust
// the quantity, or remove a misread/unwanted item. Confirm sends the final
// list to the deterministic size-strict search-and-add. Renders inert once
// confirmed (or after reloading a confirmed one).
function ImportChecklist({ message, disabled, onConfirm }) {
  const [items, setItems] = useState(() => (message.items || []).map((it) => ({ ...it })));
  const confirmed = !!message.confirmed;

  function setQty(idx, delta) {
    setItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, quantity: Math.max(1, Math.min(20, (it.quantity || 1) + delta)) } : it))
    );
  }

  return (
    <div className="chat-block chat-block-assistant">
      <div className="chat-message chat-message-assistant">
        I read these off your screenshot — remove anything you don't want, adjust quantities, then confirm and I'll
        find them on Instamart:
      </div>
      <div className={`import-list${confirmed ? " import-list--done" : ""}`}>
        <ul className="import-rows">
          {items.map((it, idx) => (
            <li key={idx} className="import-row">
              <div className="import-row-info">
                <span className="import-row-name">{it.name}</span>
                {it.size && <span className="import-row-size">{it.size}</span>}
              </div>
              {confirmed ? (
                <span className="import-row-qty-static">×{it.quantity}</span>
              ) : (
                <span className="import-qty-stepper">
                  <button type="button" onClick={() => setQty(idx, -1)} disabled={disabled} aria-label="Decrease quantity">
                    −
                  </button>
                  <span>{it.quantity}</span>
                  <button type="button" onClick={() => setQty(idx, 1)} disabled={disabled} aria-label="Increase quantity">
                    +
                  </button>
                </span>
              )}
              {!confirmed && (
                <button
                  type="button"
                  className="import-row-remove"
                  onClick={() => setItems(items.filter((_, i) => i !== idx))}
                  disabled={disabled}
                  aria-label={`Remove ${it.name}`}
                >
                  ×
                </button>
              )}
            </li>
          ))}
          {items.length === 0 && <li className="muted">Nothing left — nothing to import.</li>}
        </ul>
        {!confirmed ? (
          <button
            type="button"
            className="ingredient-confirm-btn"
            onClick={() => onConfirm(message, items)}
            disabled={disabled || items.length === 0}
          >
            Confirm — add these {items.length} to my cart
          </button>
        ) : (
          <p className="ingredient-confirmed-note">✓ Confirmed</p>
        )}
      </div>
    </div>
  );
}

// Post-confirm recipe result: one compact row-group per ingredient, up to 3
// small options each (tiny thumb, no big card grid — deliberate, so a 10-
// ingredient recipe doesn't flood the chat). The added pick shows "✓ In cart";
// tapping another swaps it in the real cart. Reused by the screenshot-import
// result too (a group's `note` marks exact-match-added vs pick-an-option).
function RecipeMessage({ message, disabled, onSwap }) {
  return (
    <div className="chat-block chat-block-assistant">
      {message.reply && <div className="chat-message chat-message-assistant">{message.reply}</div>}
      <div className="recipe-groups">
        {(message.groups || []).map((g) => (
          <div key={g.ingredient} className="recipe-group">
            <p className="recipe-group-name">{g.ingredient}</p>
            {g.note && (
              <p className={`recipe-group-note${g.addedSpinId ? " recipe-group-note--ok" : ""}`}>{g.note}</p>
            )}
            {(g.options || []).length === 0 ? (
              <p className="recipe-group-missing">Couldn't find this one</p>
            ) : (
              <div className="recipe-options">
                {g.options.map((o) => {
                  const isAdded = g.addedSpinId === o.spinId;
                  return (
                    <div key={o.spinId} className={`recipe-option${isAdded ? " recipe-option--added" : ""}`}>
                      <ProductThumb src={o.imageUrl} alt={o.displayName} className="recipe-option-thumb" />
                      <div className="recipe-option-info">
                        <span className="recipe-option-name">{o.displayName}</span>
                        <span className="recipe-option-meta">
                          {o.quantityDescription && <span>{o.quantityDescription}</span>}
                          <span className="recipe-option-price">₹{o.offerPrice ?? o.mrp}</span>
                        </span>
                      </div>
                      {isAdded ? (
                        <span className="recipe-option-incart">✓ In cart</span>
                      ) : (
                        <button
                          type="button"
                          className="recipe-swap-btn"
                          onClick={() => onSwap(message, g, o)}
                          disabled={disabled}
                        >
                          {g.addedSpinId ? "Swap" : "Add"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductCard({ product: p, disabled, saved, onAdd, onToggleSave }) {
  const [explainOpen, setExplainOpen] = useState(false);
  const hasDiscount = p.mrp != null && p.offerPrice != null && p.mrp > p.offerPrice;
  const outOfStock = p.inStock === false;
  return (
    <div className={`product-card${outOfStock ? " product-card--oos" : ""}`}>
      <div className="product-card-imgwrap">
        <ProductThumb src={p.imageUrl} alt={p.displayName} className="product-card-img" />
        {outOfStock && <span className="oos-badge">Out of stock</span>}
        {/* Top-LEFT, mirroring the ☆ at top-right. Deliberately on the photo
            rather than in the footer: alongside the Add button it made the
            footer overflow the ~146px card once a discounted price showed a
            strikethrough MRP ("₹300 ₹999"), and .product-card's
            `overflow: hidden` then clipped Add off the card entirely. */}
        <button
          type="button"
          className="product-explain-btn"
          onClick={() => setExplainOpen(true)}
          aria-label={`Ask about ${p.displayName}`}
          title="Ask about this item"
        >
          <InfoIcon />
        </button>
        <button
          type="button"
          className={`product-card-star${saved ? " product-card-star--saved" : ""}`}
          onClick={onToggleSave}
          disabled={disabled}
          aria-pressed={!!saved}
          aria-label={saved ? `Remove ${p.displayName} from usuals` : `Save ${p.displayName} to usuals`}
          title={saved ? "Saved to usuals" : "Save to usuals"}
        >
          {saved ? "★" : "☆"}
        </button>
      </div>
      <div className="product-card-body">
        <p className="product-card-name">{p.displayName}</p>
        {p.quantityDescription && <p className="product-card-qty">{p.quantityDescription}</p>}
        {p.note && <p className="product-card-note">{p.note}</p>}
        <div className="product-card-footer">
          <span className="product-card-price">
            ₹{p.offerPrice ?? p.mrp}
            {hasDiscount && <span className="product-card-mrp">₹{p.mrp}</span>}
          </span>
          <button
            type="button"
            className="product-add-btn"
            onClick={onAdd}
            disabled={disabled || outOfStock}
          >
            {outOfStock ? "N/A" : "Add"}
          </button>
        </div>
      </div>
      {explainOpen && <ExplainModal product={p} onClose={() => setExplainOpen(false)} />}
    </div>
  );
}

// Per-item "Explain" popup — a self-contained, web-grounded Q&A scoped to one
// product. Deliberately separate from the main cart-building chat (its own
// overlay, frontend-only state, no server-side transcript) so researching an
// item never mixes into the ordering conversation. The first question
// triggers a web search server-side (cached per spinId for the rest of the
// backend process's life — see instamartAgent.js), so follow-up questions in
// the same session are just a plain completion, no repeat search.
// Starter prompts for the empty state — one tap instead of typing. Kept
// generic enough to make sense for any product (food, personal care, etc).
const EXPLAIN_SUGGESTIONS = ["What's in it?", "Is it healthy?", "How do I use it?", "Any downsides?"];

function ExplainModal({ product, onClose }) {
  const [history, setHistory] = useState([]); // [{role, content, grounded?, sourceUrls?}]
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState(null);
  const threadRef = useRef(null);

  // Same reasoning as the main transcript: scroll this element, not via a
  // sentinel that would also move ancestors.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [history, asking]);

  // Escape closes, and the page behind is scroll-locked while the dialog is
  // up — both standard modal behavior that was missing.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  async function submitQuestion(raw) {
    const q = String(raw || "").trim();
    if (!q || asking) return;
    setError(null);
    const nextHistory = [...history, { role: "user", content: q }];
    setHistory(nextHistory);
    setQuestion("");
    setAsking(true);
    try {
      const payload = {
        spinId: product.spinId,
        skuId: product.skuId,
        displayName: product.displayName,
        brand: product.brand,
        quantityDescription: product.quantityDescription,
        price: product.offerPrice ?? product.mrp ?? null,
      };
      const result = await api.instamartExplainItem(payload, q, history);
      setHistory([
        ...nextHistory,
        {
          role: "assistant",
          content: result.answer,
          basis: result.basis,
          grounded: result.grounded,
          sourceUrls: result.sourceUrls || [],
        },
      ]);
    } catch (err) {
      setError(err.message || "Couldn't get an answer");
    } finally {
      setAsking(false);
    }
  }

  const price = product.offerPrice ?? product.mrp;

  // Portalled to <body> ON PURPOSE, not rendered in place: `.product-card`
  // sets `overflow: hidden` and a `transform` on :hover, and a transform
  // makes that card the containing block for any `position: fixed`
  // descendant — which trapped this overlay inside the ~200px card and
  // clipped it (confirmed live: the dialog rendered as a squeezed column of
  // one-word-per-line text inside the grid cell). A portal takes it out of
  // the card's subtree entirely, so `position: fixed` resolves against the
  // viewport as intended.
  return createPortal(
    <div
      className="explain-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Ask about ${product.displayName}`}
      onClick={onClose}
    >
      <div className="explain-card" onClick={(e) => e.stopPropagation()}>
        <div className="explain-head">
          <ProductThumb src={product.imageUrl} alt={product.displayName} className="explain-thumb" />
          <div className="explain-head-info">
            <p className="explain-title">{product.displayName}</p>
            <p className="explain-sub">
              {product.quantityDescription}
              {product.quantityDescription && price != null ? " · " : ""}
              {price != null && <span className="explain-price">₹{price}</span>}
            </p>
          </div>
          <button type="button" className="explain-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="explain-thread" ref={threadRef}>
          {history.length === 0 && !asking && (
            <div className="explain-empty">
              <p className="explain-empty-title">Ask anything about this item</p>
              <p className="explain-empty-sub">Ingredients, nutrition, how it compares, reviews…</p>
              <div className="explain-suggestions">
                {EXPLAIN_SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="explain-suggestion" onClick={() => submitQuestion(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {history.map((h, i) => (
            <div key={i} className={`explain-msg explain-msg--${h.role}`}>
              <span className="explain-msg-text">{h.content}</span>
              {h.role === "assistant" && h.basis === "search" && h.sourceUrls?.length > 0 && (
                <span className="explain-sources">
                  Sources:{" "}
                  {h.sourceUrls.map((u, j) => (
                    <a key={u} href={u} target="_blank" rel="noreferrer">
                      [{j + 1}]
                    </a>
                  ))}
                </span>
              )}
              {/* Distinguishes a web-sourced answer from one recalled from the
                  model's own training — confirmed live these need telling
                  apart: "does this have caffeine?" used to be flatly refused
                  because the search snippet didn't mention it, even though
                  it's common knowledge. Now the model can answer from general
                  knowledge instead of refusing, but the UI says so plainly
                  rather than presenting it with the same confidence as a
                  cited, product-specific search result. */}
              {h.role === "assistant" && h.basis === "general_knowledge" && (
                <span className="explain-basis-note">
                  💭 General knowledge — not specific to this listing
                </span>
              )}
            </div>
          ))}
          {asking && (
            <div className="explain-msg explain-msg--assistant explain-msg--pending">
              <span className="explain-dot" />
              <span className="explain-dot" />
              <span className="explain-dot" />
            </div>
          )}
        </div>

        {error && <p className="explain-error">{error}</p>}

        <form
          className="explain-input-row"
          onSubmit={(e) => {
            e.preventDefault();
            submitQuestion(question);
          }}
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about this item…"
            disabled={asking}
            autoFocus
          />
          <button type="submit" disabled={asking || !question.trim()}>
            {asking ? "…" : "Ask"}
          </button>
        </form>
      </div>
    </div>,
    document.body
  );
}
