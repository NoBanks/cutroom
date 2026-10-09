import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateJSON } from "./model.js";
import { contactSheets } from "../lib/media.js";

const PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "prompts",
  "reviewer.txt",
);

export const MAX_ORDERS = 5;
// PRE-JUDGING PASS 2026-09-09: the review is capped so a quota wall cannot keep the
// session in "reviewing" forever. The cap is TOTAL attempts across the primary and the
// fallback model; each attempt is one key. Default 20 because the production run of
// 2026-09-07 (session 95182422) needed 17 key rotations before a model answered. Override
// with CUTROOM_REVIEW_MAX_ATTEMPTS. When the cap is hit the log says so and the first
// cut stands as delivered; nothing is lost.
const REVIEW_ATTEMPTS_FLOOR = 1;
const REVIEW_ATTEMPTS_CEILING = 48;
export const MAX_REVIEW_ATTEMPTS = Math.min(
  REVIEW_ATTEMPTS_CEILING,
  Math.max(
    REVIEW_ATTEMPTS_FLOOR,
    Number.parseInt(process.env.CUTROOM_REVIEW_MAX_ATTEMPTS || "", 10) || 20,
  ),
);
const MIN_SHOT_SEC = 0.5;
const MIN_ROWS_AFTER_REVIEW = 2;
const MATCH_TOLERANCE = 0.25;

export const REVIEWER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    watched_runtime_sec: { type: "number" },
    verdict: { type: "string", enum: ["ship", "one_pass"] },
    pacing_findings: { type: "array", items: { type: "string" } },
    continuity_findings: { type: "array", items: { type: "string" } },
    repetition_findings: { type: "array", items: { type: "string" } },
    orders: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["trim", "extend", "swap", "drop", "reorder"],
          },
          position: { type: "number" },
          delta_sec: { type: "number" },
          before_position: { type: "number" },
          swap_clip_id: { type: "string" },
          swap_start_sec: { type: "number" },
          swap_end_sec: { type: "number" },
          reason: { type: "string" },
        },
        required: ["op", "position", "reason"],
      },
    },
    reviewers_note: { type: "string" },
  },
  required: [
    "watched_runtime_sec",
    "verdict",
    "pacing_findings",
    "continuity_findings",
    "repetition_findings",
    "orders",
    "reviewers_note",
  ],
};

