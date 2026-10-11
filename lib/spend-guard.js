// Spend guard for Nebius Token Factory.
//
// The account holds $25 of promo credit and a real card. The card must never be
// charged, so:
//   - every model call is priced BEFORE it is sent, at its worst case
//     (all prompt tokens + the full max_tokens of output), and refused if that
//     worst case would take total spend past the soft stop;
//   - SOFT_STOP is $20. Past it nothing runs, period, unless the owner has
//     explicitly raised the stop in the environment after talking it over;
//   - HARD_CAP is $24, a dollar under the credit. No setting can lift the stop
//     above it, so the balance can never go negative.
// Actual spend is recorded from the usage the API returns, in a ledger file
// that survives restarts.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const CREDIT_USD = 25;
export const HARD_CAP_USD = 24;
export const DEFAULT_SOFT_STOP_USD = 20;

export class SpendCapError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "SpendCapError";
    this.details = details;
  }
}

// Prices per token in USD, from GET /v1/models?verbose=true on 2026-10-09.
// Unknown models are refused rather than guessed.
export const PRICES = {
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": { in: 0.06e-6, out: 0.24e-6 },
  "nvidia/Nemotron-3_5-Lightning": { in: 0.06e-6, out: 0.24e-6 },
  "nvidia/nemotron-3-super-120b-a12b": { in: 0.3e-6, out: 0.9e-6 },
  "nvidia/Nemotron-3-Ultra-550b-a55b": { in: 1.0e-6, out: 3.0e-6 },
  "zai-org/GLM-5.3-Flash": { in: 0.15e-6, out: 0.5e-6 },
  "deepseek-ai/DeepSeek-V4.1-Flash": { in: 0.3e-6, out: 1.2e-6 },
};

// Images are billed as prompt tokens; this is a deliberately high per-image
// estimate for the pre-call check (a 5x4 contact sheet measured ~4.3k tokens on GLM-5.3-Flash).
export const IMAGE_TOKEN_ESTIMATE = 6000;

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

export function softStopUsd(env = process.env) {
  const raw = env.CUTROOM_SOFT_STOP_USD;
  if (raw === undefined || raw === "") return DEFAULT_SOFT_STOP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SOFT_STOP_USD;
  return Math.min(n, HARD_CAP_USD);
}

export function priceFor(model) {
  const p = PRICES[model];
  if (!p) throw new SpendCapError(`No price on file for ${model}; refusing to call it.`, { model });
  return p;
}

// Rough, conservative token count for text: 1 token per 3 characters.
export function estimateTextTokens(text) {
  return Math.ceil(String(text ?? "").length / 3);
}

export function estimatePromptTokens(messages) {
  let tokens = 0;
  for (const m of messages) {
    if (typeof m.content === "string") tokens += estimateTextTokens(m.content);
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text") tokens += estimateTextTokens(part.text);
        else if (part.type === "image_url") tokens += IMAGE_TOKEN_ESTIMATE;
      }
    }
    if (m.tool_calls) tokens += estimateTextTokens(JSON.stringify(m.tool_calls));
    tokens += 8;
  }
  return tokens;
}

export function worstCaseUsd(model, promptTokens, maxTokens) {
  const p = priceFor(model);
  return promptTokens * p.in + maxTokens * p.out;
}

export function actualUsd(model, usage) {
  const p = priceFor(model);
  return (usage?.prompt_tokens ?? 0) * p.in + (usage?.completion_tokens ?? 0) * p.out;
}

export class SpendGuard {
  constructor({ ledgerPath, env = process.env, now = () => new Date() } = {}) {
    this.ledgerPath =
      ledgerPath || env.CUTROOM_LEDGER || path.join(os.homedir(), ".cutroom", "spend-ledger.json");
    this.env = env;
    this.now = now;
    this.inFlightUsd = 0;
    this.ledger = this.#load();
  }

  #load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.ledgerPath, "utf8"));
      if (typeof data.spent_usd === "number") return data;
    } catch {
      // first run
    }
    return { spent_usd: 0, calls: 0, by_model: {}, last: null };
  }

  #save() {
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    const tmp = this.ledgerPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.ledger, null, 2));
    fs.renameSync(tmp, this.ledgerPath);
  }

  // Re-read the ledger file (after a remote ledger was merged into it).
  reload() {
    this.ledger = this.#load();
  }

  get spentUsd() {
    return this.ledger.spent_usd;
  }

  status() {
    const stop = softStopUsd(this.env);
    return {
      spent_usd: round6(this.ledger.spent_usd),
      soft_stop_usd: stop,
      hard_cap_usd: HARD_CAP_USD,
      credit_usd: CREDIT_USD,
      remaining_before_stop_usd: round6(Math.max(0, stop - this.ledger.spent_usd - this.inFlightUsd)),
      calls: this.ledger.calls,
      by_model: this.ledger.by_model,
    };
  }

  // Reserve the worst case for one call. Throws SpendCapError if it could cross the stop.
  reserve({ model, messages, maxTokens }) {
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new SpendCapError("Every model call must set a positive integer max_tokens.", { model });
    }
    const promptTokens = estimatePromptTokens(messages);
    const worst = worstCaseUsd(model, promptTokens, maxTokens);
    const stop = softStopUsd(this.env);
    const projected = this.ledger.spent_usd + this.inFlightUsd + worst;
    if (projected > stop) {
      throw new SpendCapError(
        `Spend stop reached: $${round6(this.ledger.spent_usd)} spent, this call could cost up to $${round6(worst)}, stop is $${stop}.`,
        { spent_usd: round6(this.ledger.spent_usd), worst_case_usd: round6(worst), soft_stop_usd: stop },
      );
    }
    this.inFlightUsd += worst;
    let settled = false;
    return {
      worstCaseUsd: worst,
      settle: (usage) => {
        if (settled) return 0;
        settled = true;
        this.inFlightUsd = Math.max(0, this.inFlightUsd - worst);
        // If the API returns no usage, charge the worst case so the ledger never under-counts.
        const cost = usage ? actualUsd(model, usage) : worst;
        this.ledger.spent_usd += cost;
        this.ledger.calls += 1;
        const m = (this.ledger.by_model[model] ||= { usd: 0, calls: 0, prompt_tokens: 0, completion_tokens: 0 });
        m.usd = round6(m.usd + cost);
        m.calls += 1;
        m.prompt_tokens += usage?.prompt_tokens ?? 0;
        m.completion_tokens += usage?.completion_tokens ?? 0;
        this.ledger.last = { at: this.now().toISOString(), model, usd: round6(cost) };
        this.#save();
        return cost;
      },
      // A call that failed before reaching the model frees its reservation.
      release: () => {
        if (settled) return;
        settled = true;
        this.inFlightUsd = Math.max(0, this.inFlightUsd - worst);
      },
    };
  }
}
