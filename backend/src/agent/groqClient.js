import Groq from "groq-sdk";
import { config } from "../config.js";

export const groq = new Groq({ apiKey: config.groqApiKey });

// Groq's free tier has a low tokens-per-minute ceiling (8000 TPM as of this
// writing) that a single relevance-judgment call can approach on its own —
// verified live, hit mid-session during ordinary back-to-back searches, not
// just synthetic load. A 429 here is routine on this tier, not exceptional,
// so it's worth one short retry rather than immediately falling back to
// "couldn't verify."
export async function createCompletionWithRetry(params, { retries = 2, delayMs = 2500 } = {}) {
  try {
    return await groq.chat.completions.create(params);
  } catch (err) {
    if (retries > 0 && err?.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return createCompletionWithRetry(params, { retries: retries - 1, delayMs });
    }
    throw err;
  }
}
