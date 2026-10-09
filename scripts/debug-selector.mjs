import { buildInventory } from "../lib/pipeline.js";
import { runSelector } from "../agents/selector.js";
const { inventory, clips } = await buildInventory([process.argv[2]]);
const intent = JSON.parse(process.argv[3] || '{"pacing_profile":"slow","look_for":["astronaut"],"avoid":[],"shot_length_band_sec":[4,10]}');
const r = await runSelector({ clips, inventory, sessionDir: "/tmp/dbgsel", intent, onProgress: (p) => console.log(p.message) });
console.log(JSON.stringify(r.moments.slice(0, 3), null, 1), r.moments.length, r.errors);
