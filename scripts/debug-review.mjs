import fs from "node:fs";
import { runReviewer } from "../agents/reviewer.js";
const dir = process.argv[2];
const read = (n) => JSON.parse(fs.readFileSync(`${dir}/${n}`, "utf8"));
const edl = read("edl.json");
try {
  const r = await runReviewer({ roughCutPath: `${dir}/roughcut_v1.mp4`, intent: read("intent.json"), editorResult: edl,
    roughCut: { durationSec: edl.total_duration_sec, shots: edl.edl.length, fps: 24 }, sessionId: "dbg", onLog: (m) => console.log("LOG", m) });
  console.log("OK", r.verdict, r.orders.length);
} catch (e) { console.log("ERROR", e.name, e.message, e.stack.split("\n").slice(0, 4).join(" | ")); }
