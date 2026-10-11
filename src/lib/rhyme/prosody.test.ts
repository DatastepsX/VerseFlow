import assert from "node:assert/strict";
import { test } from "node:test";
import { prosody, rhythmSimilarity } from "./prosody";

test("syllables, stresses and ending of an Italian line", () => {
  const p = prosody("Ti avevo davanti ma eri distante", "it");
  // ti-a|ve|vo|da|van|ti|ma-e|ri|di|stan|te — synalepha ti+a and ma+e → 11 sung syllables
  assert.equal(p.syllables, 11);
  assert.equal(p.ending, 1);
  assert.deepEqual(p.stresses, [1, 4, 6, 9]); // aVEvo daVANti ma-Eri diSTANte
});

test("a line with the same flow scores high, a different one low", () => {
  const ref = prosody("Ti avevo davanti ma eri distante", "it");
  const same = prosody("per te quel momento non era importante", "it");
  const short = prosody("ti amo", "it");
  const tronca = prosody("non ho più niente da darti per te", "it");
  assert.ok(rhythmSimilarity(ref, same) >= 0.8, `same: ${rhythmSimilarity(ref, same)}`);
  assert.ok(rhythmSimilarity(ref, short) < 0.5, `short: ${rhythmSimilarity(ref, short)}`);
  assert.ok(rhythmSimilarity(ref, same) > rhythmSimilarity(ref, tronca));
});
