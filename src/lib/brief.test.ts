import assert from "node:assert/strict";
import { test } from "node:test";
import { briefPrompt, cleanBrief } from "./brief";

test("a part's brief: only known choices are kept, and the AI reads it as plain instructions", () => {
  const b = cleanBrief({ moods: ["romantic", "melancholic", "nope"], perspective: "me", words: ["modern"], rhymes: "multi", about: "  La guardo ballare  ", keywords: "" });
  assert.deepEqual(b?.moods, ["romantic", "melancholic"]);
  assert.equal(b?.about, "La guardo ballare");
  const text = briefPrompt(b);
  assert.match(text, /^Mood: romantic, tender, in love; melancholic/);
  assert.match(text, /Perspective: first person/);
  assert.match(text, /Rhymes: multi-syllable/);
  assert.match(text, /What it is about \(the writer's words\): La guardo ballare/);
  assert.doesNotMatch(text, /Use these words/);
  // nothing chosen: no brief at all
  assert.equal(cleanBrief({ moods: [], about: " " }), null);
  assert.equal(briefPrompt(null), "");
});
