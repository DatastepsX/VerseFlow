import assert from "node:assert/strict";
import { test } from "node:test";
import { flowGroups } from "./display";

const words = (g: ReturnType<typeof flowGroups>) => g!.map((x) => x.syllables.map((s) => (s.space ? " " : "") + s.text).join("").trim());

test("a line shows its word groups: breaks from the flow, the text's commas — always between words", () => {
  // "Mentre ti guardo ‖ questa notte ‖ io mi sveglio con te": the flow pauses after syllables 5 and 9
  const flow = { syllables: 15, stress: [], held: true, words: "", pauses: [5, 9] };
  const g = flowGroups("Mentre ti guardo questa notte io mi sveglio con te", "it", flow);
  assert.deepEqual(words(g), ["Mentre ti guardo", "questa notte", "io mi sveglio con te"]);
  // the last note is held
  assert.equal(g!.at(-1)!.syllables.at(-1)!.long, true);
  // a pause mapped into a word moves to the word's end
  const inWord = flowGroups("Mentre ti guardo questa notte", "it", { syllables: 9, stress: [], held: false, words: "", pauses: [4] });
  assert.deepEqual(words(inWord), ["Mentre ti guardo", "questa notte"]);
  // no flow: the commas
  assert.deepEqual(words(flowGroups("Prendi il cappotto, ma ancora rimani qui", "it", null)), ["Prendi il cappotto,", "ma ancora rimani qui"]);
});

test("timed syllables: a gap clearly longer than the pace is a break, a beat-long syllable a long note", () => {
  const text = "Dammi quello che c'era";
  // dam-mi-quel-lo-che-c'e-ra: 7 syllables; a gap after "quello", "c'e" held a beat
  const times = [10, 10.2, 10.4, 10.6, 11.3, 11.5, 12.3];
  const g = flowGroups(text, "it", { syllables: 7, stress: [], held: false, words: "", times }, 0.7);
  assert.deepEqual(words(g), ["Dammi quello", "che c'era"]);
  assert.equal(g![1].syllables.find((s) => s.text === "c'e")?.long, true);
});
