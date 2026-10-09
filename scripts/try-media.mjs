import { probe, contactSheets, motionProfile, loudnessProfile, profileText } from "../lib/media.js";
const [file, out] = process.argv.slice(2);
const info = await probe(file);
console.log(info);
const sheets = await contactSheets(file, out, { duration: info.duration_seconds });
console.log(sheets.map((s) => ({ path: s.path, frames: s.times.length, kb: Math.round(s.dataUrl.length * 0.75 / 1024) })));
const motion = await motionProfile(file);
const loud = await loudnessProfile(file, { hasAudio: info.has_audio });
console.log(profileText(motion, loud).split("\n").slice(0, 12).join("\n"));
