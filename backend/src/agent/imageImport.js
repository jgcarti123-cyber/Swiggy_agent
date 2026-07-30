import { createCompletionWithRetry } from "./groqClient.js";
import { config } from "../config.js";

// Reads a screenshot of another quick-commerce app's cart/order (Zepto,
// Blinkit, Instamart, BigBasket, etc.) and pulls out the grocery line items.
// This is the ONE genuinely-vision step in the whole app — everything after
// it (search, size-match, add) is the same deterministic pipeline a typed
// request goes through. gpt-oss-120b (the app's default model) has no image
// input, so this uses a separate multimodal model (config.groqVisionModel).
//
// Deliberately narrow: extract product line items only. Prices, discounts,
// delivery ETAs, payment buttons, addresses, "you saved ₹X" banners — all
// ignored. Per item we want the same three things a typed order carries: a
// generic product name, the pack size (so §6.14's size-strict matching can
// run), and the quantity shown.
const EXTRACT_PROMPT = `You are reading a screenshot of a grocery / quick-commerce shopping cart or order summary. Extract ONLY the product line items.

For each product return:
- "name": brand + product, as a short generic grocery search term. Strip marketing fluff, flavour taglines in parentheses, and "combo/pack" wording. E.g. "SuperYou 10g Protein Wafer Bar - Strawberry Creme (Made with Atta...)" -> "SuperYou Protein Wafer Bar Strawberry". Keep the brand.
- "size": the pack size / weight / volume / count shown for that item, verbatim and normalized to a simple form like "40 g", "1 kg", "450 g", "500 ml", "6 pieces". If no size is visible, use null.
- "quantity": the integer quantity/count shown for that line (the number in the quantity stepper). Default 1 if not visible.

Ignore everything that is not a product the user is buying: prices, MRPs, discounts, "you saved" banners, delivery time, payment/UPI offers, address, bag options, totals, buttons.

Respond with ONLY a JSON object: {"items": [{"name": string, "size": string|null, "quantity": number}]}. No prose.`;

// The user can optionally type a caption alongside the upload (e.g. "only
// get the snacks", "double everything", "skip the drinks") — this is the
// "ask questions" the review-checklist UI enables. It's appended as an
// explicit user instruction the model should follow when deciding what to
// extract, not just decorative chat text.
function buildPrompt(instructions) {
  if (!instructions) return EXTRACT_PROMPT;
  return `${EXTRACT_PROMPT}\n\nThe user also gave this instruction about the image — follow it: "${instructions}"`;
}

export async function extractItemsFromImage(dataUrl, instructions) {
  const completion = await createCompletionWithRetry({
    model: config.groqVisionModel,
    temperature: 0,
    max_tokens: 1200,
    // qwen3.6-27b defaults to "thinking mode" (a <think>...</think> preamble
    // before the real answer) — confirmed live this burns the whole max_tokens
    // budget on reasoning text and returns truncated/no JSON. This is a plain
    // extraction task with no real reasoning needed, so turn thinking off;
    // confirmed live this returns the bare JSON object directly.
    reasoning_effort: "none",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildPrompt(instructions) },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  const text = completion.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Some vision models wrap JSON in prose despite response_format — salvage
    // the first {...} block rather than failing the whole import.
    const match = text.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : { items: [] };
  }

  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  return items
    .map((it) => ({
      name: String(it?.name || "").trim(),
      size: it?.size ? String(it.size).trim() : null,
      quantity: Math.max(1, Math.min(20, Math.round(Number(it?.quantity) || 1))),
    }))
    .filter((it) => it.name)
    .slice(0, 20); // a cart screenshot with 20+ distinct items is not the target case
}
