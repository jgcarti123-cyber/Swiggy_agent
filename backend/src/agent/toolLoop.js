import { createCompletionWithRetry } from "./groqClient.js";
import { config } from "../config.js";
import { NeedsReauthError } from "../auth/oauthClient.js";

// Groq has no server-side tool execution like Anthropic's beta MCP
// connector — every tool_call the model emits has to be executed here and
// fed back as a `role: "tool"` message before asking the model to continue.
// The loop ends when any of:
//  (a) the model replies with no tool_calls,
//  (b) it calls one of `finalToolNames` — a tool the model itself decided
//      ends the turn (args handed back, never executed),
//  (c) `executeTool` resolves to a { __endLoop, kind, payload } sentinel — a
//      tool that DID run for real, but whose result the caller has already
//      turned into the final answer deterministically, so there's no need to
//      feed it back and pay for another completion just to have the model
//      restate what the caller already decided.
// (c) exists because most of what used to be model judgment turned out to
// have exactly one correct outcome (e.g. "how many brands were found" —
// ask if 2+, otherwise show variants) — deciding that in code is free and
// instant, where asking the model to decide costs a full round-trip.
export async function runToolLoop({
  messages,
  tools,
  executeTool,
  finalToolNames = [],
  maxIterations = 12,
  maxTokens = 4096,
  // Forces this exact tool on iteration 0 only (falls back to "auto" from
  // iteration 1 on, same as if it had never been set) — for callers that
  // deterministically already know the model's free choice ("auto") isn't
  // reliable enough for this specific message. See sendMessage's
  // looksLikeRecipeRequest gate for the motivating case: with plain "auto",
  // Groq skipped calling propose_ingredients on roughly 1 in 3 identical
  // "order things for making biryani" requests, replying with a plain-text
  // ingredient list instead (no checklist UI, nothing addable) — confirmed
  // live, and confirmed to predate every other change in this file via
  // `git stash` before writing this fix.
  forceToolName = null,
}) {
  const finalSet = new Set(Array.isArray(finalToolNames) ? finalToolNames : [finalToolNames].filter(Boolean));
  const executedTools = [];

  for (let i = 0; i < maxIterations; i++) {
    const t0 = Date.now();
    // Request size in raw characters — a tokenizer-independent proxy for
    // prompt cost, logged alongside Groq's real usage numbers so a spike in
    // either (bigger transcript vs. bigger tool schema) is easy to tell apart.
    const requestChars = JSON.stringify(messages).length + JSON.stringify(tools).length;
    const toolChoice = i === 0 && forceToolName ? { type: "function", function: { name: forceToolName } } : "auto";
    let completion;
    try {
      completion = await createCompletionWithRetry({
        model: config.groqModel,
        reasoning_effort: "low",
        messages,
        tools,
        tool_choice: toolChoice,
        max_tokens: maxTokens,
      });
    } catch (err) {
      // Groq intermittently 400s a forced tool_choice with "Tool choice is
      // required, but model did not call a tool" (same failure mode already
      // handled for Explain's forced answer_question call in
      // instamartAgent.js) — on that specific error only, retry once unforced
      // rather than aborting the whole turn. Nothing has been pushed to
      // `messages` yet at this point, so reissuing the identical request is
      // safe.
      if (toolChoice !== "auto" && err?.status === 400 && /tool choice is required/i.test(err?.message || "")) {
        completion = await createCompletionWithRetry({
          model: config.groqModel,
          reasoning_effort: "low",
          messages,
          tools,
          tool_choice: "auto",
          max_tokens: maxTokens,
        });
      } else {
        throw err;
      }
    }
    const completionMs = Date.now() - t0;

    const message = completion.choices[0].message;
    messages.push(message);

    const toolCalls = message.tool_calls || [];
    const u = completion.usage || {};
    console.log(
      `[toolLoop] iter=${i} completion=${completionMs}ms reqChars=${requestChars} promptTok=${u.prompt_tokens ?? "?"} reasoningTok=${u.completion_tokens_details?.reasoning_tokens ?? "?"} completionTok=${u.completion_tokens ?? "?"} totalTok=${u.total_tokens ?? "?"} toolCalls=${toolCalls.length} names=${toolCalls.map((t) => t.function.name).join(",")}`
    );
    if (toolCalls.length === 0) {
      return { text: message.content || "", finalArgs: null, finalToolName: null, executedTools };
    }

    let finalArgs = null;
    let finalToolName = null;

    // Tool calls batched into one turn are independent — run them
    // concurrently instead of serializing network round-trips to Swiggy.
    const parsed = toolCalls.map((toolCall) => {
      try {
        return { toolCall, args: JSON.parse(toolCall.function.arguments || "{}") };
      } catch {
        return { toolCall, parseError: "Arguments were not valid JSON — retry with valid JSON." };
      }
    });

    const settled = await Promise.all(
      parsed.map(async (p) => {
        if (p.parseError) return p;
        if (finalSet.has(p.toolCall.function.name)) {
          return { ...p, isFinal: true };
        }
        try {
          const result = await executeTool(p.toolCall.function.name, p.args);
          if (result && typeof result === "object" && result.__endLoop) {
            return { ...p, isFinal: true, finalToolName: result.kind, result: result.payload, ranForReal: true };
          }
          return { ...p, result };
        } catch (err) {
          // A reauth failure isn't something the model can act on by
          // rephrasing its reply — feeding it back as tool-result text would
          // just have the model apologize in the chat instead of the app
          // surfacing the real "please reconnect" prompt. Let it abort the
          // whole turn (propagates out of Promise.all, uncaught here, up to
          // the route and Express's central error handler) instead.
          if (err instanceof NeedsReauthError) throw err;
          return { ...p, result: { error: err.message } };
        }
      })
    );

    for (const s of settled) {
      if (s.parseError) {
        messages.push({
          role: "tool",
          tool_call_id: s.toolCall.id,
          content: JSON.stringify({ error: s.parseError }),
        });
        continue;
      }
      if (s.isFinal) {
        // Only the first final tool in a batch wins.
        if (finalArgs === null) {
          finalArgs = s.ranForReal ? s.result : s.args;
          finalToolName = s.ranForReal ? s.finalToolName : s.toolCall.function.name;
        }
        // Unlike a model-named final tool (never executed), an __endLoop
        // sentinel means the tool actually ran — count it as executed.
        if (s.ranForReal) executedTools.push({ name: s.toolCall.function.name, args: s.args });
        // Still push a tool result so the assistant tool_call isn't left
        // dangling — the conversation is reused on the next turn, and the Groq
        // API rejects a tool_call with no matching tool response.
        messages.push({
          role: "tool",
          tool_call_id: s.toolCall.id,
          content: JSON.stringify({ ok: true, deliveredToUser: true }),
        });
        continue;
      }
      executedTools.push({ name: s.toolCall.function.name, args: s.args });
      messages.push({ role: "tool", tool_call_id: s.toolCall.id, content: JSON.stringify(s.result ?? null) });
    }

    if (finalArgs !== null) {
      return { text: message.content || "", finalArgs, finalToolName, executedTools };
    }
  }

  throw new Error("Tool loop exceeded max iterations without a final answer");
}
