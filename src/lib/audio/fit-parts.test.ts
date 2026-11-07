import assert from "node:assert/strict";
import { test } from "node:test";
import { fitPartStarts } from "./fit-parts";
import type { LineFlow } from "@/lib/types";

const audio = { bpm: 88.774, beat_offset: 0.11, beats_per_bar: 4, changes: [{ t: 121.767, s: 0.66 }, { t: 135.285, s: 0.87 }] };
const sung = (at: number, times: number[], end: number) => ({ kind: "lyric" as const, text: "ci riconosce.", audio_at: at, flow: { syllables: times.length, stress: [], held: true, words: "", source: "vocals", times, end } as LineFlow });
const written = (at: number) => ({ kind: "lyric" as const, text: "Le finestre ancora chiuse", audio_at: at, flow: { syllables: 8, stress: [], held: false, words: "", source: "flow" } as LineFlow });

test("the beat after the last sung word goes to the instrumental part: it starts on the next bar line", () => {
  const parts = [
    { id: "chorus", audio_start: 92.7, lines: [sung(118.88, [118.88, 119.57], 119.84), sung(120.04, [120.04, 121.28, 122.68], 123.38)] },
    { id: "instr", audio_start: 127.17, lines: [written(129.6)] },
  ];
  const [m] = fitPartStarts(parts, audio);
  assert.equal(m.id, "instr");
  // 2:04.5, the bar after "riconosce~" (the beat change at 2:01.8 is inside the held note)
  assert.ok(Math.abs(m.to - 124.47) < 0.02, String(m.to));
});

test("a word stretched over the beat doesn't hold the part back; a part with recorded singing stays", () => {
  const parts = [
    { id: "chorus", audio_start: 32.5, lines: [sung(59.7, [59.7, 60.3, 61.0], 93.6)] },
    { id: "verse", audio_start: 92.0, lines: [sung(93.7, [93.7, 94.0], 94.5)] },
  ];
  assert.deepEqual(fitPartStarts(parts, audio), []);
  const instr = [parts[0], { id: "instr", audio_start: 92.0, lines: [] }];
  const [m] = fitPartStarts(instr, audio);
  assert.ok(m.to < 64 && m.to > 61, String(m.to));
});

test("a no-vocals part's lyrics laid out later move to its first bar, by whole bars", async () => {
  const { alignPartLines } = await import("./fit-parts");
  const parts = [
    { id: "chorus", audio_start: 92.7, lines: [sung(120.04, [120.04, 121.28, 122.68], 123.38)] },
    { id: "instr", audio_start: 124.471, lines: [written(129.597), written(133.157)] },
  ];
  const [a] = alignPartLines(parts, audio);
  assert.equal(a.id, "instr");
  // two bars: "Le finestre" at 2:04.2, a pickup into the part's first bar (2:04.5)
  assert.ok(Math.abs(129.597 - a.shift - 124.19) < 0.02, String(129.597 - a.shift));
  // lyrics on the part's first bar already: nothing
  assert.deepEqual(alignPartLines([parts[0], { id: "instr", audio_start: 124.471, lines: [written(124.19)] }], audio), []);
});
