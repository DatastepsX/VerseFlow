import assert from "node:assert/strict";
import { test } from "node:test";
import { measureClaps } from "./timing";

const SR = 16000;
/** claps (short noise bursts) at given times, in a little room noise */
function claps(times: number[], length: number) {
  const x = new Float32Array(Math.ceil(length * SR));
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < x.length; i++) x[i] = rnd() * 0.003;
  for (const t of times) {
    const s0 = Math.floor(t * SR);
    for (let i = 0; i < 0.04 * SR; i++) x[s0 + i] += rnd() * 0.6 * Math.exp(-i / (0.008 * SR));
  }
  return x;
}

test("clap-along calibration: the median delay of the claps behind the clicks", () => {
  const clicks = [1, 1.6, 2.2, 2.8, 3.4, 4, 4.6, 5.2];
  // a writer about 70 ms behind, ± a little, one clap missed
  const jitter = [0.06, 0.075, 0.07, 0.08, 0.065, 0.07, 0.072];
  const rec = claps(clicks.slice(0, 7).map((t, i) => t + jitter[i]), 6);
  const r = measureClaps(rec, SR, 0, clicks);
  assert.ok(r);
  assert.equal(r.found, 7);
  assert.ok(Math.abs(r.delay - 0.07) < 0.008, String(r.delay));
});

test("clap-along calibration: no claps, or claps all over the place → no result", () => {
  const clicks = [1, 1.6, 2.2, 2.8, 3.4, 4, 4.6, 5.2];
  assert.equal(measureClaps(claps([], 6), SR, 0, clicks), null);
  const wild = [0.05, -0.12, 0.3, 0.0, 0.25, -0.1, 0.35, 0.02];
  assert.equal(measureClaps(claps(clicks.map((t, i) => t + wild[i]), 6), SR, 0, clicks), null);
});
