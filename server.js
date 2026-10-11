// CUTROOM web server: upload footage (or use the sample), write a brief, watch the
// crew work, download the cut, the Shotcut project, the EDL and the pickup list.
//
// Public-demo protections, on top of the global $20 spend stop:
//   - one cut runs at a time; others wait in a queue
//   - a daily budget (CUTROOM_DAILY_USD, default $1.50) after which new runs are refused
//   - upload limits: 6 clips, 200MB total, 5 minutes of footage

import express from "express";
import multer from "multer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { runCuttingRoom, buildInventory } from "./lib/pipeline.js";
import { spendGuard, modelFor } from "./lib/llm.js";
import os from "node:os";
import { remoteLedgerConfigured, pullRemoteLedger, pushRemoteLedger, mergeIntoLocal } from "./lib/ledger-remote.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CUTROOM_DATA || path.join(ROOT, "sessions");
const SAMPLE_DIR = process.env.CUTROOM_SAMPLES || path.join(ROOT, "samples");
const PORT = Number(process.env.PORT || 8080);
const DAILY_USD = Number(process.env.CUTROOM_DAILY_USD || 1.5);
const MAX_FILES = 6;
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_FOOTAGE_SEC = 300;
const DOWNLOADS = new Set([
  "roughcut.mp4", "roughcut_v1.mp4", "edl.json", "edl_final.json", "pickups.txt",
  "coverage.json", "review.json", "intent.json", "selects.json", "summary.json", "research.json",
]);

fs.mkdirSync(DATA, { recursive: true });

// ---- durable ledger (hosts with wiped disks) -------------------------------
const LEDGER_PATH = process.env.CUTROOM_LEDGER || path.join(os.homedir(), ".cutroom", "spend-ledger.json");
let ledgerReady = !remoteLedgerConfigured();
let lastPushed = null;
async function syncLedgerFromRemote() {
  try {
    const remote = await pullRemoteLedger();
    const merged = mergeIntoLocal(LEDGER_PATH, remote);
    spendGuard().reload();
    lastPushed = merged.spent_usd;
    ledgerReady = true;
    console.log(`remote ledger loaded: $${merged.spent_usd.toFixed(4)} spent`);
  } catch (err) {
    ledgerReady = false;
    console.error(`remote ledger unavailable, cuts are paused: ${err.message}`);
    setTimeout(syncLedgerFromRemote, 60_000);
  }
}
async function pushLedger() {
  if (!remoteLedgerConfigured() || !ledgerReady) return;
  const g = spendGuard();
  if (g.spentUsd === lastPushed) return;
  try {
    await pushRemoteLedger(g.ledger);
    lastPushed = g.spentUsd;
  } catch (err) {
    console.error(`remote ledger push failed: ${err.message}`);
  }
}
if (remoteLedgerConfigured()) {
  await syncLedgerFromRemote();
  setInterval(pushLedger, 30_000);
}
const sessions = new Map();
const queue = [];
let running = null;

// ---- daily budget -------------------------------------------------------
const dayFile = path.join(DATA, "daily-spend.json");
function today() {
  return new Date().toISOString().slice(0, 10);
}
function dailyState() {
  try {
    const d = JSON.parse(fs.readFileSync(dayFile, "utf8"));
    if (d.day === today()) return d;
  } catch {}
  return { day: today(), start_usd: spendGuard().spentUsd };
}
function spentToday() {
  const d = dailyState();
  if (!fs.existsSync(dayFile) || JSON.parse(fs.readFileSync(dayFile, "utf8")).day !== d.day) {
    fs.writeFileSync(dayFile, JSON.stringify(d));
  }
  return Math.max(0, spendGuard().spentUsd - d.start_usd);
}

// ---- sessions -----------------------------------------------------------
function newSession() {
  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(DATA, id);
  fs.mkdirSync(path.join(dir, "footage"), { recursive: true });
  const s = {
    id, dir, status: "intake", clips: [], inventory: [], brief: "", preset: "",
    log: [], stage: null, error: null, createdAt: Date.now(), costUsd: 0,
  };
  sessions.set(id, s);
  return s;
}

function readJSON(dir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  } catch {
    return null;
  }
}

function view(s) {
  const files = {};
  for (const f of DOWNLOADS) if (fs.existsSync(path.join(s.dir, f))) files[f] = `/api/sessions/${s.id}/files/${f}`;
  if (fs.existsSync(path.join(s.dir, "timeline", "roughcut.mlt"))) files["roughcut.mlt"] = `/api/sessions/${s.id}/project.mlt`;
  const position = queue.findIndex((q) => q.id === s.id);
  return {
    id: s.id,
    status: s.status,
    stage: s.stage,
    queuePosition: position >= 0 ? position + 1 : 0,
    brief: s.brief,
    preset: s.preset,
    inventory: s.inventory,
    log: s.log,
    error: s.error,
    costUsd: Number(s.costUsd.toFixed(4)),
    intent: readJSON(s.dir, "intent.json"),
    selects: (() => {
      const sel = readJSON(s.dir, "selects.json");
      return sel ? { moments: sel.moments.length, clips: sel.clips.map((c) => ({ filename: c.filename, moments: c.moments.length, flags: c.quality_flags })) } : null;
    })(),
    edl: readJSON(s.dir, "edl_final.json") || readJSON(s.dir, "edl.json"),
    firstEdl: readJSON(s.dir, "edl.json"),
    review: readJSON(s.dir, "review.json"),
    coverage: readJSON(s.dir, "coverage.json"),
    conform: (() => {
      const c = readJSON(s.dir, "conform.json");
      return c ? { conformedBy: c.conformedBy, toolCalls: c.toolCalls.map((t) => ({ tool: t.tool, args: t.args, error: t.result?.error || null })) } : null;
    })(),
    summary: readJSON(s.dir, "summary.json"),
    files,
  };
}

