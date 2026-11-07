import assert from "node:assert/strict";
import { test } from "node:test";
import { lineFlowOfPart, patternFromPart } from "./partflow";
import { lineStarts, linesIn } from "./pattern";
import { prosody } from "@/lib/rhyme/prosody";
import type { LineFlow } from "@/lib/types";

const bar = 2.7;
const sungFlow = (at: number, n: number): LineFlow => ({ syllables: n, stress: [2, n], held: false, words: "", source: "flow", times: Array.from({ length: n }, (_, k) => at + k * 0.18), end: at + n * 0.18, pair: 1 });

test("a part's flow from its lyrics: one line per written line, syllables from the words, where each is sung", () => {
  const texts = ["Il silenzio in questa stanza, ci guardiamo imbarazzati", "E non servono parole per capire cosa sento", "Resto un attimo con te"];
  const ats = [10.2, 13.8, 17.4];
  const lines = texts.map((text, i) => ({ id: `l${i}`, text, audio_at: ats[i], flow: sungFlow(ats[i], 15) }));
  lines.push({ id: "empty", text: "", audio_at: 21, flow: sungFlow(21, 8) });
  const made = patternFromPart(lines, "it", bar, 0, { id: "rap", name: "Rap" })!;
  assert.equal(made.pattern.lines.length, 3, "written lines only");
  assert.deepEqual(made.ids, ["l0", "l1", "l2"]);
  assert.equal(made.pattern.part?.name, "Rap");
  // the edited words decide the syllables
  made.pattern.lines.forEach((l, i) => assert.equal(l.syllables, prosody(texts[i], "it").syllables));
  // each line where it is sung, from the bar the part starts in
  const starts = lineStarts(made.pattern, bar, 3);
  starts.forEach((s, i) => assert.ok(Math.abs(made.start + s - ats[i]) < 0.01, `line ${i + 1} at ${made.start + s}`));
  // a part as long gets as many lines
  assert.equal(linesIn(made.pattern, bar, 17.4 + 3 - made.start), 3);
  // the part's own line: the new syllables, the couplet kept; the same count keeps the sung timing
  const f = lineFlowOfPart(made.pattern, 0, made.start, bar, "flow1", lines[0].flow);
  assert.equal(f.flowId, "flow1");
  assert.equal(f.patternLine, 0);
  assert.equal(f.pair, 1);
  assert.equal(f.syllables, made.pattern.lines[0].syllables);
});

test("a part whose first line is a pickup: the flow starts on the bar it leads into, not a bar earlier", () => {
  // Rap: its first line at 64.7, just before the bar at 64.99 (bars of 2.7036 from 0.11)
  const b = 2.7036;
  const lines = [64.7, 68.3].map((at, i) => ({ id: `r${i}`, text: "Il cappotto sulle gambe, quella pioggia e sigarette", audio_at: at, flow: sungFlow(at, 16) }));
  const made = patternFromPart(lines, "it", b, 0.11, { id: "rap", name: "Rap" })!;
  assert.ok(Math.abs(made.start - 64.99) < 0.01, String(made.start));
  // in another part starting on a bar, its first line comes in the same little bit before it
  assert.ok(made.pattern.lines[0].at! < 0 && made.pattern.lines[0].at! > -0.2);
  assert.ok(Math.abs(124.47 + lineStarts(made.pattern, b, 1)[0] - 124.18) < 0.02);
});

test("a part with nothing written: no flow from it", () => {
  assert.equal(patternFromPart([{ id: "x", text: " ", audio_at: 3, flow: null }], "it", bar, 0, { id: "p", name: "P" }), null);
});
