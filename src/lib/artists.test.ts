import assert from "node:assert/strict";
import { test } from "node:test";
import { artistNames, artistsFrom, sectionArtists } from "./artists";

const anna = { id: "a", name: "Anna", color: "#d61f69" };
const marco = { id: "m", name: "Marco", color: "#1c64f2" };
const tree = {
  project: { settings: { artists: [anna, marco] } },
  sections: [
    { id: "intro", name: "Intro", artists: [] },
    { id: "v1", name: "Verse 1", artists: ["a"] },
    { id: "c1", name: "Chorus", artists: [] },
    { id: "v2", name: "Verse 2", artists: [] },
    { id: "rap", name: "Rap", artists: ["m"] },
    { id: "c2", name: "Chorus", artists: [] },
    { id: "out", name: "Outro", artists: ["a", "m"] },
  ],
};
const who = (id: string) => artistNames(sectionArtists(tree, { id }));

test("performers carry on until a section gets new ones", () => {
  assert.equal(who("intro"), "");
  assert.equal(who("v1"), "Anna");
  assert.equal(who("c1"), "Anna");
  assert.equal(who("v2"), "Anna");
  assert.equal(who("rap"), "Marco");
  assert.equal(who("c2"), "Marco");
  assert.equal(who("out"), "Anna & Marco");
  assert.equal(artistsFrom(tree, { id: "v2" }), "Verse 1");
  assert.equal(artistsFrom(tree, { id: "v1" }), null);
});
