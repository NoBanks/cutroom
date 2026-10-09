// Media helpers: probe, contact sheets, motion and loudness profiles.
//
// The crew's eyes are an image model, so footage is shown to it the way an
// assistant editor scans dailies: contact sheets of evenly spaced frames, each
// stamped with its source timecode. Two cheap ffmpeg measurements ride along as
// text, because a still frame cannot show them: how much the picture changes
// (motion) and how loud the sound is, both in half-second buckets.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN || "ffprobe";
const BUCKET_S = 0.5;

export async function probe(filePath) {
  const { stdout } = await run(FFPROBE, [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath,
  ], { maxBuffer: 8 * 1024 * 1024 });
  const info = JSON.parse(stdout);
  const video = info.streams.find((s) => s.codec_type === "video");
  const audio = info.streams.find((s) => s.codec_type === "audio");
  if (!video) throw new Error(`${path.basename(filePath)} has no video stream`);
  const [num, den] = String(video.avg_frame_rate || video.r_frame_rate || "25/1").split("/").map(Number);
  const rotation = Number(
    video.tags?.rotate ?? video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0,
  );
  let width = Number(video.width);
  let height = Number(video.height);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  return {
    duration_seconds: Number(Number(info.format.duration).toFixed(3)),
    width,
    height,
    fps: den ? Number((num / den).toFixed(3)) : num,
    has_audio: Boolean(audio),
    resolution: `${width}x${height}`,
    orientation: height > width ? "vertical" : width > height ? "horizontal" : "square",
  };
}

// Pick frame times: about one every half second for short clips, coarser for long
// ones, never more than maxFrames. Times sit in the middle of their slice.
export function frameTimes(duration, { maxFrames = 60, minInterval = 0.5 } = {}) {
  if (!(duration > 0)) return [];
  const count = Math.max(1, Math.min(maxFrames, Math.floor(duration / minInterval)));
  const step = duration / count;
  return Array.from({ length: count }, (_, i) => Number((step * (i + 0.5)).toFixed(2)));
}

function tc(t) {
  return `${t.toFixed(1)}s`;
}

// Build contact sheets: grids of `cols` x `rows` frames, each labelled with its
// source time. Returns [{ path, dataUrl, times }].
export async function contactSheets(filePath, outDir, {
  duration,
  maxSeconds = 300,
  cols = 5,
  rows = 4,
  tileWidth = 300,
} = {}) {
  await fs.mkdir(outDir, { recursive: true });
  const span = Math.min(duration, maxSeconds);
  const times = frameTimes(span);
  const perSheet = cols * rows;
  const tmpDir = path.join(outDir, `frames_${path.parse(filePath).name}`);
  await fs.mkdir(tmpDir, { recursive: true });

  // One seek per frame keeps timestamps exact regardless of the source's GOP.
  const framePaths = [];
  for (let i = 0; i < times.length; i++) {
    const out = path.join(tmpDir, `f${String(i).padStart(3, "0")}.jpg`);
    const label = tc(times[i]).replace(/:/g, "\\:");
    await run(FFMPEG, [
      "-v", "error", "-y", "-ss", String(times[i]), "-i", filePath, "-frames:v", "1",
      "-vf",
      `scale=${tileWidth}:-2,drawtext=text='${label}':x=6:y=6:fontsize=${Math.round(tileWidth / 11)}:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=4`,
      "-q:v", "4", out,
    ]);
    framePaths.push(out);
  }

  const sheets = [];
  for (let s = 0; s * perSheet < framePaths.length; s++) {
    const chunk = framePaths.slice(s * perSheet, (s + 1) * perSheet);
    const chunkTimes = times.slice(s * perSheet, (s + 1) * perSheet);
    const sheetRows = Math.ceil(chunk.length / cols);
    const out = path.join(outDir, `${path.parse(filePath).name}_sheet${s + 1}.jpg`);
    const listFile = path.join(tmpDir, `list${s}.txt`);
    await fs.writeFile(listFile, chunk.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
    await run(FFMPEG, [
      "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-vf", `tile=${cols}x${sheetRows}:padding=4:color=black`, "-frames:v", "1", "-q:v", "4", out,
    ]);
    const b64 = (await fs.readFile(out)).toString("base64");
    sheets.push({ path: out, dataUrl: `data:image/jpeg;base64,${b64}`, times: chunkTimes });
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
  return sheets;
}

// Picture change per half second, 0..1 (ffmpeg scene score, max per bucket).
export async function motionProfile(filePath, { maxSeconds = 300 } = {}) {
  const { stderr, stdout } = await run(FFMPEG, [
    "-v", "info", "-t", String(maxSeconds), "-i", filePath, "-an",
    "-vf", "fps=8,scale=160:-2,select='gte(scene\\,0)',metadata=print:key=lavfi.scene_score",
    "-f", "null", "-",
  ], { maxBuffer: 32 * 1024 * 1024 });
  const text = stderr + stdout;
  const buckets = new Map();
  let t = null;
  for (const line of text.split("\n")) {
    const pts = line.match(/pts_time:([\d.]+)/);
    if (pts) t = Number(pts[1]);
    const sc = line.match(/lavfi\.scene_score=([\d.]+)/);
    if (sc && t !== null) {
      const b = Math.floor(t / BUCKET_S);
      buckets.set(b, Math.max(buckets.get(b) || 0, Number(sc[1])));
    }
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, v]) => ({
    t: Number((b * BUCKET_S).toFixed(1)),
    motion: Number(Math.min(1, v * 4).toFixed(2)), // scene scores are small; scale so 0.25 reads as strong
  }));
}

// Loudness per half second in dBFS (RMS); null when the clip has no audio.
export async function loudnessProfile(filePath, { hasAudio = true, maxSeconds = 300 } = {}) {
  if (!hasAudio) return null;
  const { stderr, stdout } = await run(FFMPEG, [
    "-v", "info", "-t", String(maxSeconds), "-i", filePath, "-vn",
    "-af", "aresample=8000,asetnsamples=n=4000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
    "-f", "null", "-",
  ], { maxBuffer: 32 * 1024 * 1024 });
  const text = stderr + stdout;
  const out = [];
  let t = null;
  for (const line of text.split("\n")) {
    const pts = line.match(/pts_time:([\d.]+)/);
    if (pts) t = Number(pts[1]);
    const lv = line.match(/RMS_level=(-?[\d.]+|-inf)/);
    if (lv && t !== null) {
      out.push({ t: Number(t.toFixed(1)), db: lv[1] === "-inf" ? -90 : Math.round(Number(lv[1])) });
    }
  }
  return out;
}

// Compact one-line-per-bucket text for the model.
export function profileText(motion, loudness) {
  const byT = new Map();
  for (const m of motion) byT.set(m.t, { motion: m.motion });
  for (const l of loudness || []) byT.set(l.t, { ...(byT.get(l.t) || {}), db: l.db });
  const rows = [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) =>
    `${t.toFixed(1)}s motion=${v.motion ?? "?"}${loudness ? ` loud=${v.db ?? "?"}dB` : ""}`);
  return rows.join("\n");
}
