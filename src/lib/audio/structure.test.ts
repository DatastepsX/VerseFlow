import assert from "node:assert/strict";
import { test } from "node:test";
import { alignStarts, analyseBeat, snapSectionStart } from "./structure";

const SR = 11025;

/**
 * A synthetic beat: kick on every bar start, hats on the beats, at a tempo
 * that is NOT a whole number; from bar `changeBar` a bright synth pad comes in.
 */
function song(bpm: number, offset: number, bars: number, changeBar: number) {
  const beat = 60 / bpm;
  const len = Math.ceil((offset + bars * 4 * beat + 1) * SR);
  const x = new Float32Array(len);
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let k = 0; k < bars * 4; k++) {
    const t0 = Math.floor((offset + k * beat) * SR);
    const down = k % 4 === 0;
    for (let i = 0; i < 0.12 * SR && t0 + i < len; i++) {
      const env = Math.exp(-i / (0.03 * SR));
      if (down) x[t0 + i] += 0.9 * Math.sin((2 * Math.PI * 55 * i) / SR) * env; // kick
      x[t0 + i] += 0.25 * noise() * Math.exp(-i / (0.008 * SR)); // hat
    }
  }
  const c0 = Math.floor((offset + changeBar * 4 * beat) * SR);
  for (let i = c0; i < len; i++) x[i] += 0.15 * Math.sin((2 * Math.PI * 1760 * i) / SR) + 0.1 * Math.sin((2 * Math.PI * 660 * i) / SR);
  return x;
}

test("exact tempo, bar 1 and the beat change of a song", () => {
  const bpm = 97.3;
  const offset = 0.61;
  const x = song(bpm, offset, 24, 12);
  const fit = analyseBeat(x, SR, 97); // a rough tempo is refined
  assert.ok(Math.abs(fit.bpm - bpm) < 0.05, `bpm ${fit.bpm}`);
  const bar = 240 / bpm;
  const phase = (((fit.offset - offset) % bar) + bar) % bar;
  assert.ok(Math.min(phase, bar - phase) < 0.03, `offset ${fit.offset}`);
  const change = offset + 12 * bar;
  assert.ok(
    fit.changes.some((c) => Math.abs(c.t - change) < 0.05),
    `changes ${fit.changes.map((c) => c.t).join(", ")} — expected ${change.toFixed(2)}`,
  );
});

test("section starts snap to a close beat change, else to the nearest bar line", () => {
  const grid = { bpm: 120, beat_offset: 0.5, beats_per_bar: 4, changes: [{ t: 16.5, s: 0.9 }] }; // 2 s bars
  assert.equal(snapSectionStart(15.9, grid), 16.5); // vocals a bit early → the change
  assert.equal(snapSectionStart(7.2, grid), 6.5); // no change near → nearest bar line
  assert.equal(snapSectionStart(7.6, grid), 8.5);
});

test("aligned sections keep their order", () => {
  const grid = { bpm: 120, beat_offset: 0, beats_per_bar: 4, changes: [{ t: 10, s: 1 }] };
  // both near the change: the first takes it, the second moves to its own bar
  assert.deepEqual(alignStarts([9.4, 10.6, 30.2], grid), [10, 12, 30]);
  // two sections at the same spot stay together
  assert.deepEqual(alignStarts([3.1, 3.1], grid), [4, 4]);
});
