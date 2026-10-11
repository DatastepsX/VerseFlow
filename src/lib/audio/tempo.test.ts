import assert from "node:assert/strict";
import { test } from "node:test";
import { barAt, detectTempo, snapToBar } from "./tempo";

/** Synthetic hip-hop style loop: kick on 1 and 3 (+ "and" of 3), snare on 2 and 4, eighth-note hats, noise. */
function beat(bpm: number, seconds: number, start = 0.37, sr = 22050) {
  const x = new Float32Array(Math.floor(seconds * sr));
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const beatLen = 60 / bpm;
  const add = (t: number, kind: "kick" | "snare" | "hat") => {
    const i0 = Math.floor(t * sr);
    const len = Math.floor((kind === "hat" ? 0.03 : 0.15) * sr);
    for (let i = 0; i < len && i0 + i < x.length; i++) {
      const tt = i / sr;
      const env = Math.exp(-tt * (kind === "kick" ? 25 : kind === "snare" ? 30 : 120));
      const s = kind === "kick" ? Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-tt * 40)) * tt) : rnd();
      x[i0 + i] += s * env * (kind === "kick" ? 0.9 : kind === "snare" ? 0.5 : 0.15);
    }
  };
  for (let b = 0; start + b * beatLen < seconds; b++) {
    const t = start + b * beatLen;
    const pos = b % 4;
    if (pos === 0 || pos === 2) add(t, "kick");
    if (pos === 2) add(t + beatLen / 2, "kick");
    if (pos === 1 || pos === 3) add(t, "snare");
    add(t, "hat");
    add(t + beatLen / 2, "hat");
  }
  for (let i = 0; i < x.length; i++) x[i] += rnd() * 0.01;
  return { x, sr };
}

for (const bpm of [72, 86, 92, 100, 128, 140]) {
  test(`detects ${bpm} BPM`, () => {
    const { x, sr } = beat(bpm, 40);
    const r = detectTempo(x, sr);
    const ok = [bpm, bpm * 2, bpm / 2].some((b) => Math.abs(r.bpm - b) <= 0.6);
    assert.ok(ok, `got ${r.bpm} for ${bpm}`);
    assert.ok(Math.abs(r.bpm - bpm) <= 0.6, `octave error: got ${r.bpm} for ${bpm}`);
  });
}

test("finds the downbeat", () => {
  const { x, sr } = beat(92, 40, 0.37);
  const r = detectTempo(x, sr);
  assert.ok(Math.abs(r.offset - 0.37) < 0.05, `offset ${r.offset}`);
});

test("bar math", () => {
  assert.deepEqual(barAt(0.5, 120, 0.5), { bar: 1, beat: 1 });
  assert.deepEqual(barAt(2.6, 120, 0.5), { bar: 2, beat: 1 });
  assert.deepEqual(barAt(3.1, 120, 0.5), { bar: 2, beat: 2 });
  assert.equal(snapToBar(2.3, 120, 0.5), 2.5);
});
