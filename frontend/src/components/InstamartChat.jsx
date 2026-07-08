import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { CartSummary } from "./CartSummary.jsx";
import { ReauthNotice, isReauthError } from "./ReauthNotice.jsx";

export function InstamartChat() {
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
  }, [messages]);

  async function send(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setError(null);
    setMessages((prev) => [...prev, { role: "user", text }]);
    setSending(true);
    try {
      const result = await api.instamartChatSend(text);
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

  async function reset() {
    await api.instamartChatReset();
    setMessages([]);
  }

  if (reauthError) return <ReauthNotice message={reauthError} />;

  return (
    <section className="panel instamart-panel">
      <h2>Instamart chat</h2>
      <div className="instamart-layout">
        <div className="chat-column">
          <div className="chat-messages">
            {messages.length === 0 && (
              <p className="muted">
                Try: "add 2 bananas and a liter of milk" or "what's in my cart?"
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-message chat-message-${m.role}`}>
                {m.text}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          {error && <p className="error-text">{error}</p>}
          <form onSubmit={send} className="chat-input-row">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="What do you want to order?"
              disabled={sending}
            />
            <button type="submit" disabled={sending}>
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
