import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SpendGuard,
  SpendCapError,
  softStopUsd,
  HARD_CAP_USD,
} from "../lib/spend-guard.js";

const NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
const ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b";
const msgs = [{ role: "user", content: "hi" }];

function tmpLedger(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-"));
  const p = path.join(dir, "ledger.json");
  if (data) fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

test("default stop is $20", () => {
  assert.equal(softStopUsd({}), 20);
});

test("no setting can lift the stop past $24", () => {
  assert.equal(softStopUsd({ CUTROOM_SOFT_STOP_USD: "25" }), HARD_CAP_USD);
  assert.equal(softStopUsd({ CUTROOM_SOFT_STOP_USD: "1000" }), 24);
  assert.equal(softStopUsd({ CUTROOM_SOFT_STOP_USD: "garbage" }), 20);
  assert.equal(softStopUsd({ CUTROOM_SOFT_STOP_USD: "-5" }), 20);
});

test("records actual usage and persists across restarts", () => {
  const ledgerPath = tmpLedger();
  const g = new SpendGuard({ ledgerPath, env: {} });
  const r = g.reserve({ model: NANO, messages: msgs, maxTokens: 100 });
  r.settle({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  assert.ok(Math.abs(g.spentUsd - 0.3) < 1e-9);
  const again = new SpendGuard({ ledgerPath, env: {} });
  assert.ok(Math.abs(again.spentUsd - 0.3) < 1e-9);
  assert.equal(again.status().calls, 1);
});

test("refuses a call whose worst case would cross $20", () => {
  const ledgerPath = tmpLedger({ spent_usd: 19.99, calls: 5, by_model: {}, last: null });
  const g = new SpendGuard({ ledgerPath, env: {} });
  // Ultra, 10k output tokens worst case = $0.03 -> would cross 20
  assert.throws(() => g.reserve({ model: ULTRA, messages: msgs, maxTokens: 10_000 }), SpendCapError);
});

test("at $20 nothing runs at all", () => {
  const ledgerPath = tmpLedger({ spent_usd: 20, calls: 9, by_model: {}, last: null });
  const g = new SpendGuard({ ledgerPath, env: {} });
  assert.throws(() => g.reserve({ model: NANO, messages: msgs, maxTokens: 1 }), SpendCapError);
});

test("raised stop still never passes $24", () => {
  const ledgerPath = tmpLedger({ spent_usd: 23.999, calls: 9, by_model: {}, last: null });
  const g = new SpendGuard({ ledgerPath, env: { CUTROOM_SOFT_STOP_USD: "50" } });
  assert.throws(() => g.reserve({ model: ULTRA, messages: msgs, maxTokens: 1000 }), SpendCapError);
});

test("concurrent calls count each other's worst case", () => {
  const ledgerPath = tmpLedger({ spent_usd: 19.9, calls: 0, by_model: {}, last: null });
  const g = new SpendGuard({ ledgerPath, env: {} });
  // each worst case ~ $0.06; two fit under 20, the third must not
  g.reserve({ model: ULTRA, messages: msgs, maxTokens: 20_000 });
  assert.throws(() => g.reserve({ model: ULTRA, messages: msgs, maxTokens: 20_000 }), SpendCapError);
});

test("missing usage is charged at worst case, never zero", () => {
  const ledgerPath = tmpLedger();
  const g = new SpendGuard({ ledgerPath, env: {} });
  const r = g.reserve({ model: ULTRA, messages: msgs, maxTokens: 1000 });
  const cost = r.settle(undefined);
  assert.ok(cost >= 0.003 - 1e-12);
  assert.ok(g.spentUsd >= 0.003 - 1e-12);
});

test("released reservations free the room", () => {
  const ledgerPath = tmpLedger({ spent_usd: 19.9, calls: 0, by_model: {}, last: null });
  const g = new SpendGuard({ ledgerPath, env: {} });
  const r = g.reserve({ model: ULTRA, messages: msgs, maxTokens: 20_000 });
  r.release();
  g.reserve({ model: ULTRA, messages: msgs, maxTokens: 20_000 });
});

test("unknown model and missing max_tokens are refused", () => {
  const g = new SpendGuard({ ledgerPath: tmpLedger(), env: {} });
  assert.throws(() => g.reserve({ model: "someone/new-model", messages: msgs, maxTokens: 10 }), SpendCapError);
  assert.throws(() => g.reserve({ model: NANO, messages: msgs }), SpendCapError);
});

test("images count toward the worst case", () => {
  const g = new SpendGuard({ ledgerPath: tmpLedger(), env: {} });
  const withImage = [{ role: "user", content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "data:" } }] }];
  const a = g.reserve({ model: "zai-org/GLM-5.3-Flash", messages: withImage, maxTokens: 10 }).worstCaseUsd;
  const b = g.reserve({ model: "zai-org/GLM-5.3-Flash", messages: msgs, maxTokens: 10 }).worstCaseUsd;
  assert.ok(a > b + 0.0004);
});
