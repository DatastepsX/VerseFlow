import { test } from "node:test";
import assert from "node:assert/strict";
import { joinTakes, partsOf, resample } from "./join";

const SR = 1000;
const fill = (seconds: number, v: number) => new Float32Array(Math.round(seconds * SR)).fill(v);
const at = (x: { samples: Float32Array; at: number }, t: number) => x.samples[Math.floor((t - x.at) * SR)];

test("a take in two pieces: the first up to the joint, the new one from it", () => {
  // take so far: 2..6 s (value 1); the new piece recorded from 4.5 s with a bar of run-up (value 2)
  const j = joinTakes({ samples: fill(4, 1), sampleRate: SR, at: 2 }, { samples: fill(4, 2), sampleRate: SR, at: 3.5 }, 5);
  assert.equal(j.at, 2);
  assert.ok(Math.abs(j.samples.length / SR - 5.5) < 0.002, "ends with the new piece (7.5 s)");
  assert.equal(at(j, 3), 1, "before the joint: the take so far (the new piece's run-up not heard)");
  assert.equal(at(j, 4.9), 1);
  assert.equal(at(j, 5.2), 2, "after it: the new piece");
  assert.equal(at(j, 7.4), 2);
  const mid = at(j, 5);
  assert.ok(mid > 1 && mid < 2, `crossing over at the joint (${mid})`);
});

test("redo from a line: what came after the joint is replaced; a cut take keeps its cut", () => {
  const before = { samples: fill(6, 1), sampleRate: SR, at: 0, clip: { from: 1, to: 5 } };
  const j = joinTakes(before, { samples: fill(2, 3), sampleRate: SR, at: 2.5 }, 3);
  assert.equal(j.at, 1, "starts where the cut take starts to play");
  assert.equal(at(j, 2), 1);
  assert.equal(at(j, 4), 3, "the old take after the joint is gone");
  assert.ok(Math.abs(j.samples.length / SR - 3.5) < 0.002);
});

test("pieces at another sample rate, and the parts count", () => {
  const y = resample(new Float32Array([0, 1, 2, 3]), 2, 4);
  assert.equal(y.length, 8);
  assert.equal(y[1], 0.5);
  assert.equal(partsOf("2 parts"), 2);
  assert.equal(partsOf(null), 1);
});

import { findJoint } from "./join";

const sr2 = 8000;
/** a take from `at`: silence, a tone between t0 and t1 (song time), amplitude a; more tones may be added */
function take(at: number, len: number, tones: [number, number, number][]) {
  const x = new Float32Array(Math.round(len * sr2));
  for (const [t0, t1, a] of tones)
    for (let i = Math.max(0, Math.round((t0 - at) * sr2)); i < Math.min(x.length, Math.round((t1 - at) * sr2)); i++) x[i] += a * Math.sin(i * 0.3);
  return { samples: x, sampleRate: sr2, at };
}

test("continuing a take: a voice coming in before the joint is kept — the joint moves to just before it", () => {
  const before = take(0, 4, [[0, 2, 0.5]]); // the take so far: words until 2.0
  const after = take(1, 5, [[2.6, 5, 0.4]]); // the new piece comes in at 2.6 — the joint was planned at 3.0
  const j = findJoint(before, after, 3);
  assert.ok(j > 2.4 && j < 2.6, String(j));
  const out = joinTakes(before, after, j);
  // the first syllables of the new piece are in the take
  const k = Math.round((2.65 - out.at) * sr2);
  assert.ok(Math.abs(out.samples[k]) > 0 || Math.abs(out.samples[k + 1]) > 0);
});

test("the joint never moves into the last word, nor onto the take heard through the speakers", () => {
  // the new piece also hears the take so far (no headphones): its words until 2.0, softer; the voice at 2.6
  const before = take(0, 4, [[0, 2, 0.5]]);
  const after = take(1, 5, [[1, 2, 0.15], [2.6, 5, 0.4]]);
  const j = findJoint(before, after, 3);
  assert.ok(j > 2.4 && j < 2.6, String(j));
  // coming in late: the joint stays
  assert.equal(findJoint(before, take(1, 5, [[3.4, 5, 0.4]]), 3), 3);
});
