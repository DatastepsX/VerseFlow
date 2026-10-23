import assert from "node:assert/strict";
import { test } from "node:test";
import { prosody } from "./prosody";
import { syllabify } from "./syllabify";

test("lines split into their sung syllables, as many as the app counts", () => {
  assert.equal(syllabify("Ti scrivo dentro me", "it")?.join("·"), "Ti·scri·vo·den·tro·me");
  assert.equal(syllabify("Fuori la sera cambia colore,", "it")?.join("·"), "Fuo·ri·la·se·ra·cam·bia·co·lo·re,");
  assert.equal(syllabify("La nostra strada non è finita", "it")?.join("·"), "La·no·stra·stra·da·non·è·fi·ni·ta");
  for (const line of [
    "Ti scrivo piano senza chiedere perché.",
    "La casa tiene ancora il suono dei tuoi passi.",
    "ma dentro il petto resta il tuo nome.",
    "E se la strada ci divide,",
    "Qualcosa muove ancora il mondo",
    "quando penso a noi due.",
    "l'amore ci ritroverà.",
    "Se il cuore sa dove tornare,",
    "Anche da soli, a metà,",
    "e la notte non ha più",
    "Stringimi l'anima",
    "Chiudo gli occhi e ti sento",
    "la paura del buio",
  ]) {
    const s = syllabify(line, "it");
    assert.ok(s, `“${line}” should split`);
    assert.equal(s.length, prosody(line, "it").syllables, `${line} → ${s.join("·")}`);
    assert.equal(s.join("").replace(/‿/g, ""), line.replace(/\s+/g, ""), "nothing lost");
  }
  assert.equal(syllabify("Ti scrivo dentro me", "en"), null, "Romance languages only");
});
