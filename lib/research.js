// RESEARCH: the Director's desk researcher, on Tavily.
//
// Before the Director commits to a cut, Nemotron decides what (if anything) is worth
// looking up: the delivery spec of the platform the brief names, or the cutting
// conventions of the genre. Tavily answers; the Director reads the findings and cites
// them. Without TAVILY_API_KEY the step is skipped and the log says so.

import { fetch as undiciFetch } from "undici";
import { generateJSON } from "./llm.js";

const TAVILY_URL = "https://api.tavily.com/search";
const MAX_QUERIES = 2;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    queries: { type: "array", items: { type: "string" } },
    why: { type: "string" },
  },
  required: ["queries", "why"],
};

export async function tavilySearch(query, { apiKey = process.env.TAVILY_API_KEY, maxResults = 4, fetchImpl = undiciFetch } = {}) {
  const res = await fetchImpl(TAVILY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      include_answer: true,
      max_results: maxResults,
    }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return {
    query,
    answer: data.answer || "",
    sources: (data.results || []).slice(0, maxResults).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: String(r.content || "").slice(0, 400),
    })),
  };
}

export async function runResearch({ brief, preset = "", inventory = [], onLog = () => {}, env = process.env }) {
  if (!env.TAVILY_API_KEY) {
    onLog("no TAVILY_API_KEY; the Director works from the brief alone");
    return { queries: [], findings: [], skipped: true };
  }
  const { data: plan } = await generateJSON({
    system: [
      "You are the DIRECTOR's researcher in a film cutting room. Decide what, if anything,",
      "is worth looking up on the web before the cut is planned. Good reasons: the brief names",
      "a delivery platform (current max length, aspect ratio, safe zones), or a genre whose",
      "cutting conventions matter (trailer pacing, documentary B-roll norms). Do not research",
      "the footage itself. Zero queries is a fine answer. At most two short search queries.",
    ].join(" "),
    user: [
      `Brief: ${brief}`,
      `Preset: ${preset || "(none)"}`,
      `Footage: ${inventory.length} clips, ${inventory.map((c) => `${c.orientation} ${c.duration_seconds}s`).join(", ")}`,
      "Return only JSON: {\"queries\": [...], \"why\": \"one sentence\"}",
    ].join("\n"),
    schema: PLAN_SCHEMA,
    tier: "fast",
    thinking: false,
    maxTokens: 600,
    env,
  });
  const queries = (Array.isArray(plan.queries) ? plan.queries : [])
    .filter((q) => typeof q === "string" && q.trim())
    .slice(0, MAX_QUERIES);
  if (!queries.length) {
    onLog(`nothing to look up: ${plan.why || "the brief is self-contained"}`);
    return { queries: [], findings: [], why: plan.why };
  }
  onLog(`looking up ${queries.length}: ${queries.map((q) => `"${q}"`).join(", ")}`);
  const findings = [];
  for (const q of queries) {
    try {
      const r = await tavilySearch(q, { apiKey: env.TAVILY_API_KEY });
      findings.push(r);
      onLog(`tavily: "${q}" -> ${r.sources.length} sources${r.answer ? `; ${r.answer.slice(0, 140)}` : ""}`);
    } catch (err) {
      onLog(`tavily: "${q}" failed (${err.message})`);
    }
  }
  return { queries, findings, why: plan.why };
}

// Compact text block for the Director's prompt.
export function researchBrief(research) {
  if (!research?.findings?.length) return "";
  return [
    "DESK RESEARCH (from the web, via Tavily; cite a source when you rely on it):",
    ...research.findings.map((f) => [
      `Q: ${f.query}`,
      f.answer ? `A: ${f.answer}` : "",
      ...f.sources.slice(0, 3).map((s) => `- ${s.title} (${s.url}): ${s.snippet.slice(0, 200)}`),
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}
