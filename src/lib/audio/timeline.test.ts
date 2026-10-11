import assert from "node:assert/strict";
import { test } from "node:test";
import { alignLines, buildTimeline, positionIn, sectionTimeline } from "./timeline";
import type { TimedWord } from "./lyrics";

const lyric = (text: string, audio_at: number | null = null) => ({ text, kind: "lyric" as const, audio_at });
const sec = (lines: ReturnType<typeof lyric>[], bars_per_line = 1) => ({ id: "s", audio_start: 0, bars_per_line, pattern: null, lines });

test("equal lines take one bar each (as before)", () => {
  const s = sec([lyric("sento la nonna che guarda nel sole"), lyric("lei che mi lascia e scompare nel cuore"), lyric("sento la nonna che guarda nel sole")]);
  const t = sectionTimeline(s, 10, 50, 2, "it");
  assert.deepEqual(
    t.starts.map((x) => Math.round(x * 10) / 10),
    [10, 12, 14],
  );
});

test("short lines take less time than long ones", () => {
  const s = sec([lyric("sugo di sarde e un bicchiere di vino"), lyric("tutta la casa"), lyric("nonna ci chiama"), lyric("questa è la terra che porto nel petto")]);
  const t = sectionTimeline(s, 0, 100, 2, "it");
  const d1 = t.starts[1] - t.starts[0];
  const d2 = t.starts[2] - t.starts[1];
  assert.ok(d2 < d1 * 0.7, `short line ${d2} vs long ${d1}`);
});

test("too many lines are squeezed into the section", () => {
  const s = sec(Array.from({ length: 30 }, () => lyric("sento la nonna che guarda nel sole")));
  const t = sectionTimeline(s, 0, 40, 2, "it"); // 20 bars for 30 lines
  assert.ok(t.starts[29] < 40 && t.starts[29] > 35);
});

test("known times are kept and lines in between share the gap", () => {
  const s = sec([lyric("uno due tre quattro cinque sei", 5), lyric("sette otto nove dieci undici"), lyric("dodici tredici quattordici", 9)]);
  const t = sectionTimeline(s, 0, 40, 2, "it");
  assert.equal(t.starts[0], 5);
  assert.equal(t.starts[2], 9);
  assert.ok(t.starts[1] > 5 && t.starts[1] < 9);
});

test("position follows the timeline and reports the next bar after the lyrics", () => {
  const tl = buildTimeline(
    [{ ...sec([lyric("sento la nonna che guarda nel sole"), lyric("tutta la casa")]), audio_start: 0 }],
    { filename: "x", duration: 40, bpm: 120, beat_offset: 0, beats_per_bar: 4 } as never,
    "it",
  );
  assert.deepEqual(positionIn(tl, 0.5), { sectionId: "s", lineIndex: 0 });
  assert.deepEqual(positionIn(tl, 2.2), { sectionId: "s", lineIndex: 1 });
  assert.deepEqual(positionIn(tl, 20), { sectionId: "s", lineIndex: 2 });
});

function sing(text: string, from: number, per = 0.3): TimedWord[] {
  return text.split(" ").map((w, i) => ({ text: w, start: from + i * per, end: from + (i + 1) * per - 0.02 }));
}

test("lines are found in the sung words despite ad-libs and slips", () => {
  const words = [
    ...sing("yeah yeah", 0),
    ...sing("Sugo di sarde e un bicchiere di vino", 1),
    ...sing("nonno nel quadro che guarda vicino", 3.6),
    ...sing("ehi", 6),
    ...sing("Tutta la casa", 6.5),
    ...sing("Nonna ci chiama", 7.6),
    ...sing("Etna che fuma sotto la luna", 8.7),
  ];
  words[3].text = "sardee"; // transcription slip
  const lines = ["Sugo di sarde e un bicchiere di vino", "nonno nel quadro che guarda vicino", "Tutta la casa", "Nonna ci chiama", "una riga che non è cantata", "sotto la luna"];
  const at = alignLines(lines, words);
  assert.equal(at[0], 1);
  assert.equal(at[1], 3.6);
  assert.equal(at[2], 6.5);
  assert.equal(at[3], 7.6);
  assert.equal(at[4], null);
  assert.ok(at[5] !== null && Math.abs(at[5] - 9.6) < 0.01);
});
