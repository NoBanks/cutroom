import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpendGuard, SpendCapError } from "../lib/spend-guard.js";
import {
  chat,
  generateJSON,
  parseJSONReply,
  _setFetchForTests,
  _setSpendGuardForTests,
} from "../lib/llm.js";

const env = { NEBIUS_API_KEY: "test-key" };

function freshGuard(spent = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-"));
  const ledgerPath = path.join(dir, "l.json");
  fs.writeFileSync(ledgerPath, JSON.stringify({ spent_usd: spent, calls: 0, by_model: {}, last: null }));
  const g = new SpendGuard({ ledgerPath, env: {} });
  _setSpendGuardForTests(g);
  return g;
}

function okResponse(content, usage = { prompt_tokens: 100, completion_tokens: 50 }) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }], usage }) };
}

test("successful call records actual usage", async () => {
  const g = freshGuard();
  let sent;
  _setFetchForTests(async (url, init) => { sent = JSON.parse(init.body); return okResponse("hi"); });
  const r = await chat({ messages: [{ role: "user", content: "x" }], maxTokens: 64, env });
  assert.equal(r.message.content, "hi");
  assert.equal(sent.max_tokens, 64);
  assert.deepEqual(sent.chat_template_kwargs, { enable_thinking: false });
  assert.equal(g.status().calls, 1);
  assert.ok(g.spentUsd > 0);
});

test("refuses to send anything once the stop is reached", async () => {
  freshGuard(20);
  let called = false;
  _setFetchForTests(async () => { called = true; return okResponse("x"); });
  await assert.rejects(chat({ messages: [{ role: "user", content: "x" }], maxTokens: 10, env }), SpendCapError);
  assert.equal(called, false);
});

test("retries are checked against the stop every time", async () => {
  // Stop leaves room for exactly one worst-case Super call of 20k tokens (~$0.018).
  freshGuard(19.97);
  let calls = 0;
  _setFetchForTests(async () => { calls++; return { ok: false, status: 503, text: async () => "busy" }; });
  await assert.rejects(
    chat({ tier: "reason", messages: [{ role: "user", content: "x" }], maxTokens: 20_000, env, retries: 5 }),
    SpendCapError,
  );
  assert.equal(calls, 1);
});

test("a 400 is released, not charged", async () => {
  const g = freshGuard();
  _setFetchForTests(async () => ({ ok: false, status: 400, text: async () => "bad" }));
  await assert.rejects(chat({ messages: [{ role: "user", content: "x" }], maxTokens: 10, env }));
  assert.equal(g.spentUsd, 0);
});

test("generateJSON re-asks once on bad JSON", async () => {
  freshGuard();
  const replies = ["not json at all", '{"pace":"hot"}'];
  _setFetchForTests(async () => okResponse(replies.shift()));
  const r = await generateJSON({ system: "s", user: "u", env, maxTokens: 50 });
  assert.deepEqual(r.data, { pace: "hot" });
});

test("parseJSONReply handles fences and prose", () => {
  assert.deepEqual(parseJSONReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJSONReply('Sure! {"a":2} hope that helps'), { a: 2 });
  assert.deepEqual(parseJSONReply('<think>hmm</think>{"a":3}'), { a: 3 });
});

test("readReply assembles a streamed reply, tool calls and usage", async () => {
  const { readReply } = await import("../lib/llm.js");
  const lines = [
    'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}',
    'data: {"choices":[{"delta":{"content":"{\\"a\\":"}}]}',
    'data: {"choices":[{"delta":{"content":"1}"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"add_clip","arguments":"{\\"in_s\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
    "data: [DONE]",
  ];
  const text = lines.join("\n") + "\n";
  // split mid-line to prove buffering works
  const parts = [text.slice(0, 37), text.slice(37, 150), text.slice(150)];
  const res = {
    headers: { get: () => "text/event-stream" },
    body: (async function* () { for (const p of parts) yield new TextEncoder().encode(p); })(),
  };
  const r = await readReply(res);
  assert.equal(r.message.content, '{"a":1}');
  assert.equal(r.message.reasoning_content, "thinking...");
  assert.equal(r.message.tool_calls[0].function.name, "add_clip");
  assert.equal(r.message.tool_calls[0].function.arguments, '{"in_s":1}');
  assert.equal(r.finishReason, "tool_calls");
  assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 5 });
});
