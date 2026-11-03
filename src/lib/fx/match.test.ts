import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPreset, matchSound, nameOf } from "./match";

const SR = 16000;
/** a sung-like voice: phrases of syllables (harmonics, an attack, a decay), the pitch drifting naturally — or sitting right on notes */
function voice(seconds: number, opts: { tuned?: boolean; seed?: number } = {}) {
  const x = new Float32Array(Math.round(seconds * SR));
  let seed = opts.seed ?? 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const notes = [57, 59, 60, 62, 64];
  let phase = 0;
  for (let t0 = 0.3; t0 < seconds - 1.6; t0 += 2.1) {
    // a phrase: 6 syllables in 1.2 s
    for (let s = 0; s < 6; s++) {
      const a = Math.round((t0 + s * 0.2) * SR);
      const midi = notes[Math.floor(rnd() * notes.length)];
      const drift = opts.tuned ? 0 : (rnd() - 0.5) * 0.9;
      for (let i = 0; i < 0.19 * SR && a + i < x.length; i++) {
        const vib = opts.tuned ? 0 : 0.35 * Math.sin((2 * Math.PI * 5.5 * i) / SR);
        const f = 440 * 2 ** ((midi + drift + vib - 69) / 12);
        phase += (2 * Math.PI * f) / SR;
        const env = Math.min(1, i / (0.015 * SR)) * Math.exp(-i / (0.25 * SR)) * (0.6 + 0.4 * rnd() * 0 + (s % 3 === 0 ? 0.4 : 0));
        x[a + i] += 0.3 * env * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase) + 0.15 * Math.sin(5 * phase));
      }
    }
  }
  return x;
}
/** reverb: four feedback combs ringing for `rt60` s, mixed in */
function reverb(x: Float32Array, rt60: number, mix: number) {
  const wet = new Float32Array(x.length);
  for (const ms of [29.7, 37.1, 41.1, 43.7]) {
    const d = Math.round((ms / 1000) * SR);
    const g = 10 ** ((-3 * d) / (rt60 * SR));
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] + (i >= d ? g * y[i - d] : 0);
    for (let i = 0; i < x.length; i++) wet[i] += y[i] / 4;
  }
  return x.map((v, i) => (1 - mix) * v + mix * wet[i] * 0.5);
}
/** echoes `lag` s later, `g` softer each time */
const echo = (x: Float32Array, lag: number, g: number) => {
  const d = Math.round(lag * SR);
  const y = Float32Array.from(x);
  for (let i = d; i < x.length; i++) y[i] += g * y[i - d];
  return y;
};
/** brighter: more of the high end (the signal's slope added) */
const bright = (x: Float32Array) => x.map((v, i) => v + 2.5 * (v - (x[i - 1] ?? 0)));

test("a dry, natural voice: nothing invented", () => {
  const m = matchSound([voice(16)], SR, { bpm: 90 });
  assert.equal(m.preset.reverb, undefined, m.found.join(" / "));
  assert.equal(m.preset.delay, undefined, m.found.join(" / "));
  assert.equal(m.preset.tune, undefined, m.found.join(" / "));
});

test("a long reverb is heard", () => {
  const m = matchSound([reverb(voice(16), 2.2, 0.45)], SR, { dry: voice(16), bpm: 90 });
  assert.ok(m.preset.reverb, m.found.join(" / "));
  assert.ok(m.preset.reverb!.seconds >= 1 && m.preset.reverb!.seconds <= 4, m.found.join(" / "));
  assert.match(m.preset.name, /plate|hall/);
  assert.equal(m.preset.delay, undefined, `reverb is not an echo: ${m.found.join(" / ")}`);
});

test("an echo on the 1/8 note at 90 BPM", () => {
  const m = matchSound([echo(voice(18), 60 / 90 / 2, 0.45)], SR, { dry: voice(18), bpm: 90 });
  assert.equal(m.preset.delay?.note, "1/8", m.found.join(" / "));
});

test("reverb and an echo together (the echo doesn't hide the reverb)", () => {
  const dry = voice(20, { seed: 3 });
  const wet = echo(reverb(dry, 2.2, 0.4), 60 / 87.8 / 2, 0.4);
  const m = matchSound([wet], SR, { dry, bpm: 87.8 });
  assert.ok(m.preset.reverb, m.found.join(" / "));
  assert.equal(m.preset.delay?.note, "1/8", m.found.join(" / "));
});

test("an autotuned voice sits on the notes", () => {
  const m = matchSound([voice(16, { tuned: true })], SR, { bpm: 90 });
  assert.ok(m.preset.tune, m.found.join(" / "));
  assert.match(m.preset.name, /tun/);
});

test("a brighter voice than your take: presence and air up", () => {
  const dry = voice(16);
  const m = matchSound([bright(dry)], SR, { dry, bpm: 90 });
  const up = (m.preset.eq ?? []).filter((b) => b.f >= 3000 && b.gain > 0);
  assert.ok(up.length >= 1, m.found.join(" / "));
});

test("names, and presets from outside made safe", () => {
  assert.equal(nameOf({ id: "x", name: "", about: "", category: "Clean", reverb: { seconds: 3, mix: 0.3 }, tune: { speed: 0 } }), "Clean hall · tuned");
  assert.equal(cleanPreset({ id: "bad id!", name: "x" }), null);
  const p = cleanPreset({ id: "my-1", name: "Mine", category: "Space", reverb: { seconds: 99, mix: 3 }, eq: [{ type: "peaking", f: 3000, gain: 40 }], evil: "<script>" });
  assert.equal(p?.reverb?.seconds, 8);
  assert.equal(p?.reverb?.mix, 1);
  assert.equal(p?.eq?.[0].gain, 18);
  assert.equal((p as unknown as Record<string, unknown>).evil, undefined);
});
