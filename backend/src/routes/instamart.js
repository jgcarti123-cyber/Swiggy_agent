import { Router } from "express";
import { instamartClient } from "../mcp/instamartClient.js";
import { getSavedAddress } from "../db.js";
import {
  sendMessage,
  resetConversation,
  getConversationForDisplay,
  addItemDirect,
  showMoreDirect,
  clearCartDirect,
  reorderUsualsDirect,
} from "../agent/instamartAgent.js";

export const instamartRouter = Router();

instamartRouter.get("/addresses", async (req, res) => {
  const page = Number(req.query.page || 1);
  const pageSize = Number(req.query.pageSize || 10);
  res.json(await instamartClient.getAddresses({ page, pageSize }));
});

instamartRouter.get("/cart", async (req, res) => {
  // getCartOrEmpty so a "no cart yet" state renders as an empty cart in the UI
  // instead of a 502 tool error.
  res.json(await instamartClient.getCartOrEmpty());
});

instamartRouter.get("/chat/history", (req, res) => {
  res.json({ messages: getConversationForDisplay() });
});

instamartRouter.post("/chat/reset", (req, res) => {
  resetConversation();
  res.json({ ok: true });
});

function requireSavedAddress(res) {
  const saved = getSavedAddress();
  if (!saved) {
    res.status(400).json({ error: "NO_ADDRESS", message: "Select a delivery address first." });
    return null;
  }
  return saved.address_id;
}

instamartRouter.post("/chat", async (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!message) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "message is required" });
    return;
  }
  // The delivery address is resolved here (from the address the user picked in
  // the UI) and passed to the agent, which injects it into every tool call —
  // the model never asks for or handles an address.
  const addressId = requireSavedAddress(res);
  if (!addressId) return;
  const result = await sendMessage(message, addressId);
  res.json(result);
});

// --- Deterministic actions: bypass the LLM entirely for interactions that
// only ever have one correct outcome once the input is known (a card's exact
// spinId/skuId, "clear the cart", etc). See instamartAgent.js's *Direct
// functions for why — these used to route through the chat loop and cost
// 2-3 Groq completions apiece. ---

instamartRouter.post("/add-item", async (req, res) => {
  const { spinId, skuId, quantity, displayText } = req.body || {};
  if (!spinId || !skuId) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "spinId and skuId are required" });
    return;
  }
  const addressId = requireSavedAddress(res);
  if (!addressId) return;
  const result = await addItemDirect({
    spinId,
    skuId,
    quantity: Number(quantity) || 1,
    addressId,
    displayText: displayText || "Add item",
  });
  res.json(result);
});

instamartRouter.post("/show-more", async (req, res) => {
  const addressId = requireSavedAddress(res);
  if (!addressId) return;
  const result = await showMoreDirect({ addressId });
  res.json(result);
});

instamartRouter.post("/clear-cart", async (req, res) => {
  const addressId = requireSavedAddress(res);
  if (!addressId) return;
  const result = await clearCartDirect({ addressId });
  res.json(result);
});

instamartRouter.post("/reorder-usuals", async (req, res) => {
  const addressId = requireSavedAddress(res);
  if (!addressId) return;
  const result = await reorderUsualsDirect({ addressId });
  res.json(result);
});
