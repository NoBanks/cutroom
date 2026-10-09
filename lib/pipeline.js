// The cutting room, start to finish:
//   inventory -> DIRECTOR -> SELECTOR -> EDITOR -> ASSISTANT EDITOR (MCP conform)
//   -> render (MCP) -> deliverables
// Each stage writes its JSON into the session folder so every decision is inspectable.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { probe } from "./media.js";
import { connectTimeline } from "./mcp.js";
import { spendGuard, modelFor } from "./llm.js";
import { runDirector } from "../agents/director.js";
import { runSelector } from "../agents/selector.js";
import { runEditor } from "../agents/editor.js";
import { runConform } from "../agents/conform.js";
import { runReviewer, applyOrders } from "../agents/reviewer.js";
import { runCoverage, renderPickupSheet } from "../agents/coverage.js";

async function writeJSON(dir, name, data) {
  await fs.writeFile(path.join(dir, name), JSON.stringify(data, null, 2));
}

export function frameFor(inventory) {
  const vertical = inventory.filter((c) => c.orientation === "vertical").length;
  return vertical > inventory.length / 2
    ? { width: 1080, height: 1920, orientation: "vertical" }
    : { width: 1920, height: 1080, orientation: "horizontal" };
}

export async function buildInventory(clipPaths) {
  const inventory = [];
  const clips = [];
  for (const p of clipPaths) {
    const info = await probe(p);
    const hash = crypto.createHash("sha1").update(path.resolve(p)).digest("hex").slice(0, 8);
    const clip_id = `clip_${hash}`;
    inventory.push({ clip_id, filename: path.basename(p), ...info });
    clips.push({ clip_id, path: path.resolve(p) });
  }
  return { inventory, clips };
}