function stringArray(value) {
  return Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

export function normalizeReviewerResult(result) {
  const verdict = result?.verdict === "one_pass" ? "one_pass" : "ship";
  const note =
    typeof result?.reviewers_note === "string" ? result.reviewers_note.trim() : "";
  if (!note) throw new Error("Reviewer returned no reviewers_note.");
  const orders = Array.isArray(result?.orders) ? result.orders : [];
  return {
    generated_at: new Date().toISOString(),
    watched_runtime_sec: numberValue(result?.watched_runtime_sec) ?? 0,
    verdict,
    pacing_findings: stringArray(result?.pacing_findings),
    continuity_findings: stringArray(result?.continuity_findings),
    repetition_findings: stringArray(result?.repetition_findings),
    orders: orders
      .filter((order) => order && typeof order === "object")
      .slice(0, MAX_ORDERS)
      .map((order) => ({
        op: typeof order.op === "string" ? order.op.trim().toLowerCase() : "",
        position: numberValue(order.position),
        delta_sec: numberValue(order.delta_sec),
        before_position: numberValue(order.before_position),
        swap_clip_id:
          typeof order.swap_clip_id === "string" ? order.swap_clip_id.trim() : "",
        swap_start_sec: numberValue(order.swap_start_sec),
        swap_end_sec: numberValue(order.swap_end_sec),
        reason: typeof order.reason === "string" ? order.reason.trim() : "",
      })),
    reviewers_note: note,
  };
}

function describeRow(row) {
  if (!row) return "gone";
  const label = row.filename || row.clip_id || "clip";
  return `${label} ${round(row.source_start_sec)}s to ${round(
    row.source_end_sec,
  )}s (${round(row.duration_sec)}s)`;
}

function describeCut(rows) {
  return rows.map((row) => describeRow(row)).join(" | ");
}

function clipLimitFor(row, inventory) {
  const clip = inventory.find((item) => item.clip_id === row.clip_id);
  const duration = numberValue(clip?.duration_seconds);
  return duration !== null && duration > 0 ? duration : null;
}

function benchKey(moment) {
  return `${moment.clip_id}:${round(moment.start_sec)}:${round(moment.end_sec)}`;
}

function findBenched(order, benched, usedKeys) {
  const candidates = benched.filter(
    (moment) =>
      !usedKeys.has(benchKey(moment)) &&
      (!order.swap_clip_id || moment.clip_id === order.swap_clip_id),
  );
  if (candidates.length === 0) return null;
  if (order.swap_start_sec === null) return candidates[0];
  const matched = candidates.find(
    (moment) =>
      Math.abs(Number(moment.start_sec) - order.swap_start_sec) <=
      MATCH_TOLERANCE,
  );
  return matched || candidates[0];
}

// Every order is applied against the ORIGINAL position numbers the Reviewer
// watched, so a drop or a reorder earlier in the list cannot silently retarget
// a later order. Rows carry review_position for that lookup and it is stripped
// before the EDL is written.
export function applyOrders({
  edl,
  orders = [],
  benched = [],
  inventory = [],
}) {
  const rows = (Array.isArray(edl) ? edl : []).map((row, index) => ({
    ...row,
    review_position: index + 1,
  }));
  const applied = [];
  const skipped = [];
  const usedBenchKeys = new Set();
  const cappedOrders = (Array.isArray(orders) ? orders : []).slice(0, MAX_ORDERS);

  const findRow = (position) =>
    position === null
      ? undefined
      : rows.find((row) => row.review_position === position);

  cappedOrders.forEach((order, index) => {
    const label = `order ${index + 1} (${order.op || "unknown"} position ${
      order.position ?? "?"
    })`;
    const row = findRow(order.position);
    if (!row && order.op !== "reorder") {
      skipped.push(`${label}: that position is not in the cut any more`);
      return;
    }

    if (order.op === "trim" || order.op === "extend") {
      const delta = order.delta_sec;
      if (delta === null || delta === 0) {
        skipped.push(`${label}: no usable delta_sec`);
        return;
      }
      const signedDelta = order.op === "trim" ? -Math.abs(delta) : Math.abs(delta);
      const before = describeRow(row);
      let newEnd = Number(row.source_end_sec) + signedDelta;
      if (signedDelta > 0) {
        const limit = clipLimitFor(row, inventory);
        if (limit !== null) newEnd = Math.min(newEnd, limit);
        if (newEnd <= Number(row.source_end_sec) + 0.01) {
          skipped.push(`${label}: the source clip has no runway left`);
          return;
        }
      }
      const newDuration = newEnd - Number(row.source_start_sec);
      if (newDuration < MIN_SHOT_SEC) {
        skipped.push(
          `${label}: the shot would fall under ${MIN_SHOT_SEC}s`,
        );
        return;
      }
      row.source_end_sec = round(newEnd);
      row.duration_sec = round(newDuration);
      applied.push({
        op: order.op,
        position: order.position,
        reason: order.reason,
        detail: `${order.op === "trim" ? "shortened" : "lengthened"} by ${round(
          Math.abs(signedDelta),
        )}s`,
        before,
        after: describeRow(row),
      });
      return;
    }

    if (order.op === "drop") {
      if (rows.length - 1 < MIN_ROWS_AFTER_REVIEW) {
        skipped.push(`${label}: the cut would be too short to stand up`);
        return;
      }
      const before = describeRow(row);
      rows.splice(rows.indexOf(row), 1);
      applied.push({
        op: "drop",
        position: order.position,
        reason: order.reason,
        detail: "removed from the cut",
        before,
        after: "removed",
      });
      return;
    }

    if (order.op === "swap") {
      const moment = findBenched(order, benched, usedBenchKeys);
      if (!moment) {
        skipped.push(`${label}: no benched moment matched`);
        return;
      }
      const start = numberValue(moment.start_sec);
      const end = numberValue(moment.end_sec);
      if (start === null || end === null || end - start < MIN_SHOT_SEC) {
        skipped.push(`${label}: the benched moment has no usable duration`);
        return;
      }
      const before = describeRow(row);
      usedBenchKeys.add(benchKey(moment));
      row.clip_id = moment.clip_id;
      row.filename = moment.filename || row.filename;
      row.source_start_sec = round(start);
      row.source_end_sec = round(end);
      row.duration_sec = round(end - start);
      row.action = moment.action || row.action;
      applied.push({
        op: "swap",
        position: order.position,
        reason: order.reason,
        detail: "replaced with a benched moment",
        before,
        after: describeRow(row),
      });
      return;
    }

    if (order.op === "reorder") {
      const target = findRow(order.before_position);
      if (!row || !target || row === target) {
        skipped.push(`${label}: the reorder target is not in the cut`);
        return;
      }
      const beforeCut = describeCut(rows);
      rows.splice(rows.indexOf(row), 1);
      rows.splice(rows.indexOf(target), 0, row);
      applied.push({
        op: "reorder",
        position: order.position,
        reason: order.reason,
        detail: `moved before position ${order.before_position}`,
        before: beforeCut,
        after: describeCut(rows),
      });
      return;
    }

    skipped.push(`${label}: unknown order type`);
  });

  const errors = [];
  if (rows.length < MIN_ROWS_AFTER_REVIEW) {
    errors.push("the reviewed cut has too few shots");
  }
  rows.forEach((row, index) => {
    const start = numberValue(row.source_start_sec);
    const end = numberValue(row.source_end_sec);
    if (start === null || end === null || end - start < MIN_SHOT_SEC) {
      errors.push(`reviewed edit ${index + 1} has an unusable span`);
      return;
    }
    const limit = clipLimitFor(row, inventory);
    if (limit !== null && end > limit + 0.05) {
      errors.push(`reviewed edit ${index + 1} runs past the end of its clip`);
    }
  });

  const finalRows = rows.map((row, index) => {
    const { review_position: _reviewPosition, ...rest } = row;
    return {
      ...rest,
      edit_index: index + 1,
      duration_sec: round(
        Number(row.source_end_sec) - Number(row.source_start_sec),
      ),
    };
  });
  const totalDuration = round(
    finalRows.reduce((sum, row) => sum + row.duration_sec, 0),
  );

  return {
    ok: errors.length === 0 && applied.length > 0,
    errors,
    applied,
    skipped,
    edl: finalRows,
    total_duration_sec: totalDuration,
  };
}

async function readReviewerPrompt() {
  return (await fs.readFile(PROMPT_PATH, "utf8")).trim();
}

export async function runReviewer({
  roughCutPath,
  intent = {},
  editorResult,
  roughCut,
  sessionId,
  onLog,
}) {
  const log = typeof onLog === "function" ? onLog : () => {};
  const prompt = await readReviewerPrompt();
  const edl = Array.isArray(editorResult?.edl) ? editorResult.edl : [];
  const benched = Array.isArray(editorResult?.unused_strong_moments)
    ? editorResult.unused_strong_moments
    : [];
  const userPayload = [
    "REVIEWER TASK",
    `Session id: ${sessionId}`,
    `Director intent: ${JSON.stringify(intent)}`,
    `Rendered cut: ${JSON.stringify({
      duration_sec: roughCut?.durationSec,
      shots: roughCut?.shots,
      fps: roughCut?.fps,
    })}`,
    `Final EDL, position numbers are 1 based in this order: ${JSON.stringify(
      edl.map((row, index) => ({
        position: index + 1,
        clip_id: row.clip_id,
        filename: row.filename,
        source_start_sec: row.source_start_sec,
        source_end_sec: row.source_end_sec,
        duration_sec: row.duration_sec,
        role: row.role,
        action: row.action,
      })),
    )}`,
    `Benched moments available for swap orders: ${JSON.stringify(benched)}`,
    "Swap orders must name swap_clip_id, swap_start_sec and swap_end_sec from that benched list.",
    "Reorder orders must name before_position. Trim and extend orders must set delta_sec, signed.",
    "numbers as plain seconds, never MM:SS strings",
    "Return only JSON matching this complete output schema:",
    JSON.stringify(REVIEWER_OUTPUT_SCHEMA),
  ].join("\n");
  // Stage 1, the eyes: contact sheets of the rendered cut, with every shot's span
  // on the cut timeline, screened by the vision model into plain-language notes.
  // Stage 2, the brain: Nemotron reads those notes against the intent and EDL and
  // returns the verdict and machine-executable orders.
  const startedAt = Date.now();
  const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
  const duration = Number(roughCut?.durationSec) || edl.reduce((s, r) => s + Number(r.duration_sec || 0), 0);
  let cursor = 0;
  const spans = edl.map((row, index) => {
    const span = { position: index + 1, start: Number(cursor.toFixed(2)), end: Number((cursor + Number(row.duration_sec)).toFixed(2)), action: row.action, shot_size: row.shot_size };
    cursor += Number(row.duration_sec);
    return span;
  });
  const sheets = await contactSheets(roughCutPath, path.join(path.dirname(roughCutPath), "review_sheets"), { duration });
  log(`screening the cut: ${sheets.length} contact sheet(s) of the full ${duration.toFixed(1)}s`);
  const SCREENING_SCHEMA = {
    type: "object",
    properties: {
      shots: {
        type: "array",
        items: {
          type: "object",
          properties: {
            position: { type: "number" },
            what_is_on_screen: { type: "string" },
            reads_as: { type: "string", enum: ["strong", "fine", "weak", "dead"] },
            cut_into_it: { type: "string" },
          },
          required: ["position", "what_is_on_screen", "reads_as", "cut_into_it"],
        },
      },
      opening_impression: { type: "string" },
      ending_impression: { type: "string" },
      repetition: { type: "array", items: { type: "string" } },
    },
    required: ["shots", "opening_impression", "ending_impression", "repetition"],
  };
  const screening = await generateJSON(
    [
      "You are screening a rough cut for the REVIEWER. You see it as contact sheets: frames sampled",
      "evenly through the CUT, stamped with time on the cut timeline. Describe what each shot shows,",
      "whether it reads as strong, fine, weak or dead (no visible change), and how the cut INTO it",
      "lands (smooth, jump cut, jarring, motion match). Be literal and brief. One pass, then answer.",
    ].join(" "),
    [
      `Shot spans on the cut timeline: ${JSON.stringify(spans)}`,
      `Director intent: ${JSON.stringify({ tone_words: intent.tone_words, closing: intent.structure, note: intent.directors_note })}`,
      "Return only JSON matching this schema:",
      JSON.stringify(SCREENING_SCHEMA),
    ].join("\n"),
    SCREENING_SCHEMA,
    { tier: "vision", thinking: false, maxTokens: 14000, images: sheets.map((s) => s.dataUrl) },
  );
  log(`screening notes in (${elapsed()}); the reviewer is deciding`);
  const result = await generateJSON(
    prompt,
    [
      userPayload,
      "",
      "You did not watch the cut yourself. A screener watched it for you; these are their notes,",
      `position by position: ${JSON.stringify(screening)}`,
      "Base every finding on the notes and the EDL. watched_runtime_sec is the cut's duration.",
    ].join("\n"),
    REVIEWER_OUTPUT_SCHEMA,
    { tier: "reason", thinking: true, maxTokens: 6000 },
  );
  log(`the reviewer answered after ${elapsed()}`);
  return normalizeReviewerResult(result);
}
