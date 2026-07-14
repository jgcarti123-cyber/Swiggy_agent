import { useEffect, useMemo, useRef, useState } from "react";
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

// Turn a /chat response into a renderable transcript message.
function assistantMessageFromResult(result) {
  if (result.choice) {
    return { role: "assistant", type: "choice", question: result.choice.question, options: result.choice.options || [] };
  }
  if (result.products) {
    return { role: "assistant", type: "products", intro: result.products.intro, products: result.products.items || [] };
  }
  if (result.ingredients) {
    return { role: "assistant", type: "ingredients", dish: result.ingredients.dish, ingredients: result.ingredients.ingredients || [] };
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

// Rotating status shown with the typing dots while Pantry Pal works. Advances
// every couple of seconds and parks on the last line (never loops back —
// "Almost there…" restarting as "Thinking…" reads like a hang).
const THINKING_LINES = ["Thinking…", "Searching Instamart…", "Checking prices…", "Sorting the good stuff…", "Almost there…"];

export function InstamartChat() {
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
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);

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
      .then((c) => setCart(c))
      .catch((err) => {
        if (isReauthError(err)) setReauthError(err.message);
        else setCart({ error: err.message });
      });
    api.instamartUsuals().then((r) => setUsuals(r.usuals || [])).catch(() => {});
    api.instamartUsualsSchedule().then((s) => setSchedule(s)).catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
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
      const result = await apiCall();
      setMessages((prev) => [...prev, assistantMessageFromResult(result)]);
      if (result.cart) setCart(result.cart);
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
      const res = await api.instamartRecipeSwap({
        ingredient: group.ingredient,
        removeSpinId: prevAdded?.spinId,
        removeSkuId: prevAdded?.skuId,
        spinId: option.spinId,
        skuId: option.skuId,
        quantity: group.quantity, // undefined for recipes (server defaults to 1)
      });
      if (res.error) setError(res.error);
      if (res.cart) setCart(res.cart);
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
        <h2>Pantry Pal</h2>
        <p className="panel-sub">
          Tell me what you need in plain words and I'll help you pick the right brand and size.
        </p>
      </header>

      <AddressPicker onSelected={() => setHasAddress(true)} />

      <div className="instamart-layout">
        <div className="chat-column">
          <div className="chat-messages">
            {messages.length === 0 && !sending && (
              <div className="chat-empty">
                <p className="chat-empty-title">👋 Hi, I'm Pantry Pal</p>
                <p className="muted">
                  Try <em>"add milk"</em> and I'll ask which brand, say exactly what you want like{" "}
                  <em>"add Amul Taaza 500ml"</em>, or go big: <em>"order things for making biryani"</em>. You can also
                  attach a cart screenshot from another app using the icon by the message box.
                </p>
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
              <div className="chat-message chat-message-assistant chat-typing" aria-label="Pantry Pal is thinking">
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
            <div ref={bottomRef} />
          </div>

          {error && <p className="error-text">{error}</p>}

          <div className="quick-actions">
            <button type="button" className="quick-action" onClick={clearCart} disabled={sending || !hasAddress}>
              Clear cart
            </button>
          </div>

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
            <button type="submit" disabled={sending || !hasAddress}>
              {sending ? "…" : "Send"}
            </button>
          </form>
          <button className="link-button" onClick={reset} type="button">
            Reset conversation
          </button>
        </div>

        <div className="cart-column">
          <CartSummary cart={cart} onCartUpdate={setCart} />
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
          {message.products.map((p) => (
            <ProductCard
              key={p.spinId}
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
  const hasDiscount = p.mrp != null && p.offerPrice != null && p.mrp > p.offerPrice;
  const outOfStock = p.inStock === false;
  return (
    <div className={`product-card${outOfStock ? " product-card--oos" : ""}`}>
      <div className="product-card-imgwrap">
        <ProductThumb src={p.imageUrl} alt={p.displayName} className="product-card-img" />
        {outOfStock && <span className="oos-badge">Out of stock</span>}
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
    </div>
  );
}
