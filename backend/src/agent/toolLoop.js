import { groq } from "./groqClient.js";
import { config } from "../config.js";

// Groq has no server-side tool execution like Anthropic's beta MCP
// connector — every tool_call the model emits has to be executed here and
// fed back as a `role: "tool"` message before asking the model to continue.
// This loop is shared by the food-discovery agent (one-shot, ends when a
// designated `finalToolName` is called) and the Instamart chat agent
// (multi-turn, ends when the model replies with no tool_calls).
export async function runToolLoop({ messages, tools, executeTool, finalToolName, maxIterations = 12 }) {
  const executedTools = [];

  for (let i = 0; i < maxIterations; i++) {
    const t0 = Date.now();
    const completion = await groq.chat.completions.create({
      model: config.groqModel,
      reasoning_effort: "low",
      messages,
      tools,
      tool_choice: "auto",
      max_tokens: 4096,
    });
    const completionMs = Date.now() - t0;

    const message = completion.choices[0].message;
    messages.push(message);

    const toolCalls = message.tool_calls || [];
    console.log(
      `[toolLoop] iter=${i} completion=${completionMs}ms toolCalls=${toolCalls.length} names=${toolCalls.map((t) => t.function.name).join(",")}`
    );
    if (toolCalls.length === 0) {
      return { text: message.content || "", finalArgs: null, executedTools };
    }

    let finalArgs = null;

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
        if (finalToolName && p.toolCall.function.name === finalToolName) {
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
        finalArgs = s.args;
        continue; // ending the loop — no tool result needed for this one
      }
      executedTools.push({ name: s.toolCall.function.name, args: s.args });
      messages.push({ role: "tool", tool_call_id: s.toolCall.id, content: JSON.stringify(s.result ?? null) });
    }

    if (finalArgs !== null) {
      return { text: message.content || "", finalArgs, executedTools };
    }
  }

  throw new Error("Tool loop exceeded max iterations without a final answer");
}
