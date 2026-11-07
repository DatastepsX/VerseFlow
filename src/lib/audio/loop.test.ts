import assert from "node:assert/strict";
import { test } from "node:test";
import { loopBars } from "./loop";
import type { LineFlow } from "@/lib/types";

const grid = { bpm: 88.774, beat_offset: 0.11, beats_per_bar: 4 };
const bar = 240 / 88.774;
const flow = (times: number[]): LineFlow => ({ syllables: times.length, stress: [], held: false, words: "", times, end: times[times.length - 1] + 0.2 });

test("a line's loop: whole bars from the bar it starts on, a pickup included", () => {
  // "Il tuo nome sul portone…": at 124.19, a pickup to the bar at 124.47, sung over ~1.3 bars → 2 bars
  const at = 124.189;
  const r = loopBars({ audio_at: at, flow: flow(Array.from({ length: 16 }, (_, k) => at + k * 0.21)) }, grid, 190)!;
  assert.ok(Math.abs(r.from - 124.47) < 0.01, String(r.from));
  assert.equal(r.bars, 2);
  assert.ok(Math.abs(r.to - r.from - 2 * bar) < 1e-6);
});

test("a short line loops one bar, a long one four; never past the song's end", () => {
  const short = loopBars({ audio_at: 45.5, flow: flow([45.5, 45.8, 46.1, 46.5]) }, grid, 190)!;
  assert.equal(short.bars, 1);
  const long = loopBars({ audio_at: 10, flow: flow(Array.from({ length: 30 }, (_, k) => 10 + k * 0.25)) }, grid, 190)!;
  assert.equal(long.bars, 4);
  const end = loopBars({ audio_at: 186, flow: flow(Array.from({ length: 20 }, (_, k) => 186 + k * 0.25)) }, grid, 190)!;
  assert.ok(end.to <= 190);
  assert.equal(loopBars({ audio_at: null, flow: null }, grid, 190), null);
});
