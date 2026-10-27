import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNotation, slotsWithMarks, syllableWords, toNotation } from "./notation";
import { syllableParts } from "@/lib/rhyme/syllabify";

test("typed symbols become marks, the text stays clean", () => {
  const r = parseNotation("Domattina forse piango - non_voglio_esagerare.");
  assert.equal(r.text, "Domattina forse piango - non voglio esagerare.");
  assert.deepEqual(r.marks, [{ kind: "double", at: 4, to: 6 }]);

  const b = parseNotation("Sorrido storto, / ma sembra un paradiso~ //");
  assert.equal(b.text, "Sorrido storto, ma sembra un paradiso");
  assert.deepEqual(b.marks, [
    { kind: "pause", at: 1 },
    { kind: "stretch", at: 5 },
    { kind: "rest", at: 5 },
  ]);

  const c = parseNotation("Frate'|| stasera^ si brinda 24/7");
  assert.equal(c.text, "Frate' stasera si brinda 24/7");
  assert.deepEqual(c.marks, [
    { kind: "rest", at: 0 },
    { kind: "breath", at: 1 },
  ]);
});

test("marks back to symbols, and round again", () => {
  for (const typed of ["Domattina forse piango - non_voglio_esagerare.", "Sorrido storto, / ma sembra un paradiso~ //", "Frate' // stasera^ si brinda", "dico/_ciao_a~_te"]) {
    const r = parseNotation(typed);
    const back = toNotation(r.text, r.marks);
    assert.deepEqual(parseNotation(back), r, typed + " → " + back);
  }
});

test("syllables know their words (a merged syllable covers two)", () => {
  const parts = syllableParts("la notte io ci sono", "it")!;
  const w = syllableWords(parts);
  assert.deepEqual(w[2], { start: 1, end: 2 }); // "te i"
  assert.deepEqual(w.at(-1), { start: 4, end: 4 });
});

test("Hear: double-time is faster, a break leaves a gap, the line keeps its stretch", () => {
  const { text, marks } = parseNotation("vado / via_da_qui");
  const n = syllableParts(text, "it")!.length; // va do via da qui
  const times = Array.from({ length: n }, (_, i) => 10 + i * 0.3);
  const r = slotsWithMarks({ times, end: 10 + n * 0.3 }, text, "it", marks)!;
  assert.equal(r.slots.times.length, n);
  assert.equal(r.slots.times[0], 10);
  const d = r.slots.times.slice(1).map((x, i) => x - r.slots.times[i]);
  // the gap after "vado" is longer than the double-time syllables after it
  assert.ok(d[1] > 2 * d[2], JSON.stringify(d));
  assert.ok(Math.abs(d[2] - d[3]) < 1e-9);
  assert.equal(r.slots.end, 10 + n * 0.3);
});
