import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { AddressPicker } from "./AddressPicker.jsx";
import { CartSummary } from "./CartSummary.jsx";
import { ProductThumb } from "./ProductThumb.jsx";
import { ReauthNotice, isReauthError } from "./ReauthNotice.jsx";

// Turn a /chat response into a renderable transcript message.
function assistantMessageFromResult(result) {
  if (result.choice) {
    return { role: "assistant", type: "choice", question: result.choice.question, options: result.choice.options || [] };
  }
  if (result.products) {
    return { role: "assistant", type: "products", intro: result.products.intro, products: result.products.items || [] };
  }
  return { role: "assistant", text: result.reply || "(no reply)" };
}

export function InstamartChat() {
  const [hasAddress, setHasAddress] = useState(false);
  const [messages, setMessages] = useState([]);
  const [cart, setCart] = useState(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [reauthError, setReauthError] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    api.instamartChatHistory().then((r) => setMessages(r.messages)).catch(() => {});
    api
      .instamartCart()
      .then((c) => setCart(c))
      .catch((err) => {
        if (isReauthError(err)) setReauthError(err.message);
        else setCart({ error: err.message });
      });
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
    runAction("Reorder my usual items", () => api.instamartReorderUsuals());
  }

  function clearCart() {
    runAction("Clear my cart", () => api.instamartClearCart());
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
                  Try <em>"add milk"</em> and I'll ask which brand, or say exactly what you want like{" "}
                  <em>"add Amul Taaza 500ml"</em>.
                </p>
              </div>
            )}

            {messages.map((m, i) => (
              <ChatMessage
                key={i}
                message={m}
                disabled={sending || !hasAddress}
                onChoose={(opt) => sendMsg(opt)}
                onAdd={addProduct}
                onShowMore={showMore}
              />
            ))}

            {sending && (
              <div className="chat-message chat-message-assistant chat-typing" aria-label="Pantry Pal is typing">
                <span></span>
                <span></span>
                <span></span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {error && <p className="error-text">{error}</p>}

          <div className="quick-actions">
            <button type="button" className="quick-action" onClick={reorderUsuals} disabled={sending || !hasAddress}>
              Reorder my usuals
            </button>
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
          <CartSummary cart={cart} />
        </div>
      </div>
    </section>
  );
}

function ChatMessage({ message, disabled, onChoose, onAdd, onShowMore }) {
  if (message.type === "choice") {
    return (
      <div className="chat-block chat-block-assistant">
        <div className="chat-message chat-message-assistant">{message.question}</div>
        <div className="choice-chips">
          {message.options.map((opt) => (
            <button key={opt} type="button" className="choice-chip" onClick={() => onChoose(opt)} disabled={disabled}>
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
            <ProductCard key={p.spinId} product={p} disabled={disabled} onAdd={() => onAdd(p)} />
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

function ProductCard({ product: p, disabled, onAdd }) {
  const hasDiscount = p.mrp != null && p.offerPrice != null && p.mrp > p.offerPrice;
  const outOfStock = p.inStock === false;
  return (
    <div className={`product-card${outOfStock ? " product-card--oos" : ""}`}>
      <div className="product-card-imgwrap">
        <ProductThumb src={p.imageUrl} alt={p.displayName} className="product-card-img" />
        {outOfStock && <span className="oos-badge">Out of stock</span>}
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
