import { test } from "node:test";
import assert from "node:assert/strict";
import { joinContinuousMoments, normaliseResult } from "../agents/selector.js";

const m = (s, e, size, action = "x", score = 0.5) => ({
  start_sec: s, end_sec: e, shot_size: size, action, intent_score: score,
  look_for_hits: [], audio_event: "none", camera_motion: "", subject_motion: "", notes: "", dead_shot: false,
});

test("joins back-to-back moments of one take", () => {
  const out = joinContinuousMoments([m(0, 2.5, "MS", "push in"), m(2.5, 5, "MS", "keeps pushing", 0.8), m(5.3, 7, "MS", "settles")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].start_sec, 0);
  assert.equal(out[0].end_sec, 7);
  assert.equal(out[0].intent_score, 0.8);
});

test("keeps moments apart across a size change or a real gap", () => {
  const out = joinContinuousMoments([m(0, 2, "WS"), m(2, 4, "CU"), m(6, 8, "CU")]);
  assert.equal(out.length, 3);
});

test("dead shots are dropped before joining", () => {
  const r = normaliseResult({ moments: [m(0, 2, "MS"), { ...m(2, 4, "MS"), dead_shot: true }, m(4, 6, "MS")] }, 10);
  assert.equal(r.moments.length, 2);
});
