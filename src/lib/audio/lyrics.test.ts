import assert from "node:assert/strict";
import { test } from "node:test";
import { barLines, cleanWords, detectBlocks, planLyrics, similarity, type TimedWord } from "./lyrics";

const grid = { bpm: 120, beat_offset: 0, beats_per_bar: 4, duration: 76 }; // 2 s per bar, 38 bars

/** words of `text` sung across one bar starting at bar index `bar` */
function bar(bar: number, text: string): TimedWord[] {
  const ws = text.split(" ");
  return ws.map((w, i) => ({ text: w, start: bar * 2 + (i * 1.8) / ws.length, end: bar * 2 + ((i + 1) * 1.8) / ws.length }));
}
const verse = (from: number, tag: string) =>
  Array.from({ length: 8 }, (_, i) => bar(from + i, `${tag} riga numero ${i} parole diverse ${tag}${i}`)).flat();
const chorus = (from: number) =>
  [
    "tu non ci sei più nella mia vita",
    "e questa notte sembra infinita",
    "ti chiamo ancora ma non rispondi",
    "e tutti i giorni sono più profondi",
  ].flatMap((t, i) => bar(from + i, t));

// intro 0-3 | verse 4-11 | chorus 12-15 | verse 16-23 | chorus 24-27 | outro 28-37
const words = [...verse(4, "alfa"), ...chorus(12), ...verse(16, "beta"), ...chorus(24)];

test("cleanWords keeps timed words only", () => {
  const w = cleanWords([
    { text: "ciao", start: 0, end: 0.3, type: "word" },
    { text: " ", start: 0.3, end: 0.31, type: "spacing" },
    { text: "(music)", start: 1, end: 2, type: "audio_event" },
  ]);
  assert.deepEqual(w.map((x) => x.text), ["ciao"]);
});

test("one line per bar, pickups belong to the next bar", () => {
  const ls = barLines([...bar(0, "uno due"), { text: "pick", start: 3.95, end: 4.0 }, ...bar(2, "tre quattro")], { ...grid });
  assert.deepEqual(ls, ["uno due", "", "pick tre quattro"]);
});

test("similarity", () => {
  assert.ok(similarity("tu non ci sei più nella mia vita", "Tu non ci sei più, nella mia vita!") > 0.9);
  assert.ok(similarity("tu non ci sei", "e questa notte") < 0.2);
});

test("detects intro, verses, chorus and outro", () => {
  const lines = barLines(words, grid);
  const blocks = detectBlocks(lines, 38);
  assert.deepEqual(
    blocks.map((b) => `${b.kind}:${b.startBar}-${b.endBar}`),
    ["intro:0-4", "verse:4-12", "chorus:12-16", "verse:16-24", "chorus:24-28", "outro:28-38"],
  );
});

test("plan with auto sections names them and aligns lines to bars", () => {
  const plan = planLyrics({
    words,
    grid,
    projectType: "rap",
    autoSections: true,
    sections: [{ id: "empty", name: "Part I", audio_start: null, bars_per_line: 1, lines: [] }],
  });
  assert.deepEqual(plan.sections.map((s) => s.name), ["Intro", "Rap 1", "Hook", "Rap 2", "Hook", "Outro"]);
  assert.deepEqual(plan.removeSectionIds, ["empty"]);
  const hook = plan.sections[2];
  assert.equal(hook.start, 24);
  assert.equal(hook.lines.length, 4);
  assert.equal(hook.lines[0].text, "tu non ci sei più nella mia vita");
  assert.equal(plan.unplaced, 0);
});

test("filling keeps written lines and only fills free bars", () => {
  const plan = planLyrics({
    words,
    grid,
    projectType: "rap",
    autoSections: true,
    sections: [
      { id: "v1", name: "Strofa", audio_start: 12, bars_per_line: 1, lines: [{ text: "la mia riga" }, { text: "" }] },
      { id: "h", name: "Ritornello", audio_start: 24, bars_per_line: 1, lines: [] },
      { id: "x", name: "Unanchored", audio_start: null, bars_per_line: 1, lines: [] },
    ],
  });
  // anchored sections are used as they are; nothing is created or removed
  assert.deepEqual(plan.sections.map((s) => s.id), ["v1", "h"]);
  assert.deepEqual(plan.removeSectionIds, []);
  const v1 = plan.sections[0];
  assert.deepEqual(v1.lines[0], { index: 0, text: "la mia riga", action: "keep" });
  assert.equal(v1.lines[1].action, "fill");
  assert.equal(v1.lines[2].action, "add");
  // words before the first anchor (bars 4-5 of verse 1) are not placed
  assert.ok(plan.unplaced > 0);
});

test("two bars per line", () => {
  const plan = planLyrics({
    words: chorus(12),
    grid,
    projectType: "song",
    autoSections: false,
    sections: [{ id: "c", name: "Chorus", audio_start: 24, bars_per_line: 2, lines: [] }],
  });
  assert.equal(plan.sections[0].lines.length, 2);
  assert.equal(plan.sections[0].lines[0].text, "tu non ci sei più nella mia vita e questa notte sembra infinita");
});

test("a short instrumental gap ends the previous section, a long one is a break", () => {
  const ws = [...chorus(2), ...chorus(8), ...verse(18, "gamma")];
  // chorus 2-5 | gap 6-7 | chorus 8-11 | gap 12-17 | verse 18-25
  const blocks = detectBlocks(barLines(ws, grid), 26);
  assert.deepEqual(
    blocks.map((b) => `${b.kind}:${b.startBar}-${b.endBar}`),
    ["intro:0-2", "chorus:2-8", "chorus:8-12", "break:12-18", "verse:18-26"],
  );
});
