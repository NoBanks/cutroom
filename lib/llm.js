// One OpenAI-compatible chat client for every agent.
//
// Provider "nebius" (default): NVIDIA Nemotron on Nebius Token Factory for all
// reasoning and tool use, plus a vision model on the same API for the crew's eyes.
// Every Nebius call is priced and checked by the spend guard before it is sent.
//
// Provider "gemini": the same agents on Gemini through Google's OpenAI-compatible
// endpoint, for the lablab.ai build. Selected with CUTROOM_PROVIDER=gemini.

import { Agent, fetch as undiciFetch } from "undici";
import { SpendGuard, SpendCapError } from "./spend-guard.js";

// Node's built-in fetch drops any reply whose headers take over 5 minutes, and a
// dispatcher from the npm undici cannot be mixed with the built-in fetch (different
// undici majors fail with a bare "fetch failed"). So model calls use undici's own
// fetch with its own Agent. Each call still has its own AbortController timeout.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 });

const PROVIDERS = {
  nebius: {
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    keyEnv: "NEBIUS_API_KEY",
    models: {
      // Deep reasoning: the Director's point of view, the Editor's cut, the Reviewer's verdict.
      reason: "nvidia/nemotron-3-super-120b-a12b",
      // Fast and cheap: tool-driving the timeline, coverage, small structured calls.
      fast: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
      // Eyes: reads contact sheets of the footage.
      vision: "zai-org/GLM-5.3-Flash",
    },
    guarded: true,
    supportsThinkingToggle: (model) => model.startsWith("nvidia/") || model.startsWith("zai-org/"),
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    models: {
      reason: "gemini-3-pro",
      fast: "gemini-3-flash",
      vision: "gemini-3-flash",
    },
    guarded: false,
    supportsThinkingToggle: () => false,
  },
};

export function providerName(env = process.env) {
  return env.CUTROOM_PROVIDER === "gemini" ? "gemini" : "nebius";
}

export function modelFor(tier, env = process.env) {
  const p = PROVIDERS[providerName(env)];
  const override = env[`CUTROOM_MODEL_${tier.toUpperCase()}`];
  return override || p.models[tier];
}

let guardSingleton = null;
export function spendGuard() {
  if (!guardSingleton) guardSingleton = new SpendGuard();
  return guardSingleton;
}
export function _setSpendGuardForTests(g) {
  guardSingleton = g;
}

let fetchImpl = (url, init) => undiciFetch(url, { ...init, dispatcher });
export function _setFetchForTests(f) {
  fetchImpl = f;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Low-level chat call. Returns { message, usage, model }.
export async function chat({
  tier = "fast",
  messages,
  tools,
  toolChoice,
  maxTokens,
  thinking = false,
  jsonSchema,
  temperature = 0.4,
  timeoutMs = 180_000,
  retries = 3,
  env = process.env,
  onEvent,
}) {
  const pname = providerName(env);
  const provider = PROVIDERS[pname];
  const model = modelFor(tier, env);
  const apiKey = env[provider.keyEnv];
  if (!apiKey) throw new Error(`${provider.keyEnv} is not set.`);

  const body = { model, messages, max_tokens: maxTokens, temperature };
  if (tools?.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }
  if (jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: jsonSchema.name || "output", schema: jsonSchema.schema, strict: false },
    };
  }
  if (provider.supportsThinkingToggle(model)) {
    body.chat_template_kwargs = { enable_thinking: Boolean(thinking) };
    // GLM also reads its own flag; on long visual tasks it may still reason, so
    // callers give vision calls enough max_tokens to finish the answer.
    if (model.startsWith("zai-org/") && !thinking) body.thinking = { type: "disabled" };
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // The guard is consulted on EVERY attempt, so retries can never sneak past the stop.
    const reservation = provider.guarded
      ? spendGuard().reserve({ model, messages, maxTokens })
      : null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // The request may have reached the model before the connection dropped,
      // so a network failure is charged at worst case rather than released.
      reservation?.settle(undefined);
      lastError = err;
      const why = err.name === "AbortError" ? `timeout after ${timeoutMs / 1000}s` : `${err.message}${err.cause ? ` (${err.cause.code || err.cause.message})` : ""}`;
      onEvent?.({ type: "retry", attempt, reason: why });
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      reservation?.settle(data.usage);
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error(`No message in response from ${model}`);
      if (env.CUTROOM_DEBUG) {
        console.error(`[llm] ${model} finish=${data.choices[0].finish_reason} content=${(message.content || "").length}ch reasoning=${(message.reasoning_content || message.reasoning || "").length}ch usage=${data.usage?.prompt_tokens}/${data.usage?.completion_tokens}`);
        if (!message.content) console.error(`[llm] reasoning tail: ${(message.reasoning_content || message.reasoning || "").slice(-400)}`);
      }
      return { message, usage: data.usage, model, finishReason: data.choices[0].finish_reason };
    }

    const text = await res.text().catch(() => "");
    // A rejected request (4xx other than 429) is not billed; a 5xx may have been.
    if (res.status >= 500) reservation?.settle(undefined);
    else reservation?.release();
    lastError = new Error(`${model} HTTP ${res.status}: ${text.slice(0, 300)}`);
    if (res.status === 429 || res.status >= 500) {
      onEvent?.({ type: "retry", attempt, reason: `HTTP ${res.status}` });
      await sleep(3000 * 2 ** attempt);
      continue;
    }
    throw lastError;
  }
  throw lastError;
}

// Pull a JSON object out of a model reply, tolerating code fences and stray prose.
export function parseJSONReply(text) {
  if (!text) throw new Error("Empty reply");
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) return JSON.parse(fence[1]);
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error(`Reply was not JSON: ${cleaned.slice(0, 200)}`);
  }
}

// Structured call: system prompt + user content (+ optional images) -> parsed JSON.
// One re-ask if the reply does not parse.
export async function generateJSON({
  system,
  user,
  images = [],
  schema,
  schemaName = "output",
  tier = "reason",
  maxTokens = 4000,
  thinking = false,
  env = process.env,
  onEvent,
  timeoutMs,
}) {
  const content = images.length
    ? [
        { type: "text", text: user },
        ...images.map((url) => ({ type: "image_url", image_url: { url } })),
      ]
    : user;
  const messages = [
    { role: "system", content: system },
    { role: "user", content },
  ];
  // Vision calls reason over many frames; give them far longer than text calls.
  const callTimeout = timeoutMs || (tier === "vision" ? 900_000 : 300_000);
  const first = await chat({
    tier, messages, maxTokens, thinking, env, onEvent, timeoutMs: callTimeout,
    jsonSchema: schema ? { name: schemaName, schema } : undefined,
  });
  try {
    return { data: parseJSONReply(first.message.content), model: first.model, usage: first.usage };
  } catch (err) {
    onEvent?.({ type: "reask", reason: err.message });
    const second = await chat({
      tier, maxTokens, thinking: false, env, onEvent, timeoutMs: callTimeout,
      jsonSchema: schema ? { name: schemaName, schema } : undefined,
      messages: [
        ...messages,
        { role: "assistant", content: first.message.content || "" },
        { role: "user", content: "That was not valid JSON. Reply with ONLY the JSON object, nothing else." },
      ],
    });
    return { data: parseJSONReply(second.message.content), model: second.model, usage: second.usage };
  }
}

export { SpendCapError };
