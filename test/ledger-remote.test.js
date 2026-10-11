import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeIntoLocal, pullRemoteLedger, pushRemoteLedger } from "../lib/ledger-remote.js";

const env = { CUTROOM_LEDGER_REPO: "me/ledger", HF_TOKEN: "t" };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lr-")), "l.json");

test("a restart cannot lower the meter: the higher total wins", () => {
  const p = tmp();
  fs.writeFileSync(p, JSON.stringify({ spent_usd: 0, calls: 0, by_model: {}, last: null }));
  assert.equal(mergeIntoLocal(p, { spent_usd: 4.2, calls: 9, by_model: {}, last: null }).spent_usd, 4.2);
  assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).spent_usd, 4.2);
  assert.equal(mergeIntoLocal(p, { spent_usd: 1, calls: 1, by_model: {}, last: null }).spent_usd, 4.2);
});

test("missing remote ledger starts at zero; errors throw (server fails closed)", async () => {
  const r = await pullRemoteLedger({ env, fetchImpl: async () => ({ status: 404, ok: false }) });
  assert.equal(r.spent_usd, 0);
  await assert.rejects(pullRemoteLedger({ env, fetchImpl: async () => ({ status: 500, ok: false }) }));
  await assert.rejects(pullRemoteLedger({ env, fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ nope: 1 }) }) }));
});

test("push sends one ndjson commit with the ledger file", async () => {
  let sent;
  await pushRemoteLedger({ spent_usd: 1.5, calls: 2, by_model: {}, last: null }, {
    env, fetchImpl: async (url, init) => { sent = { url, init }; return { ok: true }; },
  });
  assert.match(sent.url, /\/api\/datasets\/me\/ledger\/commit\/main$/);
  const lines = sent.init.body.split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[1].value.path, "ledger.json");
  assert.equal(JSON.parse(Buffer.from(lines[1].value.content, "base64").toString()).spent_usd, 1.5);
});
