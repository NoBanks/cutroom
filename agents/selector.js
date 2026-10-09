// SELECTOR: the crew's eyes. Each clip is shown as contact sheets (frames stamped
// with source timecode) plus a half-second motion and loudness profile, and the
// vision model logs every usable moment. Output shape is unchanged from CUTROOM v1,
// so the Editor, Reviewer and Coverage read it exactly as before.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateJSON } from "./model.js";
import { contactSheets, motionProfile, loudnessProfile, profileText } from "../lib/media.js";

const MAX_ANALYSIS_SECONDS = 5 * 60;
const MIN_MOMENT_SECONDS = 0.6;
const SHOT_SIZE_ENUM = ["XCU", "CU", "MCU", "MS", "WS", "XWS"];
const SHOT_SIZE_ALIASES = {
  "EXTREME CLOSE UP": "XCU", "EXTREME CLOSE-UP": "XCU", ECU: "XCU",
  "CLOSE UP": "CU", "CLOSE-UP": "CU",
  "MEDIUM CLOSE UP": "MCU", "MEDIUM CLOSE-UP": "MCU",
  "MEDIUM SHOT": "MS", MEDIUM: "MS",
  "WIDE SHOT": "WS", WIDE: "WS",
  "EXTREME WIDE SHOT": "XWS", "EXTREME WIDE": "XWS", EWS: "XWS",
};
const PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts", "selector.txt");

export const SELECTOR_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    moments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start_sec: { type: "number" },
          end_sec: { type: "number" },
          action: { type: "string" },
          shot_size: { type: "string", enum: SHOT_SIZE_ENUM },
          camera_motion: { type: "string" },
          subject_motion: { type: "string" },
          audio_event: { type: "string" },
          intent_score: { type: "number" },
          look_for_hits: { type: "array", items: { type: "string" } },
          dead_shot: { type: "boolean" },
          notes: { type: "string" },
        },
        required: ["start_sec", "end_sec", "action", "shot_size", "camera_motion", "subject_motion",
          "audio_event", "intent_score", "look_for_hits", "dead_shot", "notes"],
      },
    },
    quality_flags: { type: "array", items: { type: "string" } },
  },
  required: ["moments", "quality_flags"],
};

const HOW_TO_READ = [
  "HOW YOU ARE SEEING THIS CLIP",
  "You cannot play video. You get contact sheets: frames sampled evenly through the clip,",
  "left to right, top to bottom, each stamped top-left with its SOURCE time in seconds.",
  "A moment spans from roughly the first frame where it starts to the last frame where it",
  "is still true; use the stamped times, and the motion profile, to place in/out points.",
  "The motion profile is picture change per half second (0 = frozen, 1 = hard change).",
  "The loudness profile is sound level in dBFS per half second (about -60 is near silence,",
  "-20 is loud). Use it for audio_event: a jump of 10dB or more is an audio event.",
  "A span with motion near 0 and no audio event is a DEAD SHOT.",
  "Log each moment for as long as its action really lasts. The Editor can trim a moment",
  "but can never extend one, so a 7 second continuous move is one 7 second moment, not",
  "three short ones. Split only where shot size or subject actually changes.",
  "Work quickly: one pass through the sheets, then write the JSON. Do not deliberate",
  "over boundaries finer than half a second.",
].join("\n");

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function normalizeShotSize(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().toUpperCase();
  if (SHOT_SIZE_ENUM.includes(raw)) return raw;
  return SHOT_SIZE_ALIASES[raw] || null;
}

