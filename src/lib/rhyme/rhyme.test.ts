import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeLine, analyzeWord, compareLines, rhymeScheme } from "./analyze";

const key = (w: string, lang = "it") => analyzeWord(w, lang).rhymeKey;

test("italian rhyme keys start at the stressed vowel", () => {
  assert.equal(key("amore"), "ore");
  assert.equal(key("cuore"), "ore");
  assert.equal(key("distante"), "ante");
  assert.equal(key("città"), "a");
  assert.equal(key("perche"), "e"); // unaccented input of a known parola tronca
  assert.equal(key("mio"), "io");
  assert.equal(key("magia"), "ia");
  assert.equal(key("storia"), "oria");
  assert.equal(key("anima"), "anima");
  assert.equal(key("parlavano"), "avano");
});

test("italian syllables use synalepha between words", () => {
  assert.equal(analyzeLine("Noi due contro il mondo, sembrava davvero", "it").syllables, 12);
  assert.equal(analyzeLine("pensavo che il mondo finisse con te", "it").syllables, 11);
});

test("perfect rhyme, assonance and none", () => {
  const a = (t: string) => analyzeLine(t, "it");
  assert.equal(compareLines(a("sembrava davvero"), a("era tutto leggero")).quality, "perfect");
  assert.equal(compareLines(a("con gli occhi di ghiaccio"), a("ma dentro mi spacco")).quality, "assonance");
  assert.equal(compareLines(a("restavi con me"), a("sembrava davvero")).quality, "none");
});

test("rhyme scheme letters", () => {
  const s = rhymeScheme(
    ["sembrava davvero", "tutto leggero", "restavi con me", "finisse con te"],
    "it",
  ).map((e) => e.letter);
  assert.deepEqual(s, ["A", "A", "B", "B"]);
});

test("english heuristics", () => {
  assert.equal(key("time", "en"), key("rhyme", "en"));
  assert.equal(key("night", "en"), key("light", "en"));
  assert.equal(key("me", "en"), key("free", "en"));
});
