import assert from "node:assert/strict";
import { test } from "node:test";
import { adjustLength } from "./fit";
import { prosody } from "./prosody";

const syl = (t: string) => prosody(t, "it").syllables;

test("+ adds a small filler and keeps the rhyme word", () => {
  const line = "sei sempre distante";
  const out = adjustLength(line, "it", 1)!;
  assert.ok(out, "no result");
  assert.ok(syl(out) > syl(line) && syl(out) - syl(line) <= 2, `${line} → ${out}`);
  assert.ok(out.endsWith("distante"));
});

test("− removes a filler or function word, never the last word", () => {
  const line = "e adesso ti guardo e non sento più rumore";
  const out = adjustLength(line, "it", -1)!;
  assert.ok(syl(out) < syl(line), `${line} → ${out}`);
  assert.ok(out.endsWith("rumore"));
  // a leading "e" merges with "adesso" (no syllable gained), so another filler goes
  assert.ok(out.startsWith("e adesso"), out);
});

test("repeated + reaches the reference length", () => {
  const ref = prosody("Ti avevo davanti ma eri distante", "it"); // 11
  let line = "mi hai lasciato soltanto distante"; // 9
  for (let i = 0; i < 8 && syl(line) < ref.syllables; i++) {
    const next = adjustLength(line, "it", 1, ref);
    if (!next) break;
    line = next;
  }
  assert.ok(Math.abs(syl(line) - ref.syllables) <= 1, `${line} (${syl(line)})`);
  assert.ok(line.endsWith("distante"));
});

test("nothing to remove returns null", () => {
  assert.equal(adjustLength("distante", "it", -1), null);
});

test("− can truncate a word the way lyrics do (never the rhyme word)", () => {
  const out = adjustLength("io sono sempre con te nel dolore", "it", -1)!;
  assert.ok(out.endsWith("dolore"), out);
  assert.ok(syl(out) < syl("io sono sempre con te nel dolore"), out);
});
