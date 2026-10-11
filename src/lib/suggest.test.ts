import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestForSlot } from "./suggest";
import type { BankLine } from "./types";

let id = 0;
const fam = (family: string, texts: string[], state: BankLine["state"] = "available"): BankLine[] =>
  texts.map((text, family_pos) => ({ id: `b${id++}`, section_id: "s", family, family_pos, text, state }));

const bank = [
  ...fam("ore", ["mi hai lasciato soltanto il dolore", "e dentro di me non c'è più calore", "parlavi di noi con un falso colore", "adesso ti guardo e non sento rumore"]),
  ...fam("ante", ["eri vicina ma sempre distante", "per te quel momento non era importante", "ti cerco ogni giorno, ogni istante"]),
  ...fam("ia", ["mi resta soltanto la tua nostalgia"]),
];

test("a slot that must rhyme only gets rhyming bars", () => {
  const r = suggestForSlot({
    bank,
    texts: ["Ti avevo davanti ma eri distante"],
    index: 1,
    groupSize: 2,
    scheme: null,
    lang: "it",
  });
  assert.equal(r.partnerText, "Ti avevo davanti ma eri distante");
  assert.ok(r.suggestions.length > 0);
  for (const s of r.suggestions) assert.match(s.line.text, /ante$/);
});

test("an opening slot prefers families that still have partners, one per family", () => {
  const r = suggestForSlot({ bank, texts: [], index: 0, groupSize: 2, scheme: null, lang: "it", count: 3 });
  const families = r.suggestions.map((s) => s.line.family);
  assert.equal(new Set(families).size, families.length);
  assert.equal(r.suggestions[r.suggestions.length - 1].line.family, "ia"); // single-line family ranks last
});

test("the couplet sibling of a bar taken from the bank ranks first", () => {
  const used = bank.map((b) => (b.text === "parlavi di noi con un falso colore" ? { ...b, state: "used" as const } : b));
  const r = suggestForSlot({
    bank: used,
    texts: ["parlavi di noi con un falso colore"],
    index: 1,
    groupSize: 2,
    scheme: null,
    lang: "it",
  });
  assert.equal(r.suggestions[0].line.text, "adesso ti guardo e non sento rumore");
});

test("lines already in the song are not suggested", () => {
  const r = suggestForSlot({
    bank,
    texts: ["Ti avevo davanti ma eri distante", "per te quel momento non era importante"],
    index: 2,
    groupSize: 2,
    scheme: null,
    lang: "it",
    count: 10,
  });
  assert.ok(!r.suggestions.some((s) => s.line.text === "per te quel momento non era importante"));
});

test("options follow the length and flow of the line before", () => {
  const b = fam("x", [
    "sei sempre distante", // too short
    "e anche se adesso mi sembri così tanto lontana e distante", // too long
    "per te quel momento non era importante", // same flow
    "ti cercavo ogni giorno, ogni istante",
  ]);
  const r = suggestForSlot({
    bank: b,
    texts: ["Ti avevo davanti ma eri distante"],
    index: 1,
    groupSize: 2,
    scheme: null,
    lang: "it",
    count: 2,
  });
  assert.equal(r.reference?.text, "Ti avevo davanti ma eri distante");
  assert.equal(r.suggestions[0].line.text, "per te quel momento non era importante");
  assert.ok(r.suggestions.every((s) => Math.abs(s.sylDiff) <= 2), JSON.stringify(r.suggestions.map((s) => [s.line.text, s.sylDiff])));
});
