import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { AddressPicker } from "./AddressPicker.jsx";
import { CartSummary } from "./CartSummary.jsx";
import { ProductThumb } from "./ProductThumb.jsx";
import { ReauthNotice, isReauthError } from "./ReauthNotice.jsx";

const QUICK_ACTIONS = [
  { label: "Reorder my usuals", message: "Reorder my usual items" },
  { label: "Clear cart", message: "Clear my cart" },
];

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

  // displayText shows in the transcript; intentText (optional) is what the
  // model actually receives (used by Add buttons to pass exact spinId/skuId).
  async function sendMsg(displayText, intentText) {
    const trimmed = (displayText || "").trim();
    if (!trimmed || sending || !hasAddress) return;
    setInput("");
    setError(null);
    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setSending(true);
    try {
      const result = await api.instamartChatSend(trimmed, intentText);
      setMessages((prev) => [...prev, assistantMessageFromResult(result)]);
      if (result.cart) setCart(result.cart);
    } catch (err) {
      if (isReauthError(err)) setReauthError(err.message);
      else setError(err.message);
    } finally {
      setSending(false);
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    sendMsg(input);
  }

  function addProduct(p) {
    const size = p.quantityDescription ? ` (${p.quantityDescription})` : "";
    const display = `Add ${p.displayName}${size}`;
    // Explicit merge instruction + exact ids so the model reliably calls
    // get_cart then update_cart with the full list, rather than replying as if
    // it added the item without actually touching the cart.
    const intent = `Add this exact item to my cart, keeping everything already in the cart: ${p.displayName}${p.quantityDescription ? `, ${p.quantityDescription}` : ""}, spinId=${p.spinId}, skuId=${p.skuId}, quantity 1. Call get_cart then update_cart with the merged list.`;
    sendMsg(display, intent);
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
                onShowMore={() => sendMsg("Show me more options")}
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
            {QUICK_ACTIONS.map((qa) => (
              <button
                key={qa.label}
                type="button"
                className="quick-action"
                onClick={() => sendMsg(qa.message)}
                disabled={sending || !hasAddress}
              >
                {qa.label}
              </button>
            ))}
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
  return (
    <div className="product-card">
      <ProductThumb src={p.imageUrl} alt={p.displayName} className="product-card-img" />
      <div className="product-card-body">
        <p className="product-card-name">{p.displayName}</p>
        {p.quantityDescription && <p className="product-card-qty">{p.quantityDescription}</p>}
        {p.note && <p className="product-card-note">{p.note}</p>}
        <div className="product-card-footer">
          <span className="product-card-price">
            ₹{p.offerPrice ?? p.mrp}
            {hasDiscount && <span className="product-card-mrp">₹{p.mrp}</span>}
          </span>
          <button type="button" className="product-add-btn" onClick={onAdd} disabled={disabled}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
