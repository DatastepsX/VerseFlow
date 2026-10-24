import assert from "node:assert/strict";
import { test } from "node:test";
import { flowLines, stressPattern } from "./lines";
import { detectSyllables } from "./syllables";
import { dropSounds, isSound } from "./fillers";
import { cycle, flowFromGrid, gridFor, quantizeTaps } from "./grid";
import { exampleWords } from "./example";
import { coupletsOf } from "./couplets";
import { barsPerLine, chipsOf, lineFlowFrom, lineFromText, linesFromOnsets, nextFlowName, relayout } from "./pattern";
import { prosody } from "@/lib/rhyme/prosody";
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

test("flow grid: sung syllables snap to 16th notes, edits become the line's flow", () => {
  // 120 bpm: beat 0.5 s, step 0.125 s; bar 1 from 0.5 s
  const grid = { bpm: 120, beat_offset: 0.5, beats_per_bar: 4 };
  const flow = { syllables: 5, stress: [1, 4], held: true, words: "", source: "flow" as const, times: [1.01, 1.26, 1.37, 1.5, 1.98], end: 2.4 };
  const g = gridFor(flow, 1.01, grid)!;
  assert.equal(g.start, 1, "starts on the beat the singing starts on");
  assert.equal(g.cells.length, 16);
  assert.deepEqual(
    g.cells.map((c, i) => (c ? `${i}:${c}` : "")).filter(Boolean),
    ["0:2", "2:1", "3:1", "4:2", "8:1"],
  );
  // tap: a new syllable on step 6, the one on step 3 removed, step 8 stressed
  g.cells[6] = 1;
  g.cells[3] = 0;
  g.cells[8] = cycle(g.cells[8]);
  const f = flowFromGrid(g, flow);
  assert.equal(f.syllables, 5);
  assert.deepEqual(f.times, [1, 1.25, 1.5, 1.75, 2]);
  assert.deepEqual(f.stress, [1, 3, 5]);
  assert.ok(f.held);
  // an empty line: drawn from scratch where it starts
  const empty = gridFor(null, 3.2, grid)!;
  assert.equal(empty.start, 3);
  assert.ok(empty.cells.every((c) => c === 0));
});

test("example words: exactly the tapped syllables, stressed words on the stressed taps", () => {
  for (const lang of ["it", "en", "es", "de"]) {
    for (const [n, stress] of [
      [7, [2, 5, 7]],
      [10, [1, 4, 8]],
      [4, [1, 3]],
      [12, [2, 6, 10, 12]],
    ] as [number, number[]][]) {
      const line = exampleWords(n, stress, lang, n);
      assert.equal(prosody(line, lang).syllables, n, `${lang}: “${line}” should have ${n} syllables`);
    }
  }
  const it = exampleWords(7, [2, 4, 7], "it");
  assert.ok(it.length > 5, it);
  assert.notEqual(exampleWords(8, [1, 5], "it", 1), exampleWords(8, [1, 5], "it", 2), "other examples for another seed");
});

test("taps: snapped to 16ths, none lost, a tap on a beat is stressed; pauses break the lines", () => {
  const grid = { bpm: 120, beat_offset: 0.5, beats_per_bar: 4 }; // 16th = 0.125 s
  const q = quantizeTaps([0.52, 0.61, 0.66, 1.01, 1.24], grid);
  assert.deepEqual(
    q.map((x) => [x.t, x.onBeat]),
    [
      [0.5, true],
      [0.625, false],
      [0.75, false], // would snap to 0.625 too: moved on
      [1, true],
      [1.25, false],
    ],
  );
  // two phrases of 6 taps with a pause: two lines
  const taps = [0, 1].flatMap((p) => [0, 0.25, 0.375, 0.5, 0.75, 1].map((t) => 1 + p * 2 + t));
  const syl = quantizeTaps(taps, grid).map((x, i, a) => ({ t: x.t, strength: x.onBeat ? 1 : 0.5, dur: Math.min(0.15, (a[i + 1]?.t ?? x.t + 0.3) - x.t) }));
  const lines = flowLines(syl, [], grid, { lang: "it", duration: 6 });
  assert.deepEqual(
    lines.map((l) => l.syllables),
    [6, 6],
  );
});

