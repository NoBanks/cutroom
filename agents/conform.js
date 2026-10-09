// ASSISTANT EDITOR: conforms the Editor's EDL into a real Shotcut timeline by
// calling the shotcut-mcp tools itself (Nemotron tool use over MCP), then checks
// its own work with get_timeline. Code then verifies the timeline against the EDL
// frame by frame. If the agent's timeline does not match, the code conforms it
// directly and the log says so; the cut is never left wrong.

import { chat } from "../lib/llm.js";

const FRAME_TOLERANCE = 1.5; // frames

const SYSTEM = `You are the ASSISTANT EDITOR in a virtual cutting room. The Editor has
locked an edit decision list (EDL). Your job is to conform it into a Shotcut timeline
with the tools you have, exactly as written, then verify it.

Procedure:
1. create_project with the given name, width, height and fps.
2. add_clip once per EDL row, in EDL order, with clip_path, in_s = source_start_sec,
   out_s = source_end_sec. Keep the producer_id each call returns.
3. If the EDL notes ask for a title card, add it with append_text_overlay.
4. Call get_timeline and compare it to the EDL: same number of clips, same order,
   same in/out points. Fix any mismatch with trim_clip, move_clip or remove_clip.
5. When the timeline matches, reply with one short line saying it is conformed.

Never invent clips or change the Editor's choices. Do not render; the cutting room
renders after you finish.`;

function frames(sec, fps) {
  return Math.round(sec * fps);
}

export function verifyTimeline(timeline, edl, clipPaths, fps) {
  const problems = [];
  const clips = timeline?.clips || [];
  if (clips.length !== edl.length) problems.push(`timeline has ${clips.length} clips, EDL has ${edl.length}`);
  edl.forEach((row, i) => {
    const c = clips[i];
    if (!c) return;
    const want = clipPaths[row.clip_id];
    if (c.clip_path !== want) problems.push(`position ${i + 1}: wrong source`);
    if (Math.abs(frames(c.in_s, fps) - frames(row.source_start_sec, fps)) > FRAME_TOLERANCE)
      problems.push(`position ${i + 1}: in ${c.in_s}s, EDL says ${row.source_start_sec}s`);
    if (Math.abs(frames(c.out_s, fps) - frames(row.source_end_sec, fps)) > FRAME_TOLERANCE)
      problems.push(`position ${i + 1}: out ${c.out_s}s, EDL says ${row.source_end_sec}s`);
  });
  return problems;
}

async function codeConform(timeline, { projectName, width, height, fps, edl, clipPaths }) {
  await timeline.call("create_project", { name: projectName, width, height, fps });
  for (const row of edl) {
    const r = await timeline.call("add_clip", {
      project_name: projectName,
      clip_path: clipPaths[row.clip_id],
      in_s: row.source_start_sec,
      out_s: row.source_end_sec,
    });
    if (r.error) throw new Error(`add_clip failed: ${r.error}`);
  }
  return timeline.call("get_timeline", { project_name: projectName });
}

const REVISE_SYSTEM = `You are the ASSISTANT EDITOR. The Reviewer watched the cut and
issued orders; the Editor's revised EDL is the target. The project already exists.
Change the EXISTING timeline into the target using trim_clip, move_clip, remove_clip
and add_clip (add_clip appends at the end; follow it with move_clip to place it).
Call get_timeline first to see producer_ids, and again at the end to verify the
timeline matches the target: same clips, same order, same in/out points. Then reply
with one short line. Do not create a new project. Do not render.`;

export async function runConform({
  timeline,
  projectName,
  width,
  height,
  fps,
  edl,
  clipPaths,
  titleCard,
  onLog = () => {},
  maxSteps,
  mode = "conform",
  orders = [],
}) {
  const steps = maxSteps || edl.length * 3 + 10;
  const tools = timeline.openAITools([
    "create_project", "add_clip", "trim_clip", "move_clip", "remove_clip",
    "append_text_overlay", "get_timeline",
  ].filter((n) => mode === "conform" || n !== "create_project"));
  const edlForAgent = edl.map((row, i) => ({
    position: i + 1,
    clip_path: clipPaths[row.clip_id],
    source_start_sec: row.source_start_sec,
    source_end_sec: row.source_end_sec,
    role: row.role,
  }));
  const messages = [
    { role: "system", content: mode === "revise" ? REVISE_SYSTEM : SYSTEM },
    {
      role: "user",
      content: [
        mode === "revise" ? `Reviewer orders: ${JSON.stringify(orders)}` : "",
        `Project name: ${projectName}`,
        `Frame: ${width}x${height} at ${fps} fps`,
        titleCard ? `Title card: "${titleCard.text}" from ${titleCard.start_s}s to ${titleCard.end_s}s` : "No title card.",
        `${mode === "revise" ? "TARGET " : ""}EDL (${edl.length} rows): ${JSON.stringify(edlForAgent)}`,
      ].join("\n"),
    },
  ];

  const toolLog = [];
  let agentDone = false;
  try {
    for (let step = 0; step < steps; step++) {
      const { message } = await chat({
        tier: "fast",
        messages,
        tools,
        toolChoice: "auto",
        maxTokens: 1500,
        thinking: false,
        temperature: 0,
      });
      messages.push({ role: "assistant", content: message.content || "", tool_calls: message.tool_calls });
      if (!message.tool_calls?.length) {
        agentDone = true;
        onLog(`assistant editor: ${(message.content || "done").trim().slice(0, 160)}`);
        break;
      }
      for (const callReq of message.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(callReq.function.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await timeline.call(callReq.function.name, args);
        toolLog.push({ tool: callReq.function.name, args, result });
        onLog(`assistant editor -> ${callReq.function.name}${result.error ? ` (error: ${result.error})` : ""}`);
        messages.push({ role: "tool", tool_call_id: callReq.id, content: JSON.stringify(result) });
      }
    }
  } catch (err) {
    if (err.name === "SpendCapError") throw err;
    onLog(`assistant editor stopped: ${err.message}`);
  }

  let final = await timeline.call("get_timeline", { project_name: projectName });
  let problems = final.error ? [final.error] : verifyTimeline(final, edl, clipPaths, fps);
  let conformedBy = "agent";
  if (!agentDone || problems.length) {
    onLog(`timeline check: ${problems.length ? problems.join("; ") : "agent did not finish"}. Conforming in code.`);
    final = await codeConform(timeline, { projectName, width, height, fps, edl, clipPaths });
    if (titleCard) {
      await timeline.call("append_text_overlay", { project_name: projectName, ...titleCard });
      final = await timeline.call("get_timeline", { project_name: projectName });
    }
    problems = verifyTimeline(final, edl, clipPaths, fps);
    conformedBy = "code";
    if (problems.length) throw new Error(`Conform failed verification: ${problems.join("; ")}`);
  } else {
    onLog(`timeline check: ${edl.length}/${edl.length} clips match the EDL to the frame`);
  }
  return { timeline: final, conformedBy, toolCalls: toolLog.length, toolLog };
}