export async function runCuttingRoom({ clipPaths, brief, preset = "", sessionDir, onLog = () => {} }) {
  await fs.mkdir(sessionDir, { recursive: true });
  const log = (stage, message) => onLog({ at: new Date().toISOString(), stage, message });
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

  const { inventory, clips } = await buildInventory(clipPaths);
  await writeJSON(sessionDir, "inventory.json", inventory);
  log("inventory", `${inventory.length} clips, ${inventory.reduce((s, c) => s + c.duration_seconds, 0).toFixed(1)}s of footage`);

  log("director", `reading the brief (${modelFor("reason")})`);
  const { intent } = await runDirector({ brief, preset, sessionId: path.basename(sessionDir), inventory });
  await writeJSON(sessionDir, "intent.json", intent);
  log("director", `${intent.pacing_profile} pacing, ${intent.target_length_sec}s target. ${intent.directors_note}`);

  log("selector", `watching footage (${modelFor("vision")})`);
  const selects = await runSelector({
    clips, inventory, sessionDir, intent,
    onProgress: (p) => log("selector", p.message),
  });
  await writeJSON(sessionDir, "selects.json", selects);
  log("selector", `${selects.moments.length} usable moments logged (${elapsed()})`);
  if (!selects.moments.length) throw new Error("The Selector found no usable moments in this footage.");

  log("editor", `cutting against the intent (${modelFor("reason")})`);
  const editorResult = await runEditor({ intent, selects, inventory, sessionId: path.basename(sessionDir) });
  await writeJSON(sessionDir, "edl.json", editorResult);
  log("editor", `${editorResult.edl.length} shots, ${editorResult.total_duration_sec}s. ${editorResult.summary}`);

  const frame = frameFor(inventory);
  const projectName = "roughcut";
  const timelineDir = path.join(sessionDir, "timeline");
  await fs.mkdir(timelineDir, { recursive: true });
  const timeline = await connectTimeline({ workdir: timelineDir });
  try {
    log("assistant", `conforming through shotcut-mcp (${modelFor("fast")}, ${timeline.tools.length} tools)`);
    const clipPathsById = Object.fromEntries(clips.map((c) => [c.clip_id, c.path]));
    const conform = await runConform({
      timeline,
      projectName,
      width: frame.width,
      height: frame.height,
      fps: 24,
      edl: editorResult.edl,
      clipPaths: clipPathsById,
      onLog: (m) => log("assistant", m),
    });
    await writeJSON(sessionDir, "conform.json", { conformedBy: conform.conformedBy, toolCalls: conform.toolLog, timeline: conform.timeline });

    log("render", "rendering the first cut with melt");
    const firstCut = path.join(sessionDir, "roughcut_v1.mp4");
    let render = await timeline.call("render", { project_name: projectName, output_path: firstCut, preset: "mp4-project" });
    if (render.error) throw new Error(`Render failed: ${render.error}`);
    log("render", `first cut: ${render.rendered_duration_s?.toFixed?.(2)}s rendered in ${render.render_time_s}s`);

    // REVIEWER: screen the cut, decide ship or one bounded pass.
    let finalEdl = editorResult;
    let reviewerResult = null;
    let revision = null;
    let finalCut = firstCut;
    try {
      log("reviewer", `screening the first cut (${modelFor("vision")} eyes, ${modelFor("reason")} verdict)`);
      reviewerResult = await runReviewer({
        roughCutPath: firstCut,
        intent,
        editorResult,
        roughCut: { durationSec: render.rendered_duration_s, shots: editorResult.edl.length, fps: 24 },
        sessionId: path.basename(sessionDir),
        onLog: (m) => log("reviewer", m),
      });
      await writeJSON(sessionDir, "review.json", reviewerResult);
      log("reviewer", `${reviewerResult.verdict}: ${reviewerResult.reviewers_note}`);
      if (reviewerResult.verdict === "one_pass" && reviewerResult.orders.length) {
        const applied = applyOrders({
          edl: editorResult.edl,
          orders: reviewerResult.orders,
          benched: editorResult.unused_strong_moments,
          inventory,
        });
        applied.skipped.forEach((s) => log("reviewer", `skipped ${s}`));
        if (applied.ok) {
          log("assistant", `applying ${applied.applied.length} order(s) to the live timeline`);
          revision = await runConform({
            timeline, projectName, width: frame.width, height: frame.height, fps: 24,
            edl: applied.edl, clipPaths: clipPathsById, mode: "revise", orders: reviewerResult.orders,
            onLog: (m) => log("assistant", m),
          });
          finalEdl = { ...editorResult, edl: applied.edl, total_duration_sec: applied.total_duration_sec, review_applied: applied.applied };
          await writeJSON(sessionDir, "edl_final.json", finalEdl);
          finalCut = path.join(sessionDir, "roughcut.mp4");
          render = await timeline.call("render", { project_name: projectName, output_path: finalCut, preset: "mp4-project" });
          if (render.error) throw new Error(`Render failed: ${render.error}`);
          log("render", `revised cut: ${render.rendered_duration_s?.toFixed?.(2)}s`);
        } else {
          log("reviewer", `orders could not be applied cleanly (${applied.errors.join("; ") || "none applied"}); the first cut stands`);
        }
      }
    } catch (err) {
      if (err.name === "SpendCapError") throw err;
      log("reviewer", `review unavailable (${err.message}); the first cut stands as delivered`);
    }
    if (finalCut === firstCut) {
      await fs.copyFile(firstCut, path.join(sessionDir, "roughcut.mp4"));
    }

    // COVERAGE: what footage the cut is missing, as a call sheet.
    let coverage = null;
    try {
      log("coverage", `writing the pickup list (${modelFor("fast")})`);
      const cov = await runCoverage({
        intent, inventory, moments: selects.moments, editorResult: finalEdl, reviewerResult,
        brief, sessionId: path.basename(sessionDir), onLog: (m) => log("coverage", m),
      });
      coverage = cov.coverage;
      await writeJSON(sessionDir, "coverage.json", coverage);
      await fs.writeFile(path.join(sessionDir, "pickups.txt"), renderPickupSheet(coverage, { brief, sessionId: path.basename(sessionDir) }));
      log("coverage", `${coverage.gaps?.length ?? 0} gaps, ${coverage.pickups?.length ?? 0} pickups`);
    } catch (err) {
      if (err.name === "SpendCapError") throw err;
      log("coverage", `coverage unavailable (${err.message})`);
    }

    const summary = {
      brief,
      frame,
      runtime_sec: render.rendered_duration_s,
      shots: finalEdl.edl.length,
      review: reviewerResult ? { verdict: reviewerResult.verdict, note: reviewerResult.reviewers_note, orders: reviewerResult.orders.length } : null,
      conformed_by: conform.conformedBy,
      revised_by: revision?.conformedBy ?? null,
      mcp_tool_calls: conform.toolCalls + (revision?.toolCalls ?? 0),
      models: { reason: modelFor("reason"), vision: modelFor("vision"), fast: modelFor("fast") },
      spend: spendGuard().status(),
      elapsed_sec: Math.round((Date.now() - t0) / 1000),
      files: {
        video: "roughcut.mp4",
        first_cut: "roughcut_v1.mp4",
        pickups: coverage ? "pickups.txt" : null,
        shotcut_project: "timeline/roughcut.mlt",
        edl: "edl.json",
        selects: "selects.json",
        intent: "intent.json",
      },
    };
    await writeJSON(sessionDir, "summary.json", summary);
    log("done", `cut delivered in ${elapsed()}; spend so far $${summary.spend.spent_usd}`);
    return summary;
  } finally {
    await timeline.close();
  }
}
