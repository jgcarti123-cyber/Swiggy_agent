import { Router } from "express";
import { instamartClient } from "../mcp/instamartClient.js";
import { getSavedAddress } from "../db.js";
import { sendMessage, resetConversation, getConversationForDisplay } from "../agent/instamartAgent.js";

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

instamartRouter.post("/chat", async (req, res) => {
  const message = String(req.body?.message || "").trim();
  // Optional: an "intent" string sent to the LLM instead of the visible
  // message — e.g. an Add-button click shows a clean label but sends the exact
  // spinId/skuId to the model so it adds the right variant without guessing.
  const intent = String(req.body?.intent || "").trim();
  if (!message) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "message is required" });
    return;
  }
  // The delivery address is resolved here (from the address the user picked in
  // the UI) and passed to the agent, which injects it into every tool call —
  // the model never asks for or handles an address.
  const saved = getSavedAddress();
  if (!saved) {
    res.status(400).json({ error: "NO_ADDRESS", message: "Select a delivery address first." });
    return;
  }
  const result = await sendMessage(intent || message, saved.address_id, message);
  res.json(result);
});
