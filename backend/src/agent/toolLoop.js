import { createCompletionWithRetry } from "./groqClient.js";
import { config } from "../config.js";

// Groq has no server-side tool execution like Anthropic's beta MCP
// connector — every tool_call the model emits has to be executed here and
// fed back as a `role: "tool"` message before asking the model to continue.
// The loop ends either when the model replies with no tool_calls, or when it
// calls one of `finalToolNames` — a "turn-ending" tool whose args are handed
// back to the caller to act on (e.g. the Instamart agent's ask_choice /
// present_products, which render UI rather than feed a result back to the
// model).
export async function runToolLoop({
  messages,
  tools,
  executeTool,
  finalToolNames = [],
  maxIterations = 12,
  maxTokens = 4096,
}) {
  const finalSet = new Set(Array.isArray(finalToolNames) ? finalToolNames : [finalToolNames].filter(Boolean));
  const executedTools = [];

  for (let i = 0; i < maxIterations; i++) {
    const t0 = Date.now();
    const completion = await createCompletionWithRetry({
      model: config.groqModel,
      reasoning_effort: "low",
      messages,
      tools,
      tool_choice: "auto",
      max_tokens: maxTokens,
    });
    const completionMs = Date.now() - t0;

    const message = completion.choices[0].message;
    messages.push(message);

    const toolCalls = message.tool_calls || [];
    console.log(
      `[toolLoop] iter=${i} completion=${completionMs}ms toolCalls=${toolCalls.length} names=${toolCalls.map((t) => t.function.name).join(",")}`
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
          return { ...p, result: await executeTool(p.toolCall.function.name, p.args) };
        } catch (err) {
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
          finalArgs = s.args;
          finalToolName = s.toolCall.function.name;
        }
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
