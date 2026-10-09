// Adapter between the crew and lib/llm.js. Keeps the agents' original
// generateJSON(system, user, schema) call shape, plus per-agent options.
import { generateJSON as llmJSON } from "../lib/llm.js";

export async function generateJSON(systemPrompt, userContent, schema, options = {}) {
  const { data } = await llmJSON({
    system: systemPrompt,
    user: userContent,
    schema,
    tier: options.tier || "reason",
    thinking: options.thinking ?? true,
    maxTokens: options.maxTokens || 6000,
    images: options.images || [],
    onEvent: options.onEvent,
    timeoutMs: options.timeoutMs,
  });
  return data;
}
