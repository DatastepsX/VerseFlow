import assert from "node:assert/strict";
import { test } from "node:test";
import { rhymePartners, songRhymeDistance } from "./scheme";

const couplets = [
  "Vicolo scuro, pioggia sulla pelle",
  "cerco ancora l'ombra delle stelle",
  "I tuoi passi sopra questo asfalto",
  "io credevo fossimo più in alto",
  "Le notti a parlare restavi con me",
  "pensavo che il mondo finisse con te",
];

test("the first line of a couplet rhymes with the second, even in a section of single lines", () => {
  // the writer rewrites line 3 (index 2): its partner is the existing line 4
  const texts = couplets.map((t, i) => (i === 2 ? "x" : t));
  const p = rhymePartners(texts, 1, null, "it");
  assert.equal(p[2].partner, 3);
  assert.equal(p[3].partner, 2);
  assert.equal(p[0].partner, 1);
  // a line the writer is changing whose current text doesn't rhyme yet
  const changed = couplets.map((t, i) => (i === 4 ? "Le notti parlavamo fino al mattino" : t));
  assert.equal(rhymePartners(changed, 1, null, "it")[4].partner, 5);
});

test("alternating rhymes are detected", () => {
  const abab = [couplets[0], couplets[2], couplets[1], couplets[3]];
  const p = rhymePartners(abab, 2, null, "it");
  assert.equal(p[0].partner, 2);
  assert.equal(p[1].partner, 3);
});

test("an explicit scheme wins; no pattern in the text falls back to the grouping", () => {
  assert.equal(rhymePartners(couplets, 1, "ABAB", "it")[0].partner, 2);
  const loose = ["Uno due tre", "quattro cinque", "sei sette", "otto nove"];
  assert.equal(rhymePartners(loose, 2, null, "it")[0].partner, 1);
  assert.equal(rhymePartners(loose, 1, null, "it")[0].partner, null);
});

test("a section of one couplet follows the song's pattern", () => {
  const sections = [couplets.slice(0, 2), couplets.slice(2, 4), couplets.slice(4, 6)];
  const dist = songRhymeDistance(sections, "it");
  assert.equal(dist, 1);
  // the first line is being rewritten (doesn't rhyme yet): it still pairs with the second
  assert.equal(rhymePartners(["Le notti parlavamo fino al mattino", couplets[5]], 1, null, "it", dist)[0].partner, 1);
});
