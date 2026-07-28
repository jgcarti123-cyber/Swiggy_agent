import { Router } from "express";
import { instamartClient } from "../mcp/instamartClient.js";
import {
  getSavedAddress,
  getUsualsSchedule,
  setUsualsSchedule,
  markScheduleScheduled,
  clearScheduleMarker,
} from "../db.js";
import {
  sendMessage,
  resetConversation,
  getConversationForDisplay,
  addItemDirect,
  showMoreDirect,
  clearCartDirect,
  reorderUsualsDirect,
  setItemQuantity,
  saveUsualDirect,
  removeUsualDirect,
  getUsuals,
  confirmRecipeDirect,
  swapRecipeItemDirect,
  importImageDirect,
  confirmImportDirect,
  explainItem,
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

// Quantity stepper on a cart line item. quantity <= 0 removes it.
instamartRouter.post("/set-quantity", async (req, res) => {
  const { spinId, skuId, quantity } = req.body || {};
  if (!spinId || !skuId || quantity === undefined) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "spinId, skuId, and quantity are required" });
    return;
  }
  const addressId = requireSavedAddress(res);
  if (!addressId) return;
  const result = await setItemQuantity({ addressId, spinId, skuId, quantity: Number(quantity) });
  res.json(result);
});

// Recipe flow step 2: the user confirmed (possibly edited) the ingredient
// checklist the model proposed. Fully deterministic from here — parallel
// searches + best-per-ingredient auto-add, zero LLM calls.
instamartRouter.post("/recipe-confirm", async (req, res) => {
  const { dish, ingredients } = req.body || {};
  if (!Array.isArray(ingredients)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "ingredients array is required" });
    return;
  }
  const addressId = requireSavedAddress(res);
  if (!addressId) return;
  const result = await confirmRecipeDirect({
    dish: String(dish || "your dish"),
    ingredients,
    addressId,
  });
  res.json(result);
});

// Swap which option is in the cart for one recipe ingredient (also used by the
// screenshot-import flow to add/swap a not-found item's chosen option).
instamartRouter.post("/recipe-swap", async (req, res) => {
  const { ingredient, removeSpinId, removeSkuId, spinId, skuId, quantity } = req.body || {};
  if (!spinId || !skuId) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "spinId and skuId are required" });
    return;
  }
  const addressId = requireSavedAddress(res);
  if (!addressId) return;
  const result = await swapRecipeItemDirect({ addressId, ingredient, removeSpinId, removeSkuId, spinId, skuId, quantity });
  res.json(result);
});

// Import step 1: read line items off an uploaded screenshot of another app's
// cart (the one vision call). Returns an editable checklist. No delivery
// address needed yet — this is just OCR/extraction.
instamartRouter.post("/import-image", async (req, res) => {
  const { image, note } = req.body || {};
  if (typeof image !== "string" || !image.startsWith("data:image/")) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "image must be a data:image/... URL" });
    return;
  }
  const result = await importImageDirect({ image, note });
  res.json(result);
});

// Import step 2: the user confirmed (possibly edited) the extracted list.
// Deterministic from here — same pipeline as a typed order, size-strict.
instamartRouter.post("/import-confirm", async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "items array is required" });
    return;
  }
  const addressId = requireSavedAddress(res);
  if (!addressId) return;
  const result = await confirmImportDirect({ items, addressId });
  res.json(result);
});

// Per-item "Explain" popup — web-grounded Q&A about one product. No delivery
// address needed (this never touches the cart or Swiggy tools, just a web
// search + a Groq completion), and works even without a Tavily key (falls
// back to the model's own knowledge, clearly marked `grounded: false`).
instamartRouter.post("/explain-item", async (req, res) => {
  const { spinId, skuId, displayName, brand, quantityDescription, price, question, history } = req.body || {};
  if (!question || !String(question).trim()) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "question is required" });
    return;
  }
  const result = await explainItem({
    spinId,
    skuId,
    displayName,
    brand,
    quantityDescription,
    price,
    question,
    history,
  });
  res.json(result);
});

// --- Usuals (local, user-editable reorder list) + daily auto-add schedule.
// These are local-state only — no Swiggy call, no delivery address needed —
// except the schedule which the backend scheduler uses at trigger time. ---

instamartRouter.get("/usuals", (req, res) => {
  res.json({ usuals: getUsuals() });
});

instamartRouter.post("/usuals", (req, res) => {
  const { spinId, skuId } = req.body || {};
  if (!spinId) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "spinId is required" });
    return;
  }
  res.json(saveUsualDirect(req.body || {}));
});

instamartRouter.post("/usuals/remove", (req, res) => {
  const { spinId, skuId } = req.body || {};
  if (!spinId) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "spinId is required" });
    return;
  }
  res.json(removeUsualDirect({ spinId, skuId }));
});

instamartRouter.get("/usuals/schedule", (req, res) => {
  res.json(getUsualsSchedule());
});

instamartRouter.put("/usuals/schedule", (req, res) => {
  const { enabled, time } = req.body || {};
  // "HH:MM" 24-hour, matching an <input type="time"> value. Reject anything
  // else so a bad value can't leave the scheduler comparing against garbage.
  if (enabled && !/^\d{2}:\d{2}$/.test(String(time || ""))) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "time must be HH:MM when enabling" });
    return;
  }
  const saved = setUsualsSchedule({ enabled: !!enabled, time: time || null });

  // Prime today's run-marker so a newly-set time takes effect from its next
  // occurrence, never retroactively (see db.js). Only relevant when enabled.
  if (enabled) {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const [h, m] = String(time).split(":").map(Number);
    const alreadyPassed = now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
    if (alreadyPassed) markScheduleScheduled(today);
    else clearScheduleMarker();
    res.json(getUsualsSchedule());
    return;
  }
  res.json(saved);
});
