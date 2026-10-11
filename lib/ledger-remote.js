// Durable spend ledger for hosts whose disk is wiped on restart (Hugging Face Spaces).
//
// The ledger is mirrored to a PRIVATE Hugging Face dataset repo. On boot the server
// pulls it and keeps whichever total is higher (local or remote), so a restart can
// never reset the meter. After spend changes it is pushed back. If the remote ledger
// cannot be read, the server refuses to start new cuts: it fails closed.
//
// Enabled when CUTROOM_LEDGER_REPO (e.g. "user/cutroom-ledger") and HF_TOKEN are set.

import fs from "node:fs";
import path from "node:path";
import { fetch as undiciFetch } from "undici";

const HF = "https://huggingface.co";

export function remoteLedgerConfigured(env = process.env) {
  return Boolean(env.CUTROOM_LEDGER_REPO && env.HF_TOKEN);
}

export async function pullRemoteLedger({ env = process.env, fetchImpl = undiciFetch } = {}) {
  const res = await fetchImpl(`${HF}/datasets/${env.CUTROOM_LEDGER_REPO}/resolve/main/ledger.json`, {
    headers: { Authorization: `Bearer ${env.HF_TOKEN}` },
  });
  if (res.status === 404) return { spent_usd: 0, calls: 0, by_model: {}, last: null };
  if (!res.ok) throw new Error(`remote ledger HTTP ${res.status}`);
  const data = await res.json();
  if (typeof data.spent_usd !== "number") throw new Error("remote ledger is malformed");
  return data;
}

export async function pushRemoteLedger(ledger, { env = process.env, fetchImpl = undiciFetch } = {}) {
  const content = Buffer.from(JSON.stringify(ledger, null, 2)).toString("base64");
  const body = [
    { key: "header", value: { summary: `ledger $${ledger.spent_usd.toFixed(4)}` } },
    { key: "file", value: { path: "ledger.json", content, encoding: "base64" } },
  ].map((l) => JSON.stringify(l)).join("\n");
  const res = await fetchImpl(`${HF}/api/datasets/${env.CUTROOM_LEDGER_REPO}/commit/main`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.HF_TOKEN}`, "Content-Type": "application/x-ndjson" },
    body,
  });
  if (!res.ok) throw new Error(`remote ledger push HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Merge remote into the local ledger file BEFORE the spend guard loads it.
export function mergeIntoLocal(ledgerPath, remote) {
  let local = null;
  try {
    local = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  } catch {}
  const winner = !local || remote.spent_usd >= local.spent_usd ? remote : local;
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(winner, null, 2));
  return winner;
}