test("taps with 'next line': the writer's marks break the lines, not the pauses", () => {
  const grid = { bpm: 120, beat_offset: 0.5, beats_per_bar: 4 };
  // 10 taps in one go (no pause) — "next line" after the 4th and after the 7th
  const taps = Array.from({ length: 10 }, (_, i) => 1 + i * 0.25);
  const syl = quantizeTaps(taps, grid).map((x, i, a) => ({ t: x.t, strength: x.onBeat ? 1 : 0.5, dur: Math.min(0.15, (a[i + 1]?.t ?? x.t + 0.3) - x.t) }));
  const lines = flowLines(syl, [], grid, { lang: "it", duration: 6, breaks: [4, 7] });
  assert.deepEqual(
    lines.map((l) => l.syllables),
    [4, 3, 3],
  );
  assert.equal(lines[1].start, 2);
});

test("sounds: an Italian “po'” (un po') is a word, not a sung sound", () => {
  const w = (text: string, i: number) => ({ text, start: i, end: i + 0.2 });
  const line = "suoni risposta tarda un po'.".split(" ").map(w);
  assert.equal(dropSounds(line).length, 5);
});

test("couplets: as sung, and every line left over paired with the next", () => {
  const L = (pair?: 0 | 1 | 2) => ({ id: String(Math.random()), flow: pair === undefined ? null : { syllables: 8, stress: [], held: false, words: "", pair } });
  const lines = [L(0), L(0), L(1), L(2), L(0), L(0), L(0)];
  const c = coupletsOf(lines).map(([a, b]) => [lines.indexOf(a), lines.indexOf(b)]);
  assert.deepEqual(c, [
    [0, 1],
    [2, 3],
    [4, 5],
  ]);
  // no flow at all: 1+2, 3+4
  const plain = [L(), L(), L(), L()];
  assert.deepEqual(
    coupletsOf(plain).map(([a, b]) => [plain.indexOf(a), plain.indexOf(b)]),
    [
      [0, 1],
      [2, 3],
    ],
  );
});

test("flow patterns: written lines → chips and timing; sung/tapped bars → lines; repeated over a part", () => {
  const bar = 2; // 120 bpm
  // written: "Ti scrivo dentro me" — 6 syllables, natural stresses, the last one long
  const w = lineFromText("Ti scrivo dentro me", "it", bar);
  assert.deepEqual(chipsOf("Ti scrivo dentro me", "it"), ["Ti", "scri", "vo", "den", "tro", "me"]);
  assert.equal(w.syllables, 6);
  assert.deepEqual(w.stress, [2, 4, 6]);
  assert.deepEqual(w.offsets, [0, 0.25, 0.5, 0.75, 1, 1.25]); // 8th notes
  // a long syllable and a pause move what follows
  const shaped = relayout({ ...w, long: [2, 6], pauses: [3] }, bar);
  assert.deepEqual(shaped.offsets, [0, 0.25, 0.75, 1.25, 1.5, 1.75]);
  // editing the words with the same count keeps what was set
  assert.deepEqual(lineFromText("Ti canto dentro me", "it", bar, shaped).offsets, shaped.offsets);
  // tapped: 2 bars from 10 s
  const onsets = [10, 10.5, 10.75, 11, 12, 12.25, 12.5].map((t) => ({ t }));
  const lines = linesFromOnsets(onsets, 10, bar, 2, "it");
  assert.deepEqual(
    lines.map((l) => l.syllables),
    [4, 3],
  );
  assert.deepEqual(lines[0].stress, [1, 2, 4]);
  assert.equal(prosody(lines[0].text, "it").syllables, 4, "example words of the same length");
  // applied: line 3 follows pattern line 1, a couplet again
  const pattern = { lines: [w, shaped], scheme: "AABB" as const, bar, source: "write" as const };
  const f = lineFlowFrom(pattern, 2, 20, bar, "flow-1");
  assert.deepEqual([f.patternLine, f.pair, f.syllables, f.times?.[1]], [0, 1, 6, 20.25]);
  assert.equal(barsPerLine(pattern), 1);
  assert.equal(nextFlowName(["Flow A", "Flow B"]), "Flow C");
});

test("ABAB: lines 1+3 and 2+4 rhyme", () => {
  const L = (k: number) => ({ id: `l${k}`, flow: { syllables: 8, stress: [], held: false, words: "", flowId: "f", patternLine: k % 4, scheme: "ABAB" as const } });
  const lines = [0, 1, 2, 3, 4, 5, 6, 7].map(L);
  assert.deepEqual(
    coupletsOf(lines).map(([a, b]) => `${a.id}+${b.id}`),
    ["l0+l2", "l1+l3", "l4+l6", "l5+l7"],
  );
});