async function runNext() {
  if (running || !queue.length) return;
  const s = queue.shift();
  running = s;
  s.status = "running";
  const before = spendGuard().spentUsd;
  try {
    await runCuttingRoom({
      clipPaths: s.clips,
      brief: s.brief,
      preset: s.preset,
      sessionDir: s.dir,
      onLog: (e) => {
        s.stage = e.stage;
        s.log.push(e);
        s.costUsd = spendGuard().spentUsd - before;
      },
    });
    s.status = "complete";
  } catch (err) {
    s.status = "error";
    s.error = err.name === "SpendCapError"
      ? "The demo's model budget is used up for now. The cut stopped safely; nothing was charged."
      : err.message;
    s.log.push({ at: new Date().toISOString(), stage: "error", message: s.error });
  } finally {
    s.costUsd = spendGuard().spentUsd - before;
    running = null;
    await pushLedger();
    runNext();
  }
}

// ---- app ----------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, path.join(req.cutroom.dir, "footage")),
    filename: (_req, file, cb) => cb(null, file.originalname.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80)),
  }),
  limits: { files: MAX_FILES, fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(mp4|mov|m4v)$/i.test(file.originalname);
    cb(ok ? null : new Error(`${file.originalname}: only .mp4 or .mov footage`), ok);
  },
});

app.get("/api/health", (_req, res) => {
  const g = spendGuard().status();
  res.json({
    ok: true,
    models: { reason: modelFor("reason"), fast: modelFor("fast"), vision: modelFor("vision") },
    budget: { spent_today_usd: Number(spentToday().toFixed(4)), daily_limit_usd: DAILY_USD, total_spent_usd: g.spent_usd, stop_usd: g.soft_stop_usd },
    running: Boolean(running),
    queued: queue.length,
    ledger: remoteLedgerConfigured() ? (ledgerReady ? "durable" : "unavailable") : "local",
  });
});

app.post("/api/sessions", (req, res, next) => {
  req.cutroom = newSession();
  next();
}, upload.array("clips", MAX_FILES), async (req, res) => {
  const s = req.cutroom;
  try {
    let paths = (req.files || []).map((f) => f.path);
    if (!paths.length && req.query.sample === "1") {
      const names = (await fsp.readdir(SAMPLE_DIR)).filter((n) => /\.(mp4|mov)$/i.test(n)).sort();
      paths = [];
      for (const n of names) {
        const dest = path.join(s.dir, "footage", n);
        await fsp.copyFile(path.join(SAMPLE_DIR, n), dest);
        paths.push(dest);
      }
      s.sample = true;
    }
    if (!paths.length) return res.status(400).json({ error: "Add at least one clip." });
    const { inventory } = await buildInventory(paths);
    const total = inventory.reduce((sum, c) => sum + c.duration_seconds, 0);
    if (total > MAX_FOOTAGE_SEC) {
      return res.status(400).json({ error: `That is ${Math.round(total)}s of footage; the demo takes up to ${MAX_FOOTAGE_SEC}s.` });
    }
    s.clips = paths;
    s.inventory = inventory;
    res.json(view(s));
  } catch (err) {
    res.status(400).json({ error: `Could not read that footage: ${err.message}` });
  }
});

app.post("/api/sessions/:id/run", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found." });
  if (s.status === "running" || s.status === "queued") return res.json(view(s));
  if (!s.clips.length) return res.status(400).json({ error: "No footage in this session." });
  if (!ledgerReady) {
    return res.status(503).json({ error: "The budget ledger is unreachable right now, so cuts are paused to keep spending safe. Try again in a minute." });
  }
  if (spentToday() >= DAILY_USD) {
    return res.status(429).json({ error: "Today's demo budget is used up. Please try again tomorrow, or watch the recorded run." });
  }
  const brief = String(req.body?.brief || "").trim().slice(0, 600);
  if (!brief) return res.status(400).json({ error: "Tell the crew what you want." });
  s.brief = brief;
  s.preset = String(req.body?.preset || "").slice(0, 40);
  s.status = "queued";
  s.log = [];
  s.error = null;
  queue.push(s);
  runNext();
  res.json(view(s));
});

app.get("/api/sessions/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found." });
  res.json(view(s));
});

app.get("/api/sessions/:id/files/:name", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !DOWNLOADS.has(req.params.name)) return res.status(404).end();
  const p = path.join(s.dir, req.params.name);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// The Shotcut project with media paths made relative, so it opens next to the footage.
app.get("/api/sessions/:id/project.mlt", async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).end();
  const p = path.join(s.dir, "timeline", "roughcut.mlt");
  if (!fs.existsSync(p)) return res.status(404).end();
  let xml = await fsp.readFile(p, "utf8");
  for (const clip of s.clips) xml = xml.split(clip).join(path.basename(clip));
  res.setHeader("Content-Type", "application/xml");
  res.setHeader("Content-Disposition", 'attachment; filename="cutroom_roughcut.mlt"');
  res.send(xml);
});

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || "Request failed." });
});

app.listen(PORT, () => console.log(`CUTROOM on http://localhost:${PORT}`));
