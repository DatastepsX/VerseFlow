import assert from "node:assert/strict";
import { test } from "node:test";
import { detectKey } from "./key";
import { FX_PRESETS, layerPreset, noteSeconds } from "./presets";
import { detectPitch, retune, snap } from "./tune";

const SR = 48000;
/** a voice-like tone: a fundamental and a few harmonics, with an attack and release */
function tone(f: number | ((t: number) => number), seconds: number, sr = SR) {
  const n = Math.round(seconds * sr);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const fi = typeof f === "number" ? f : f(t);
    ph += (2 * Math.PI * fi) / sr;
    const env = Math.min(1, t / 0.03, (seconds - t) / 0.03);
    x[i] = 0.4 * env * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.15 * Math.sin(4 * ph));
  }
  return x;
}
const median = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];
const pitchOf = (x: Float32Array) => median([...detectPitch(x, SR).f0].filter((v) => v > 0));

test("pitch: found within a few Hz", () => {
  for (const f of [110, 220, 330, 523]) assert.ok(Math.abs(pitchOf(tone(f, 1)) - f) < f * 0.01, `${f} Hz`);
});

test("autotune: a note between two semitones goes to the nearest; the key decides which notes exist", () => {
  assert.equal(snap(60.4, null), 60);
  assert.equal(snap(61.4, { root: 0, minor: false }), 62, "C♯ is not in C major: D is nearer");
  assert.equal(snap(63.2, { root: 9, minor: true }), 64, "E♭ is not in A minor: E");
  // sung at 224 Hz (a third of a semitone above A3 = 220): hard-tuned to A3; 228 Hz is nearer B♭3 = 233
  const x = tone(224, 1.2);
  const y = retune(x, SR, { key: null, tune: true, speed: 0 });
  assert.equal(y.length, x.length, "same length");
  assert.ok(Math.abs(pitchOf(y) - 220) < 2.5, `tuned to ${pitchOf(y).toFixed(1)} Hz`);
  assert.ok(Math.abs(pitchOf(retune(tone(228, 1.2), SR, { key: null, tune: true, speed: 0 })) - 233.08) < 2.5);
  // a slide from 205 to 245 Hz: hard tune turns it into steps on the semitones
  const slide = retune(
    tone((t) => 205 + 40 * (t / 1.5), 1.5),
    SR,
    { key: null, tune: true, speed: 0 },
  );
  const f0 = [...detectPitch(slide, SR).f0].filter((v) => v > 0);
  const offSemitone = f0.map((f) => Math.abs(69 + 12 * Math.log2(f / 440) - Math.round(69 + 12 * Math.log2(f / 440))));
  assert.ok(median(offSemitone) < 0.12, `on the semitones (median ${median(offSemitone).toFixed(2)})`);
});

test("voice up / down: an octave up doubles the pitch, the length stays", () => {
  const x = tone(200, 1);
  const up = retune(x, SR, { key: null, shift: 12 });
  assert.equal(up.length, x.length);
  assert.ok(Math.abs(pitchOf(up) - 400) < 8, `${pitchOf(up).toFixed(1)} Hz`);
  const down = retune(x, SR, { key: null, shift: -4 });
  assert.ok(Math.abs(pitchOf(down) - 200 * Math.pow(2, -4 / 12)) < 4, `${pitchOf(down).toFixed(1)} Hz`);
  assert.equal(retune(x, SR, { key: null }), x, "nothing to do: the same samples");
});

test("key of a beat: C major chords → C major", () => {
  const sr = 22050;
  const chord = (notes: number[], seconds: number) => {
    const parts = notes.map((m) => tone(440 * Math.pow(2, (m - 69) / 12), seconds, sr));
    return parts[0].map((_, i) => parts.reduce((s, p) => s + p[i], 0) / notes.length);
  };
  // C – F – G – C
  const prog = [chord([48, 60, 64, 67], 2), chord([53, 60, 65, 69], 2), chord([55, 59, 62, 67], 2), chord([48, 60, 64, 67], 2)];
  const x = new Float32Array(prog.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of prog) {
    x.set(p, o);
    o += p.length;
  }
  assert.deepEqual(detectKey(x, sr), { root: 0, minor: false });
});

test("effect presets: unique, raw by default, echoes on the tempo", () => {
  assert.equal(new Set(FX_PRESETS.map((p) => p.id)).size, FX_PRESETS.length);
  assert.equal(layerPreset(undefined, "Lead").id, "raw");
  assert.equal(layerPreset({ Lead: "trap" }, "Lead").name, "Trap autotune");
  assert.equal(noteSeconds("1/4", 120), 0.5);
  assert.equal(noteSeconds("1/8", 120), 0.25);
});
