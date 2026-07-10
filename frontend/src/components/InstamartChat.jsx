import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { AddressPicker } from "./AddressPicker.jsx";
import { CartSummary } from "./CartSummary.jsx";
import { ReauthNotice, isReauthError } from "./ReauthNotice.jsx";

const QUICK_ACTIONS = [
  { label: "Reorder my usuals", message: "Reorder my usual items" },
  { label: "Clear cart", message: "Clear my cart" },
];

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

  async function sendText(text) {
    const trimmed = text.trim();
    if (!trimmed || sending || !hasAddress) return;
    setInput("");
    setError(null);
    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setSending(true);
    try {
      const result = await api.instamartChatSend(trimmed);
      setMessages((prev) => [...prev, { role: "assistant", text: result.reply || "(no reply)" }]);
      if (result.cart) setCart(result.cart);
    } catch (err) {
      if (isReauthError(err)) {
        setReauthError(err.message);
      } else {
        setError(err.message);
      }
    } finally {
      setSending(false);
    }
  }

  function send(e) {
    e.preventDefault();
    sendText(input);
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
          Tell me what you need in plain words and I'll build your Instamart cart for you.
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
                  Try <em>"add 2 bananas and a litre of milk"</em>, <em>"remove the bread"</em>, or{" "}
                  <em>"checkout with cash"</em>.
                </p>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-message chat-message-${m.role}`}>
                {m.text}
              </div>
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
                onClick={() => sendText(qa.message)}
                disabled={sending || !hasAddress}
              >
                {qa.label}
              </button>
            ))}
          </div>

          <form onSubmit={send} className="chat-input-row">
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
