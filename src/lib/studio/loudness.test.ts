import assert from "node:assert/strict";
import { test } from "node:test";
import { levelGain, loudnessDb, TAKE_MAX, VOICE_TARGET_DB } from "./mix";

const sr = 8000;
/** a tone of amplitude a for `on` seconds, then silence for `off` (a line, then a pause) — repeated */
function voice(a: number, on: number, off: number, times: number) {
  const out: number[] = [];
  for (let r = 0; r < times; r++) {
    for (let i = 0; i < on * sr; i++) out.push(a * Math.sin((2 * Math.PI * 220 * i) / sr));
    for (let i = 0; i < off * sr; i++) out.push(0);
  }
  return Float32Array.from(out);
}

test("a take's loudness: the sung parts only — the pauses between lines don't make it quieter", () => {
  const a = 0.1; // a tone at 0.1: −23 dB RMS
  const sung = loudnessDb(voice(a, 3, 0, 4), sr)!;
  assert.ok(Math.abs(sung - 20 * Math.log10(a / Math.SQRT2)) < 0.3, String(sung));
  const withPauses = loudnessDb(voice(a, 3, 2, 4), sr)!;
  assert.ok(Math.abs(withPauses - sung) < 1, `${withPauses} vs ${sung}`);
  assert.equal(loudnessDb(new Float32Array(sr * 2), sr), null);
});

test("the level gain brings a quiet take to the voice's loudness, within limits", () => {
  const quiet = voice(0.05, 3, 1, 4);
  const g = levelGain(quiet, sr)!;
  const after = loudnessDb(quiet.map((v) => v * g), sr)!;
  assert.ok(Math.abs(after - VOICE_TARGET_DB) < 0.3, String(after));
  assert.equal(levelGain(voice(0.003, 3, 1, 2), sr), TAKE_MAX);
  assert.ok(levelGain(voice(0.9, 3, 1, 2), sr)! < 1);
});
