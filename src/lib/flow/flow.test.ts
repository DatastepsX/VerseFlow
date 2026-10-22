import assert from "node:assert/strict";
import { test } from "node:test";
import { flowLines, stressPattern } from "./lines";
import { detectSyllables } from "./syllables";
import { vocalLines } from "./vocals";

const SR = 16000;

/** a synthetic voice: vowel bursts (a harmonic tone with an attack/decay) at given times */
function voice(events: { t: number; dur: number; amp: number }[], length: number) {
  const x = new Float32Array(Math.ceil(length * SR));
  let seed = 3;
  for (let i = 0; i < x.length; i++) x[i] = (((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1) * 0.002; // room noise
  for (const e of events) {
    const s0 = Math.floor(e.t * SR);
    const n = Math.floor(e.dur * SR);
    for (let i = 0; i < n && s0 + i < x.length; i++) {
      const env = Math.min(1, i / (0.015 * SR)) * Math.min(1, (n - i) / (0.03 * SR));
      const ph = (2 * Math.PI * 180 * i) / SR;
      x[s0 + i] += e.amp * env * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph));
    }
  }
  return x;
}

test("syllables of a flow are found with their stress and held notes", () => {
  // 8 syllables, every 0.2 s, loud on 2, 5, 8; the last one held
  const ev = Array.from({ length: 8 }, (_, i) => ({ t: 0.5 + i * 0.2, dur: i === 7 ? 0.6 : 0.13, amp: [1, 4, 7].includes(i) ? 0.5 : 0.25 }));
  const syl = detectSyllables(voice(ev, 3), SR);
  assert.equal(syl.length, 8, JSON.stringify(syl));
  syl.forEach((s, i) => assert.ok(Math.abs(s.t - ev[i].t) < 0.06, `syllable ${i} at ${s.t}`));
  assert.deepEqual(
    syl.map((s, i) => (s.strength >= 0.8 ? i + 1 : 0)).filter(Boolean),
    [2, 5, 8],
  );
  assert.ok(syl[7].dur >= 0.35 && syl[0].dur < 0.3);
});

test("flow lines follow the bars and take over the recognised words", () => {
  const grid = { bpm: 120, beat_offset: 0, beats_per_bar: 4 }; // 2 s bars
  const syl = [
    ...[0.1, 0.35, 0.6, 0.85, 1.1, 1.35].map((t, i) => ({ t, strength: i % 3 === 1 ? 1 : 0.5, dur: 0.15 })),
    // bar 2 starts with a pickup just before the bar line
    ...[1.9, 2.2, 2.5, 2.8, 3.1].map((t, i) => ({ t, strength: i === 4 ? 1 : 0.6, dur: i === 4 ? 0.5 : 0.15 })),
  ];
  const words = [
    { text: "amore", start: 0.1, end: 0.7 },
    { text: "mio", start: 0.8, end: 1.2 },
  ];
  const lines = flowLines(syl, words, grid, { lang: "it", duration: 6 });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].words, "amore mio");
  assert.equal(lines[0].start, 0);
  assert.equal(lines[1].start, 2);
  assert.equal(lines[1].syllables, 5); // the pickup at 1.9 s belongs to bar 2
  assert.ok(lines[1].held);
  assert.equal(stressPattern({ syllables: 4, stress: [2, 4], held: true }), "da-DUM-da-DUM~");
});

test("vocals in the song: one line per bar with the sung words, their syllables and stresses", () => {
  // 120 bpm, bar = 2 s, bar 1 at 0.5 s: "cammino da solo" in bar 1, "nella notte scura" in bar 2, bar 3 empty
  const w = (text: string, start: number, end: number) => ({ text, start, end });
  const words = [w("cammino", 0.5, 1.0), w("da", 1.0, 1.15), w("solo", 1.2, 1.9), w("nella", 2.5, 2.8), w("notte", 2.8, 3.2), w("scura", 3.3, 4.2)];
  const lines = vocalLines(words, { bpm: 120, beat_offset: 0.5, beats_per_bar: 4 }, { lang: "it", duration: 8 });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].words, "cammino da solo");
  assert.equal(lines[0].syllables, 6);
  assert.deepEqual(lines[0].stress, [2, 5]);
  assert.equal(lines[1].words, "nella notte scura");
  assert.equal(lines[1].start, 2.5);
  assert.ok(lines[1].held, "the last word is held");
});
