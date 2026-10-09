// CLI: node scripts/cut.mjs --brief "..." [--preset "Energetic promo"] --out <dir> clip1.mp4 clip2.mp4 ...
import { runCuttingRoom } from "../lib/pipeline.js";

const args = process.argv.slice(2);
const opts = { clips: [] };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--brief") opts.brief = args[++i];
  else if (args[i] === "--preset") opts.preset = args[++i];
  else if (args[i] === "--out") opts.out = args[++i];
  else opts.clips.push(args[i]);
}
if (!opts.brief || !opts.out || !opts.clips.length) {
  console.error('usage: node scripts/cut.mjs --brief "..." --out <dir> clips...');
  process.exit(2);
}
try {
  const summary = await runCuttingRoom({
    clipPaths: opts.clips,
    brief: opts.brief,
    preset: opts.preset || "",
    sessionDir: opts.out,
    onLog: (e) => console.log(`[${e.stage}] ${e.message}`),
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (err) {
  console.error(`FAILED: ${err.name}: ${err.message}`);
  process.exit(1);
}
