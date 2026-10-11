import assert from "node:assert/strict";
import { test } from "node:test";
import { parseText } from "./text-import";

test("headings become sections, stanzas without one continue the section", () => {
  const text = `[Verse 1]
Vicolo scuro, pioggia sulla pelle
Cerco ancora l'ombra delle stelle

I tuoi passi sopra questo asfalto

RITORNELLO:
E te ne vai così
senza rumori

## Rap
Noi due contro il mondo sembrava davvero`;
  assert.deepEqual(parseText(text), [
    { name: "Verse 1", lines: ["Vicolo scuro, pioggia sulla pelle", "Cerco ancora l'ombra delle stelle", "I tuoi passi sopra questo asfalto"] },
    { name: "Ritornello", lines: ["E te ne vai così", "senza rumori"] },
    { name: "Rap", lines: ["Noi due contro il mondo sembrava davvero"] },
  ]);
});

test("without headings stanzas are verses and a repeated stanza is the chorus", () => {
  const chorus = "E te ne vai così\nsenza rumori";
  const text = `Riga uno\nRiga due\n\n${chorus}\n\nRiga tre\nRiga quattro\n\n${chorus}`;
  assert.deepEqual(
    parseText(text).map((s) => s.name),
    ["Verse 1", "Chorus", "Verse 2", "Chorus"],
  );
  assert.deepEqual(
    parseText("Prima strofa\n\nSeconda strofa", "poem").map((s) => s.name),
    ["Stanza 1", "Stanza 2"],
  );
});

test("a long prose line is split at sentence ends; normal lines stay as they are", () => {
  const prose =
    "Questa è una frase lunga che racconta una storia intera. Poi arriva una seconda frase che continua il discorso! E una terza?";
  assert.deepEqual(parseText(prose)[0].lines, [
    "Questa è una frase lunga che racconta una storia intera.",
    "Poi arriva una seconda frase che continua il discorso!",
    "E una terza?",
  ]);
  assert.deepEqual(parseText("Ciao. Come stai?")[0].lines, ["Ciao. Come stai?"]);
});

test("a lyric line that starts with a section word is not a heading", () => {
  const out = parseText("[Chorus]\nRitornello uno\nBridge over the water\n\nStrofa 2\nRiga\n\nRAP x2\nBarra");
  assert.deepEqual(out, [
    { name: "Chorus", lines: ["Ritornello uno", "Bridge over the water"] },
    { name: "Strofa 2", lines: ["Riga"] },
    { name: "Rap", lines: ["Barra"] },
  ]);
});

test("many short stanzas are combined into parts that keep the couplets", () => {
  const couplets = Array.from({ length: 30 }, (_, i) => `Riga ${i}a\nRiga ${i}b`).join("\n\n");
  const out = parseText(couplets, "speech");
  assert.equal(out.length, 8); // 60 lines → parts of 8
  assert.equal(out[0].name, "Part 1");
  assert.equal(out[0].groupSize, 2);
  assert.equal(out.reduce((n, s) => n + s.lines.length, 0), 60);
});
