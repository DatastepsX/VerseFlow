import assert from "node:assert/strict";
import { test } from "node:test";
import { flowLines, stressPattern } from "./lines";
import { detectSyllables } from "./syllables";
import { dropSounds, isSound } from "./fillers";
import { emptyParts, vocalLines } from "./vocals";

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

test("flow lines follow the sung phrases and take over the recognised words", () => {
  const grid = { bpm: 120, beat_offset: 0, beats_per_bar: 4 }; // 2 s bars
  const syl = [
    ...[0.1, 0.35, 0.6, 0.85, 1.1, 1.35].map((t, i) => ({ t, strength: i % 3 === 1 ? 1 : 0.5, dur: 0.15 })),
    // a pause, then the next phrase (a pickup just before bar 2)
    ...[1.9, 2.2, 2.5, 2.8, 3.1].map((t, i) => ({ t, strength: i === 4 ? 1 : 0.6, dur: i === 4 ? 0.5 : 0.15 })),
  ];
  const words = [
    { text: "amore", start: 0.1, end: 0.7 },
    { text: "mio", start: 0.8, end: 1.2 },
  ];
  const lines = flowLines(syl, words, grid, { lang: "it", duration: 6 });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].words, "amore mio");
  assert.equal(lines[0].start, 0.1);
  assert.equal(lines[1].start, 1.9);
  assert.equal(lines[1].syllables, 5); // the pickup at 1.9 s starts the 2nd phrase
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

test("a line ends on its rhyme: the couplet's last words close the lines, not the bar lines", () => {
  // sung in one breath, starting mid-bar (120 bpm, bar = 2 s from 0.5 s)
  const text =
    "Cammino adesso sempre e aspetto io la notte il giorno che sta bene io mi sento un po più forte " +
    "ma quando torna il vento la strada mi confonde e cerco le parole come sabbia tra le onde";
  let t = 1.3;
  const words = text.split(" ").map((w) => {
    const d = 0.08 + w.length * 0.03;
    const x = { text: w, start: t, end: t + d };
    t += d + 0.03;
    return x;
  });
  const lines = vocalLines(words, { bpm: 120, beat_offset: 0.5, beats_per_bar: 4 }, { lang: "it", duration: 30 });
  assert.deepEqual(
    lines.map((l) => l.words),
    [
      "Cammino adesso sempre e aspetto io la notte",
      "il giorno che sta bene io mi sento un po più forte",
      "ma quando torna il vento la strada mi confonde",
      "e cerco le parole come sabbia tra le onde",
    ],
  );
  assert.equal(lines[1].start, words[8].start, "the 2nd line starts right after “notte”");
});

test("the couplets are marked, so suggestions rhyme with the right line", () => {
  const w = (text: string, start: number, end: number) => ({ text, start, end });
  // "…la notte / …più forte" rhyme, then a line on its own after a long break
  const words = [
    ...["cammino", "adesso", "e", "aspetto", "la", "notte"].map((x, i) => w(x, 0.5 + i * 0.3, 0.75 + i * 0.3)),
    ...["mi", "sento", "un", "po", "più", "forte"].map((x, i) => w(x, 2.5 + i * 0.3, 2.75 + i * 0.3)),
    ...["e", "poi", "domani", "parto", "via"].map((x, i) => w(x, 8 + i * 0.3, 8.25 + i * 0.3)),
  ];
  const lines = vocalLines(words, { bpm: 120, beat_offset: 0.5, beats_per_bar: 4 }, { lang: "it", duration: 12 });
  assert.deepEqual(
    lines.map((l) => [l.words, l.pair]),
    [
      ["cammino adesso e aspetto la notte", 1],
      ["mi sento un po più forte", 2],
      ["e poi domani parto via", 0],
    ],
  );
});

