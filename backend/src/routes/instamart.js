import { Router } from "express";
import { instamartClient } from "../mcp/instamartClient.js";
import { sendMessage, resetConversation, getConversationForDisplay } from "../agent/instamartAgent.js";

export const instamartRouter = Router();

instamartRouter.get("/addresses", async (req, res) => {
  const page = Number(req.query.page || 1);
  const pageSize = Number(req.query.pageSize || 10);
  res.json(await instamartClient.getAddresses({ page, pageSize }));
});

instamartRouter.get("/cart", async (req, res) => {
  res.json(await instamartClient.getCart());
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
  const result = await sendMessage(message);
  res.json(result);
});
