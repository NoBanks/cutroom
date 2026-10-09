import fs from "node:fs";
import { chat } from "../lib/llm.js";
const img = "data:image/jpeg;base64," + fs.readFileSync(process.argv[2]).toString("base64");
const schema = { type: "object", properties: { subject: { type: "string" }, first_time: { type: "string" } }, required: ["subject", "first_time"] };
for (const withSchema of [true, false]) {
  const r = await chat({
    tier: "vision", maxTokens: 1500, thinking: false,
    jsonSchema: withSchema ? { name: "x", schema } : undefined,
    messages: [{ role: "system", content: "You log footage. Output only JSON." },
      { role: "user", content: [{ type: "text", text: 'Return JSON {"subject":..., "first_time": timestamp on first frame}' }, { type: "image_url", image_url: { url: img } }] }],
  });
  const m = r.message;
  console.log(withSchema ? "WITH schema" : "NO schema", "| finish:", r.finishReason, "| content:", JSON.stringify((m.content || "").slice(0, 160)), "| reasoning chars:", (m.reasoning_content || m.reasoning || "").length, "| usage:", r.usage.prompt_tokens, r.usage.completion_tokens);
}