test("the singer's pauses and punctuation break the lines (La Strada, real recognition)", () => {
  const raw: [string, number, number][] = [["E", 30.08, 30.16], ["se", 30.26, 30.44], ["la", 30.50, 30.62], ["strada", 30.66, 31.28], ["ci", 31.40, 31.74], ["divide,", 31.82, 32.66], ["suoni", 33.66, 34.10], ["risposta", 34.16, 34.96], ["tarda", 35.10, 35.60], ["un", 35.60, 35.74], ["po'.", 35.82, 36.08], ["Qualcosa", 37.36, 37.98], ["muove", 38.04, 38.50], ["ancora", 38.50, 39.26], ["il", 39.28, 39.36], ["mondo", 39.46, 39.92], ["quando", 40.32, 40.64], ["penso", 40.78, 41.06], ["a", 41.10, 41.18], ["noi", 41.26, 41.44], ["due.", 41.52, 42.36]];
  const words = raw.map(([text, start, end]) => ({ text, start, end }));
  const lines = vocalLines(words, { bpm: 87.817, beat_offset: 0.757, beats_per_bar: 4 }, { lang: "it", duration: 60 });
  assert.deepEqual(
    lines.map((l) => l.words),
    ["E se la strada ci divide,", "suoni risposta tarda un po'.", "Qualcosa muove ancora il mondo", "quando penso a noi due."],
  );
});

test("parts without vocals become empty parts to write later", () => {
  // 120 bpm (bar 2 s from 0.5): lines every bar from 0.5 to 8.5, silence until 30.5, then 2 more lines; song 40 s
  const mk = (start: number) => ({ start, sungAt: start, end: start + 1.6, syllables: 8, stress: [2, 6], held: false, words: "x", times: [] });
  const lines = [0.5, 2.5, 4.5, 6.5, 8.5, 30.5, 32.5].map(mk);
  const parts = emptyParts(lines, { bpm: 120, beat_offset: 0.5, beats_per_bar: 4 }, 40);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].start, 12.5, "on the first bar line after the singing (+ half a bar)");
  assert.equal(parts[0].slots.length, 8, "one line per bar, an even number");
  assert.deepEqual(parts[0].slots.slice(0, 2), [12.5, 14.5]);
});

test("na-na flows: the pauses break the lines, not the bars (“Pam Pam Pa-ra Pa-Pa-Pam” twice per bar)", () => {
  // 88 bpm: bar ≈ 2.73 s; the phrase (7 syllables, ~1.3 s) twice per bar with a ~0.45 s pause, the last one held
  const phrase = [0, 0.22, 0.42, 0.6, 0.78, 0.92, 1.05];
  const ev = [0.4, 2.2, 4.0, 5.8].flatMap((at) =>
    phrase.map((t, i) => ({ t: at + t, dur: i === 6 ? 0.3 : 0.1, amp: [0, 1, 2, 6].includes(i) ? 0.5 : 0.25 })),
  );
  const syl = detectSyllables(voice(ev, 7.8), SR);
  assert.equal(syl.length, 28, JSON.stringify(syl.map((s) => s.t)));
  const lines = flowLines(syl, [], { bpm: 88, beat_offset: 0.4, beats_per_bar: 4 }, { lang: "it", duration: 7.8 });
  assert.deepEqual(
    lines.map((l) => l.syllables),
    [7, 7, 7, 7],
  );
  assert.ok(Math.abs(lines[1].start - 2.2) < 0.06);
  assert.deepEqual(lines[0].stress, [1, 2, 3, 7]);
});

test("sung sounds (pom pom para…) are not lyrics", () => {
  const w = (text: string, start = 0) => ({ text, start, end: start + 0.2 });
  const take = "Pom pom para pa pa pom. Pom pom, pom pom pa pa pa pom.".split(" ").map((t, i) => w(t, i * 0.25));
  assert.deepEqual(dropSounds(take), []);
  // real words with a few sounds in between: the words stay, the sounds go
  const mixed = "Lo so quando parti tu yeah nanana la notte".split(" ").map((t, i) => w(t, i * 0.25));
  assert.deepEqual(
    dropSounds(mixed).map((x) => x.text),
    ["Lo", "so", "quando", "parti", "tu", "la", "notte"],
  );
  assert.ok(isSound("Pom.") && isSound("papapa") && isSound("Yeah,") && !isSound("parti") && !isSound("notte"));
});
