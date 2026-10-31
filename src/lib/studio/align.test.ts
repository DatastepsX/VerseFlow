import { test } from "node:test";
import assert from "node:assert/strict";
import { bestShift, nearestStep, onsets, toGrid, toGuide, toTimes } from "./align";

const SR = 16000;
/** a sung-like burst (a tone with harmonics, an attack and a decay) at each time, for `len` s */
function voice(times: number[], seconds: number, len = 0.16, f0 = 180) {
  const x = new Float32Array(Math.round(seconds * SR));
  for (const t of times) {
    const a = Math.round(t * SR);
    for (let i = 0; i < len * SR && a + i < x.length; i++) {
      const env = Math.min(1, i / (0.01 * SR)) * Math.exp(-i / (0.09 * SR));
      const ph = (2 * Math.PI * f0 * i) / SR;
      x[a + i] += 0.5 * env * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph));
    }
  }
  return x;
}
const near = (found: number[], want: number[], tol: number) => want.filter((w) => found.some((f) => Math.abs(f - w) <= tol)).length;

test("onsets: the syllables' starts", () => {
  const times = [0.3, 0.6, 0.85, 1.2, 1.5, 1.9];
  const on = onsets(voice(times, 2.5), SR);
  assert.equal(near(on, times, 0.02), times.length, JSON.stringify(on));
});

test("a double follows the lead: each syllable lands on the lead's", () => {
  const lead = [0.3, 0.6, 0.85, 1.2, 1.5, 1.9, 2.3];
  // the double is a little late here, early there (up to 70 ms)
  const late = [0.05, -0.04, 0.07, 0.03, -0.06, 0.06, 0.02];
  const dbl = voice(lead.map((t, i) => t + late[i]), 3, 0.16, 200);
  const before = near(onsets(dbl, SR), lead, 0.02);
  const r = toGuide(dbl, voice(lead, 3), SR, 0);
  const after = near(onsets(r.samples, SR), lead, 0.02);
  assert.equal(r.samples.length, dbl.length);
  assert.ok(after >= lead.length - 1 && after > before, `before ${before}, after ${after}`);
  assert.ok(r.moved > 0.01);
});

test("on the beat: syllables pulled onto the 16ths, the take keeps its length", () => {
  const step = 60 / 90 / 4; // a 16th at 90 BPM
  const grid = [2, 4, 7, 8, 12, 14, 16].map((k) => 0.25 + k * step);
  const off = [0.03, -0.035, 0.025, -0.03, 0.04, -0.02, 0.03];
  const take = voice(grid.map((t, i) => t + off[i]), 3);
  const full = toGrid(take, SR, 0, { origin: 0.25, step }, 1);
  assert.equal(full.samples.length, take.length);
  assert.ok(near(onsets(full.samples, SR), grid, 0.012) >= grid.length - 1, JSON.stringify(onsets(full.samples, SR)));
  // half strength: half the way
  const half = toGrid(take, SR, 0, { origin: 0.25, step }, 0.5);
  assert.ok(Math.abs(half.moved - full.moved / 2) < 0.005);
});

test("swing and triplets: where the grid's steps fall", () => {
  const g = { origin: 0, step: 0.25 };
  assert.equal(nearestStep(0.24, g), 0.25);
  // a full shuffle: the off-step a third of a step late (0.25 → 0.333)
  assert.ok(Math.abs(nearestStep(0.32, { ...g, swing: 1 }) - (0.25 + 0.25 / 3)) < 1e-9);
  assert.equal(nearestStep(0.49, { ...g, swing: 1 }), 0.5, "the on-steps stay");
  // 8th triplets at 90 BPM: a third of a beat
  const beat = 60 / 90;
  assert.ok(Math.abs(nearestStep(0.23, { origin: 0, step: beat / 3 }) - beat / 3) < 1e-9);
});

test("shift: the whole take moved onto the grid, the sound unchanged", () => {
  const step = 0.125;
  // sung 40 ms late, steady
  const sung = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5].map((t) => t + 0.04);
  const b = bestShift(voice(sung, 2), SR, 0, { origin: 0, step });
  // within the onset finder's 10 ms frames
  assert.ok(Math.abs(b.shift + 0.04) <= 0.015, `shift ${b.shift}`);
  assert.equal(b.count, sung.length);
});

test("on the flow: syllables pulled onto the written flow's times", () => {
  const flow = [0.3, 0.55, 0.8, 1.2, 1.45];
  const off = [0.06, -0.05, 0.04, -0.06, 0.05];
  const take = voice(flow.map((t, i) => t + off[i]), 2);
  const before = near(onsets(take, SR), flow, 0.02);
  const r = toTimes(take, SR, 0, flow, 1);
  const after = near(onsets(r.samples, SR), flow, 0.02);
  assert.equal(r.samples.length, take.length);
  assert.ok(after >= flow.length - 1 && after > before, `before ${before}, after ${after}`);
});

test("on the beat with swing: off-step syllables land late", () => {
  const step = 0.25;
  const g = { origin: 0, step, swing: 1 };
  const sung = [0.25, 0.5, 0.75, 1.0, 1.25].map((t) => t + 0.03);
  const r = toGrid(voice(sung, 2), SR, 0, g, 1);
  const want = [0.25 + step / 3, 0.5, 0.75 + step / 3, 1.0, 1.25 + step / 3];
  assert.ok(near(onsets(r.samples, SR), want, 0.025) >= want.length - 1);
});
