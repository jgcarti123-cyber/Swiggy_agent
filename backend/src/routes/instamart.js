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
  const result = await sendMessage(message, saved.address_id);
  res.json(result);
});
