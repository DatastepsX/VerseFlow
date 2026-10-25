import assert from "node:assert/strict";
import { test } from "node:test";
import type { TimedWord } from "./lyrics";
import { songSections, sungLines } from "./song-lines";

/** words of `text` sung from `from`, `perWord` seconds each */
function sing(text: string, from: number, perWord: number): TimedWord[] {
  return text.split(" ").map((w, i) => ({ text: w, start: from + i * perWord, end: from + (i + 1) * perWord - 0.03 }));
}

test("every sentence starts a new line, even without a pause", () => {
  const words = sing("Vicolo scuro, pioggia sulla pelle. Cerco ancora l'ombra delle stelle.", 1, 0.4);
  assert.deepEqual(
    sungLines(words, "it").map((l) => l.text),
    ["Vicolo scuro, pioggia sulla pelle.", "Cerco ancora l'ombra delle stelle."],
  );
});

test("a lone word joins the line after it", () => {
  const words = [...sing("Un", 14.3, 0.5), ...sing("pacchetto di sigarette vuoto.", 15.6, 0.5)];
  assert.deepEqual(
    sungLines(words, "it").map((l) => l.text),
    ["Un pacchetto di sigarette vuoto."],
  );
});

test("a line twice as long as its neighbours is split at its comma", () => {
  const words = [
    ...sing("Le notti a parlare restavi con me.", 0, 0.24),
    ...sing("Pensavo che il mondo finisse con te.", 1.8, 0.24),
    ...sing("Tu chiusa nel letto e io fuori da solo, ma dopo ogni guerra tornavi di nuovo.", 3.6, 0.22),
    ...sing("Poi piano qualcosa iniziava a cambiare.", 7.3, 0.25),
  ];
  const lines = sungLines(words, "it", { bar: 2.6 }).map((l) => l.text);
  assert.ok(lines.includes("Tu chiusa nel letto e io fuori da solo,"), lines.join(" | "));
  assert.ok(lines.includes("ma dopo ogni guerra tornavi di nuovo."));
});

test("verse, chorus and a fast rap part become their own sections on the beat", () => {
  const chorus = (t: number) => [
    ...sing("E te ne vai così, senza rumori.", t, 0.55),
    ...sing("Senza il mio cuore suona una nota sola.", t + 4.5, 0.5),
    ...sing("Questa canzone ormai mi stringe la gola.", t + 9, 0.5),
  ];
  const words = [
    ...sing("Vicolo scuro, pioggia sulla pelle.", 1, 0.6),
    ...sing("Cerco ancora l'ombra delle stelle.", 5, 0.6),
    ...sing("I tuoi passi sopra questo asfalto.", 9, 0.6),
    ...chorus(14),
    // rap: ~8 syllables per second
    ...sing("Yeah, noi due contro il mondo sembrava davvero.", 28.2, 0.2),
    ...sing("Insieme con te era tutto leggero.", 30, 0.22),
    ...sing("Le notti a parlare restavi con me.", 31.7, 0.22),
    ...sing("Pensavo che il mondo finisse con te.", 33.4, 0.22),
    ...chorus(36),
  ];
  const grid = { bpm: 120, beat_offset: 0, beats_per_bar: 4, changes: null, duration: 52 };
  const secs = songSections(sungLines(words, "it", { bar: 2 }), grid, "song");
  assert.deepEqual(
    secs.map((s) => s.name),
    ["Verse 1", "Chorus", "Rap 1", "Chorus"],
  );
  const rap = secs[2];
  assert.equal(rap.lines[0].text, "Yeah, noi due contro il mondo sembrava davvero.");
  // starts on a bar line, not after the first sung word
  assert.equal(rap.start % 2, 0);
  assert.ok(rap.start <= 28.2 + 0.15);
});

test("ad-libs make the intro, a beat change before the chorus the pre-chorus", () => {
  const chorus = (t: number) => [
    ...sing("Andiamo a ballare stanotte con me.", t, 0.5),
    ...sing("Cuore contro cuore non provare a pensare.", t + 4, 0.5),
    ...sing("Andiamo a ballare finché sorge il sole.", t + 8, 0.5),
  ];
  const words = [
    ...sing("Ohhh, yeah.", 1, 0.6),
    ...sing("Luci che si accendono sulla città.", 4, 0.5),
    ...sing("Scarpe nuove e il pavimento che vibra.", 8, 0.5),
    ...sing("Cuore che accelera dentro al locale.", 12, 0.5),
    ...sing("Frate stasera si brinda alla notte.", 16, 0.5),
    ...sing("Basso nel petto non senti le voci.", 20.1, 0.5),
    ...sing("Tu seguimi adesso e muovi il destino.", 24, 0.5),
    ...chorus(28),
    ...sing("Ma quando fuori sarà giorno pieno.", 40, 0.5),
    ...sing("Rideremo per le foto mosse.", 44, 0.5),
    ...sing("Per il cuore sempre fuori fuoco.", 48, 0.5),
    ...chorus(52),
  ];
  const grid = { bpm: 120, beat_offset: 0, beats_per_bar: 4, changes: [{ t: 20, s: 0.8 }], duration: 64 };
  const secs = songSections(sungLines(words, "it", { bar: 2 }), grid, "song");
  assert.deepEqual(
    secs.map((s) => s.name),
    ["Intro", "Verse 1", "Pre-chorus", "Chorus", "Verse 2", "Chorus"],
  );
  assert.equal(secs[2].start, 20);
  assert.equal(secs[2].lines[0].text, "Basso nel petto non senti le voci.");
});
