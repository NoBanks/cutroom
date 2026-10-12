// Export a finished run into a static replay bundle for the public demo.
// usage: node scripts/export-replay.mjs <sessionDir> <outDir> <id> "<title>"
import fs from "node:fs/promises";
import path from "node:path";

const [sessionDir, outDir, id, title] = process.argv.slice(2);
const read = async (name) => {
  try {
    return JSON.parse(await fs.readFile(path.join(sessionDir, name), "utf8"));
  } catch {
    return null;
  }
};

const dest = path.join(outDir, "replays", id);
await fs.mkdir(dest, { recursive: true });
const copy = async (name, as = name) => {
  try {
    await fs.copyFile(path.join(sessionDir, name), path.join(dest, as));
    return `replays/${id}/${as}`;
  } catch {
    return null;
  }
};

const summary = await read("summary.json");
const log = (await read("log.json")) || [];
const inventory = (await read("inventory.json")) || [];
const conform = await read("conform.json");
const files = {};
for (const f of ["roughcut.mp4", "roughcut_v1.mp4", "edl.json", "edl_final.json", "pickups.txt", "research.json", "review.json"]) {
  const p = await copy(f);
  if (p) files[f] = p;
}
// The Shotcut project, with media paths reduced to bare filenames.
try {
  let xml = await fs.readFile(path.join(sessionDir, "timeline", "roughcut.mlt"), "utf8");
  xml = xml.replace(/<property name="resource">[^<]*\/([^/<]+)<\/property>/g, '<property name="resource">$1</property>');
  await fs.writeFile(path.join(dest, "roughcut.mlt"), xml);
  files["roughcut.mlt"] = `replays/${id}/roughcut.mlt`;
} catch {}

const t0 = log.length ? Date.parse(log[0].at) : 0;
const startSpend = log.length ? log[0].spent_usd ?? 0 : 0;
const session = {
  id,
  title,
  replay: true,
  status: "complete",
  brief: summary?.brief || "",
  inventory: inventory.map(({ filename, duration_seconds, resolution, has_audio }) => ({ filename, duration_seconds, resolution, has_audio })),
  log: log.map((e) => ({ t: (Date.parse(e.at) - t0) / 1000, stage: e.stage, message: e.message, cost: Number(((e.spent_usd ?? startSpend) - startSpend).toFixed(4)) })),
  costUsd: log.length ? Number(((log.at(-1).spent_usd ?? startSpend) - startSpend).toFixed(4)) : 0,
  intent: await read("intent.json"),
  edl: (await read("edl_final.json")) || (await read("edl.json")),
  firstEdl: await read("edl.json"),
  review: await read("review.json"),
  coverage: await read("coverage.json"),
  conform: conform ? { conformedBy: conform.conformedBy, toolCalls: conform.toolCalls.map((t) => ({ tool: t.tool, args: { ...t.args, clip_path: t.args?.clip_path ? path.basename(t.args.clip_path) : undefined }, error: t.result?.error || null })) } : null,
  summary: summary ? { ...summary, spend: undefined } : null,
  files,
  recordedAt: log[0]?.at || null,
};
await fs.writeFile(path.join(dest, "session.json"), JSON.stringify(session));

const indexPath = path.join(outDir, "replays", "index.json");
let index = [];
try {
  index = JSON.parse(await fs.readFile(indexPath, "utf8"));
} catch {}
index = index.filter((r) => r.id !== id);
index.push({ id, title, brief: session.brief, runtime_sec: summary?.runtime_sec, shots: summary?.shots, cost: session.costUsd, elapsed_sec: summary?.elapsed_sec, recordedAt: session.recordedAt });
await fs.writeFile(indexPath, JSON.stringify(index, null, 1));
console.log(`exported ${id}: ${session.log.length} events, ${Object.keys(files).length} files`);