export function normaliseMoment(moment, duration) {
  if (!moment || typeof moment !== "object") return null;
  const start = Math.max(0, Math.min(duration, Number(moment.start_sec)));
  const end = Math.max(0, Math.min(duration, Number(moment.end_sec)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (end - start < MIN_MOMENT_SECONDS || moment.dead_shot === true) return null;
  const shotSize = normalizeShotSize(moment.shot_size);
  if (!shotSize) return null;
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  return {
    start_sec: Number(start.toFixed(3)),
    end_sec: Number(end.toFixed(3)),
    action: text(moment.action),
    shot_size: shotSize,
    camera_motion: text(moment.camera_motion),
    subject_motion: text(moment.subject_motion),
    audio_event: text(moment.audio_event),
    intent_score: Number.isFinite(Number(moment.intent_score))
      ? Math.max(0, Math.min(1, Number(moment.intent_score)))
      : 0,
    look_for_hits: stringArray(moment.look_for_hits),
    dead_shot: false,
    notes: text(moment.notes),
  };
}

// Back-to-back moments at the same shot size with no real gap are one continuous
// take that the eyes logged in pieces. Join them so the Editor gets the full span
// (it can always trim; it can never extend past a moment).
const JOIN_GAP_SECONDS = 0.6;
export function joinContinuousMoments(moments) {
  const sorted = [...moments].sort((a, b) => a.start_sec - b.start_sec);
  const out = [];
  for (const m of sorted) {
    const prev = out.at(-1);
    if (prev && prev.shot_size === m.shot_size && m.start_sec - prev.end_sec <= JOIN_GAP_SECONDS && m.start_sec >= prev.start_sec) {
      prev.end_sec = Math.max(prev.end_sec, m.end_sec);
      if (m.action && !prev.action.includes(m.action)) prev.action = `${prev.action}; then ${m.action}`;
      prev.intent_score = Math.max(prev.intent_score, m.intent_score);
      prev.look_for_hits = [...new Set([...prev.look_for_hits, ...m.look_for_hits])];
      if (m.audio_event && m.audio_event !== "none" && !prev.audio_event.includes(m.audio_event)) {
        prev.audio_event = prev.audio_event && prev.audio_event !== "none" ? `${prev.audio_event}; ${m.audio_event}` : m.audio_event;
      }
      prev.joined = (prev.joined || 1) + 1;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

export function normaliseResult(result, duration) {
  const moments = Array.isArray(result?.moments)
    ? result.moments.map((m) => normaliseMoment(m, duration)).filter(Boolean)
    : [];
  return { moments: joinContinuousMoments(moments), quality_flags: stringArray(result?.quality_flags) };
}

async function analyseClip({ clipPath, inventory, sessionDir, intent, onProgress }) {
  const started = Date.now();
  const name = inventory.filename;
  const span = Math.min(Number(inventory.duration_seconds), MAX_ANALYSIS_SECONDS);
  onProgress({ state: "scanning", message: `${name}: building contact sheets and motion/sound profile` });
  const sheetsDir = path.join(sessionDir, "sheets");
  const [sheets, motion, loud] = await Promise.all([
    contactSheets(clipPath, sheetsDir, { duration: span }),
    motionProfile(clipPath, { maxSeconds: span }),
    loudnessProfile(clipPath, { hasAudio: inventory.has_audio, maxSeconds: span }),
  ]);
  onProgress({ state: "analyzing", message: `${name}: ${sheets.length} contact sheet(s), ${sheets.reduce((n, s) => n + s.times.length, 0)} frames, asking the eyes` });

  const prompt = (await fs.readFile(PROMPT_PATH, "utf8")).trim();
  const userPayload = [
    "SELECTOR TASK",
    `Clip filename: ${name}`,
    `Clip id: ${inventory.clip_id}`,
    `Analysis duration in seconds: ${span}`,
    `Frame: ${inventory.resolution}, ${inventory.orientation}, ${inventory.fps} fps, audio: ${inventory.has_audio ? "yes" : "none"}`,
    `Director intent: ${JSON.stringify(intent)}`,
    "",
    HOW_TO_READ,
    "",
    `Contact sheets attached: ${sheets.map((s, i) => `sheet ${i + 1} covers ${s.times[0]}s to ${s.times.at(-1)}s`).join("; ")}`,
    "",
    "MOTION AND LOUDNESS PROFILE",
    profileText(motion, loud),
    "",
    "Numbers as plain seconds, never MM:SS strings.",
    "Return only JSON matching this complete output schema:",
    JSON.stringify(SELECTOR_OUTPUT_SCHEMA),
  ].join("\n");

  const result = await generateJSON(prompt, userPayload, SELECTOR_OUTPUT_SCHEMA, {
    tier: "vision",
    thinking: false,
    maxTokens: 14000,
    images: sheets.map((s) => s.dataUrl),
    onEvent: (e) => onProgress({ state: "retrying", message: `${name}: ${e.type} (${e.reason})` }),
  });
  const normalized = normaliseResult(result, span);
  if (Number(inventory.duration_seconds) > MAX_ANALYSIS_SECONDS) {
    normalized.quality_flags.unshift("long clip analyzed from first five minutes");
  }
  onProgress({
    state: "complete",
    message: `${name}: logged ${normalized.moments.length} moments in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  });
  return { ...normalized, sheets: sheets.map((s) => s.path) };
}

export async function runSelector({ clips, inventory, sessionDir, intent, onProgress = () => {}, concurrency = 3 }) {
  const jobs = inventory
    .map((inv) => ({ inv, clip: clips.find((c) => c.clip_id === inv.clip_id) }))
    .filter((j) => j.clip);
  const results = new Array(jobs.length);
  const errors = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next++;
      const { inv, clip } = jobs[index];
      const report = (p) => onProgress({ ...p, clipId: inv.clip_id });
      let result;
      try {
        result = await analyseClip({ clipPath: clip.path, inventory: inv, sessionDir, intent, onProgress: report });
      } catch (err) {
        if (err.name === "SpendCapError") throw err;
        report({ state: "error", message: `${inv.filename}: ${err.message}` });
        errors.push(`${inv.filename}: ${err.message}`);
        result = { moments: [], quality_flags: ["selector unavailable"] };
      }
      results[index] = {
        clip_id: inv.clip_id,
        filename: inv.filename,
        quality_flags: result.quality_flags,
        moments: result.moments.map((m) => ({ clip_id: inv.clip_id, filename: inv.filename, ...m })),
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  const clipsResult = results.filter(Boolean);
  const moments = clipsResult.flatMap((c) => c.moments);
  return { generated_at: new Date().toISOString(), intent, clips: clipsResult, moments, errors, partial: errors.length > 0 };
}
