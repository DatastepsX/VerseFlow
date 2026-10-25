import assert from "node:assert/strict";
import { test } from "node:test";
import { alignTakeLines, alignmentText, type Alignment } from "./align";

/** a fake alignment: every character 0.1 s, spaces / line breaks included */
function fake(text: string, from = 1): Alignment {
  const characters = [...text].map((c, i) => ({ text: c, start: from + i * 0.1, end: from + (i + 1) * 0.1 }));
  const words: Alignment["words"] = [];
  let at = 0;
  for (const w of text.split(/(\s+)/)) {
    if (w.trim()) words.push({ text: w, start: from + at * 0.1, end: from + (at + w.length) * 0.1, loss: 0.2 });
    at += w.length;
  }
  return { characters, words, loss: 0.2 };
}

const lines = [
  { id: "a", text: "Drink in mano,  sto contando" },
  { id: "b", text: "nella folla siamo due innamorati" },
];

test("each sung syllable gets the time of its first letter, in song time", () => {
  const text = alignmentText(lines);
  assert.equal(text, "Drink in mano, sto contando\nnella folla siamo due innamorati");
  const out = alignTakeLines(lines, fake(text), 10, "it", 0.7);
  assert.equal(out.length, 2);
  // Drink · in · ma · no, · sto · con · tan · do
  assert.equal(out[0].syllables, 8);
  assert.equal(out[0].times[0], 11);
  assert.equal(out[0].times[1], 11.6); // "in": after "Drink" and the space
  // "due innamorati": "due_in" is one sung syllable — it starts at "d"
  assert.equal(out[1].syllables, 11);
  assert.ok(out[1].times.every((t, i) => i === 0 || t > out[1].times[i - 1]));
  assert.equal(out[1].loss, 0.2);
});

test("without character times the words still place the syllables", () => {
  const text = alignmentText(lines);
  const a = fake(text);
  const out = alignTakeLines(lines, { words: a.words }, 0, "it", 0.7);
  assert.equal(out[0].times[0], 1);
  assert.equal(out[0].syllables, 8);
});

test("an alignment that doesn't match the text gives nothing", () => {
  assert.deepEqual(alignTakeLines(lines, { words: [{ text: "x", start: 0, end: 1 }] }, 0, "it", 0.7), []);
});
