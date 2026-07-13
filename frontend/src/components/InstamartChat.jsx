import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { AddressPicker } from "./AddressPicker.jsx";
import { CartSummary } from "./CartSummary.jsx";
import { UsualsPanel } from "./UsualsPanel.jsx";
import { ProductThumb } from "./ProductThumb.jsx";
import { ReauthNotice, isReauthError } from "./ReauthNotice.jsx";

const usualKey = (item) => `${item.spinId}:${item.skuId}`;

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
  return { role: "assistant", text: result.reply || "(no reply)" };
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
  const [sending, setSending] = useState(false);
  const [thinkingStep, setThinkingStep] = useState(0);
  const [error, setError] = useState(null);
  const [reauthError, setReauthError] = useState(null);
  const bottomRef = useRef(null);

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
  // the deterministic direct-action endpoints.
  async function runAction(displayText, apiCall) {
    if (sending || !hasAddress) return;
    setError(null);
    setMessages((prev) => [...prev, { role: "user", text: displayText }]);
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
    sendMsg(input);
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
                  <em>"add Amul Taaza 500ml"</em>, or go big: <em>"order things for making biryani"</em>.
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

          <form onSubmit={onSubmit} className="chat-input-row">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={hasAddress ? "What do you want to order?" : "Pick a delivery address first…"}
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

function ChatMessage({ message, disabled, savedKeys, onChoose, onAdd, onToggleSave, onShowMore, onConfirmRecipe, onSwapRecipe }) {
  if (message.type === "ingredients") {
    return <IngredientChecklist message={message} disabled={disabled} onConfirm={onConfirmRecipe} />;
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

// Post-confirm recipe result: one compact row-group per ingredient, up to 3
// small options each (tiny thumb, no big card grid — deliberate, so a 10-
// ingredient recipe doesn't flood the chat). The added pick shows "✓ In cart";
// tapping another swaps it in the real cart.
function RecipeMessage({ message, disabled, onSwap }) {
  return (
    <div className="chat-block chat-block-assistant">
      {message.reply && <div className="chat-message chat-message-assistant">{message.reply}</div>}
      <div className="recipe-groups">
        {(message.groups || []).map((g) => (
          <div key={g.ingredient} className="recipe-group">
            <p className="recipe-group-name">{g.ingredient}</p>
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
