import assert from "node:assert/strict";
import { test } from "node:test";
import { summary, type Entry } from "./notify-summary";

test("the email's summary: per person what they did, downloads named", () => {
  const at = Date.UTC(2026, 10, 7, 17, 5);
  const news: Entry[] = [
    { u: "ana", what: "lyrics", n: 9, at },
    { u: "ana", what: "song", n: 4, at },
    { u: "ana", what: "takes", n: 2, at: at + 60_000 },
    { u: "ben", what: "song", n: 1, at },
    { u: null, what: "download", n: 1, at, detail: "the stems with the share link" },
  ];
  const lines = summary(news, (u) => (u === "ana" ? "Ana" : u === "ben" ? "Ben" : "Someone with the share link"), "UTC");
  assert.deepEqual(lines, [
    "Ana: changed the lyrics (9 times), recorded 2 takes — last at 17:06.",
    "Ben: made changes to the song — last at 17:05.",
    "Someone with the share link: downloaded the stems with the share link — last at 17:05.",
  ]);
});
