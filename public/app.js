// CUTROOM front end: no framework, one poller.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CREW = [
  { key: "research", name: "RESEARCH", tier: "fast", job: "looks things up on Tavily", extra: "+ Tavily" },
  { key: "director", name: "DIRECTOR", tier: "reason", job: "commits to a point of view" },
  { key: "selector", name: "SELECTOR", tier: "vision", job: "watches every clip" },
  { key: "editor", name: "EDITOR", tier: "reason", job: "cuts against the intent" },
  { key: "assistant", name: "ASSISTANT ED.", tier: "fast", job: "builds the timeline over MCP" },
  { key: "render", name: "RENDER", tier: null, job: "melt renders the cut" },
  { key: "reviewer", name: "REVIEWER", tier: "reason", job: "screens it, orders one pass" },
  { key: "coverage", name: "COVERAGE", tier: "fast", job: "writes the pickup list" },
];
const ORDER = ["inventory", "research", "director", "selector", "editor", "assistant", "render", "reviewer", "coverage", "done"];

let session = null;
let preset = "";
let poller = null;
let models = {};

function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
  window.scrollTo(0, 0);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function shortModel(m) {
  return (m || "").replace(/^nvidia\//, "").replace(/^zai-org\//, "");
}

const DEFAULT_MODELS = {
  reason: "nvidia/nemotron-3-super-120b-a12b",
  fast: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  vision: "zai-org/GLM-5.3-Flash",
};
let REPLAY = false;

async function loadHealth() {
  try {
    const h = await api("/api/health");
    models = h.models;
  } catch {
    // No live server: this is the static public demo. Show recorded runs.
    REPLAY = true;
    models = DEFAULT_MODELS;
    await loadGallery();
  }
  $("m-reason").textContent = shortModel(models.reason);
  $("m-fast").textContent = shortModel(models.fast);
  $("m-vision").textContent = shortModel(models.vision);
}

// ---- replay mode (static demo) ------------------------------------------
async function loadGallery() {
  document.body.classList.add("replay");
  let runs = [];
  try {
    runs = await (await fetch("replays/index.json")).json();
  } catch {}
  $("gallery").innerHTML = runs.map((r) => `
    <button class="run-card" data-id="${esc(r.id)}">
      <span class="run-title">${esc(r.title)}</span>
      <span class="run-brief">"${esc(r.brief)}"</span>
      <span class="run-meta">${r.shots} shots · ${Number(r.runtime_sec).toFixed(1)}s cut · cut in ${Math.round(r.elapsed_sec / 60)} min · $${Number(r.cost).toFixed(3)} in model calls</span>
    </button>`).join("");
  document.querySelectorAll(".run-card").forEach((b) => b.addEventListener("click", () => playReplay(b.dataset.id)));
}

let replayTimer = null;
async function playReplay(id) {
  const full = await (await fetch(`replays/${id}/session.json`)).json();
  const events = full.log;
  const total = events.length ? events.at(-1).t : 0;
  const speed = Math.max(1, total / 45); // the whole run plays in about 45 seconds
  session = { ...full, status: "running", stage: null, log: [], costUsd: 0, intent: null };
  $("room-brief").textContent = `"${full.brief}"`;
  $("replay-note").textContent = `Replay of a real run recorded ${full.recordedAt ? new Date(full.recordedAt).toLocaleDateString() : ""}, ${Math.round(total)}s of real time played at ${speed.toFixed(0)}x.`;
  renderRoom();
  show("s-room");
  const started = performance.now();
  let i = 0;
  clearInterval(replayTimer);
  const finish = () => {
    clearInterval(replayTimer);
    session = { ...full };
    renderRoom();
    setTimeout(renderResult, 600);
  };
  $("btn-skip").onclick = finish;
  replayTimer = setInterval(() => {
    const now = ((performance.now() - started) / 1000) * speed;
    while (i < events.length && events[i].t <= now) {
      const e = events[i++];
      session.log.push(e);
      session.stage = e.stage;
      session.costUsd = e.cost;
      if (e.stage === "selector" && !session.intent) session.intent = full.intent;
    }
    renderRoom();
    if (i >= events.length) finish();
  }, 200);
}

// ---- intake -------------------------------------------------------------
async function startSession(form, query = "") {
  $("landing-error").textContent = "";
  $("btn-sample").disabled = true;
  $("btn-sample").textContent = "Loading footage...";
  try {
    session = await api(`/api/sessions${query}`, { method: "POST", body: form });
    renderInventory();
    show("s-brief");
    $("brief").focus();
  } catch (err) {
    $("landing-error").textContent = err.message;
  } finally {
    $("btn-sample").disabled = false;
    $("btn-sample").textContent = "Run the sample footage";
  }
}

function renderInventory() {
  $("inventory").innerHTML = session.inventory
    .map((c) => `<div class="inv-row"><span>${esc(c.filename)}</span><span>${c.duration_seconds.toFixed(1)}s · ${esc(c.resolution)} · ${c.has_audio ? "sound" : "no sound"}</span></div>`)
    .join("");
}

$("btn-sample").addEventListener("click", () => {
  startSession(new FormData(), "?sample=1").then(() => {
    if (session && !$("brief").value) {
      $("brief").value = "A 20 second teaser for a framed art print: a lone green astronaut in a pink room. Quiet, a little lonely, patient. End on the astronaut.";
    }
  });
});

function uploadFiles(files) {
  if (!files.length) return;
  const form = new FormData();
  [...files].forEach((f) => form.append("clips", f));
  startSession(form);
}
$("file-input").addEventListener("change", (e) => uploadFiles(e.target.files));
const dz = $("dropzone");
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", (e) => uploadFiles(e.dataTransfer.files));

document.querySelectorAll(".chip[data-preset]").forEach((chip) => {
  chip.addEventListener("click", () => {
    const on = chip.classList.contains("on");
    document.querySelectorAll(".chip[data-preset]").forEach((c) => c.classList.remove("on"));
    preset = on ? "" : chip.dataset.preset;
    if (!on) chip.classList.add("on");
  });
});

$("btn-run").addEventListener("click", async () => {
  $("brief-error").textContent = "";
  const brief = $("brief").value.trim() || preset;
  if (!brief) {
    $("brief-error").textContent = "Tell the crew what you want, or pick a preset.";
    return;
  }
  $("btn-run").disabled = true;
  try {
    session = await api(`/api/sessions/${session.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief, preset }),
    });
    $("room-brief").textContent = `"${brief}"`;
    renderRoom();
    show("s-room");
    poller = setInterval(poll, 1500);
  } catch (err) {
    $("brief-error").textContent = err.message;
  } finally {
    $("btn-run").disabled = false;
  }
});

// ---- cutting room -------------------------------------------------------
function stageIndex(stage) {
  const i = ORDER.indexOf(stage);
  return i < 0 ? 0 : i;
}

function renderRoom() {
  const current = stageIndex(session.stage);
  const finished = session.status === "complete";
  $("crew").innerHTML = CREW.map((c) => {
    const i = ORDER.indexOf(c.key);
    const state = finished || current > i ? "done" : current === i ? "active" : "";
    const label = state === "done" ? "done" : state === "active" ? "working" : session.status === "queued" ? "waiting" : "";
    return `<li class="chair ${state}"><div class="who">${c.name}</div><div class="model">${c.tier ? esc(shortModel(models[c.tier])) + (c.extra ? ` ${c.extra}` : "") : "shotcut-mcp + melt"}</div><div class="state">${label}</div></li>`;
  }).join("");

  if (session.intent?.directors_note) {
    $("director-note").classList.remove("hidden");
    $("director-note").innerHTML = `<b>DIRECTOR'S NOTE</b>${esc(session.intent.directors_note)}`;
  }
  const log = $("log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const lines = session.status === "queued" && !session.log.length
    ? [{ stage: "queue", message: `another cut is running; you are number ${session.queuePosition} in line` }]
    : session.log;
  log.innerHTML = lines.map((e) => {
    const mcp = /assistant editor ->|through shotcut-mcp|timeline check/.test(e.message);
    return `<li class="${esc(e.stage)}${mcp ? " mcp" : ""}"><span class="tag">${esc(e.stage)}</span><span class="msg">${esc(e.message)}</span></li>`;
  }).join("");
  if (atBottom) log.scrollTop = log.scrollHeight;
  $("cost").textContent = `$${(session.costUsd || 0).toFixed(4)}`;
  $("room-error").textContent = session.error || "";
}

async function poll() {
  try {
    session = await api(`/api/sessions/${session.id}`);
  } catch {
    return;
  }
  renderRoom();
  if (session.status === "complete") {
    clearInterval(poller);
    setTimeout(renderResult, 800);
  } else if (session.status === "error") {
    clearInterval(poller);
  }
}

// ---- results ------------------------------------------------------------
function fmt(n) {
  return Number(n).toFixed(2);
}

// Joined takes carry every sub-description ("...; then ..."); show the opening one.
function shortAction(a) {
  const first = String(a || "").split("; then ")[0];
  return first.length > 160 ? first.slice(0, 157) + "..." : first;
}

function renderResult() {
  const s = session;
  const f = s.files;
  $("cost-final").textContent = `$${(s.costUsd || 0).toFixed(4)}`;
  const player = $("player");
  const finalSrc = f["roughcut.mp4"];
  const firstSrc = f["roughcut_v1.mp4"];
  player.src = finalSrc;
  const frame = s.summary?.frame;
  if (frame) player.style.aspectRatio = `${frame.width} / ${frame.height}`;
  $("v-first").classList.toggle("hidden", !firstSrc || !s.review || !s.edl?.review_applied);
  $("v-final").onclick = () => { player.src = finalSrc; $("v-final").classList.add("on"); $("v-first").classList.remove("on"); player.play(); };
  $("v-first").onclick = () => { player.src = firstSrc; $("v-first").classList.add("on"); $("v-final").classList.remove("on"); player.play(); };

  const dl = [
    ["roughcut.mp4", "Rough cut", "video"],
    ["roughcut.mlt", "Shotcut project", "keep cutting in Shotcut"],
    ["edl_final.json", "EDL (final)", "json"],
    ["edl.json", "EDL (first cut)", "json"],
    ["pickups.txt", "Pickup call sheet", "text"],
  ].filter(([k]) => f[k]);
  $("downloads").innerHTML = dl.map(([k, label, kind]) => `<a href="${f[k]}" download>${label}<span>${kind}</span></a>`).join("");

  const intent = s.intent || {};
  $("r-director").textContent = intent.directors_note || "";
  $("r-intent").innerHTML = (intent.pacing_profile
    ? esc(`${intent.pacing_profile} pacing · ${intent.target_length_sec}s target · shots ${intent.shot_length_band_sec?.join("-")}s · ${(intent.tone_words || []).join(", ")}`)
    : "") + ((intent.research_sources || []).length
    ? `<br>Researched on Tavily: ${intent.research_sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join(" · ")}`
    : "");

  if (s.review) {
    $("r-review").innerHTML = `<b>${s.review.verdict === "ship" ? "Ship it." : "One pass."}</b> ${esc(s.review.reviewers_note)}`;
    $("r-orders").innerHTML = (s.review.orders || []).map((o) =>
      `<li><span class="mono">${esc(o.op)} #${esc(o.position)}${o.delta_sec ? ` ${o.delta_sec > 0 ? "+" : ""}${fmt(o.delta_sec)}s` : ""}</span> ${esc(o.reason)}</li>`).join("");
  } else {
    $("r-review").textContent = "The review did not run; the first cut stands.";
  }

  const conform = s.conform;
  const sum = s.summary || {};
  $("r-conform").textContent = conform
    ? `${sum.mcp_tool_calls ?? conform.toolCalls.length} tool calls to shotcut-mcp. Timeline ${conform.conformedBy === "agent" ? "built by the agent" : "rebuilt in code after the agent's version failed the frame check"}${sum.revised_by ? `; the Reviewer's orders applied by the ${sum.revised_by}` : ""}. Every clip verified against the EDL to the frame.`
    : "";
  $("r-tools").innerHTML = (conform?.toolCalls || []).map((t) => {
    const a = t.args || {};
    const detail = t.tool === "add_clip" ? `${(a.clip_path || "").split("/").pop()} ${a.in_s}-${a.out_s}s` : t.tool === "create_project" ? `${a.width}x${a.height} @ ${a.fps}` : a.producer_id || "";
    return `<li class="${t.error ? "err" : ""}">${esc(t.tool)}(${esc(detail)})${t.error ? ` ! ${esc(t.error)}` : ""}</li>`;
  }).join("");

  const edl = s.edl?.edl || [];
  $("edl").innerHTML = `<tr><th>#</th><th>Clip</th><th>In-out</th><th>Len</th><th>Role</th><th>On screen</th></tr>` +
    edl.map((r, i) => `<tr><td class="num">${i + 1}</td><td class="num">${esc(r.filename)}</td><td class="num">${fmt(r.source_start_sec)}-${fmt(r.source_end_sec)}</td><td class="num">${fmt(r.duration_sec)}s</td><td>${esc(r.role)}</td><td>${esc(shortAction(r.action))}</td></tr>`).join("");

  const cov = s.coverage;
  $("r-coverage").textContent = cov?.coverage_summary || (cov ? "" : "Coverage did not run.");
  $("r-pickups").innerHTML = (cov?.pickups || []).slice(0, 8).map((p) =>
    `<li><span class="size">${esc(p.shot_size)}</span>${esc(p.shot || "")}<span class="muted"> · ${esc(p.movement || "")} · roll ${esc(p.duration_sec)}s${p.camera_note ? ` · ${esc(p.camera_note)}` : ""}</span></li>`).join("") +
    (cov?.next_shoot_note ? `</ol><p class="small"><b>On set:</b> ${esc(cov.next_shoot_note)}</p><ol>` : "");
  show("s-result");
}

$("btn-again").addEventListener("click", () => {
  clearInterval(replayTimer);
  session = null;
  $("brief").value = "";
  show("s-landing");
});

loadHealth();
