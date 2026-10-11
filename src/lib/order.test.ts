import assert from "node:assert/strict";
import { test } from "node:test";
import { orderSections } from "./order";

const s = (name: string, position: number, audio_start: number | null) => ({ name, position, audio_start });

test("anchored sections follow the beat, unanchored keep their place", () => {
  const out = orderSections([
    s("Verse 1", 1, 0),
    s("Hook", 2, 40),
    s("Notes", 3, null),
    s("Rap", 4, 20), // created later, plays before the Hook
    s("Outro", 5, 90),
  ]).map((x) => x.name);
  assert.deepEqual(out, ["Verse 1", "Rap", "Notes", "Hook", "Outro"]);
});

test("without anchors the stored order stays", () => {
  assert.deepEqual(orderSections([s("B", 2, null), s("A", 1, null)]).map((x) => x.name), ["A", "B"]);
});
