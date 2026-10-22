import assert from "node:assert/strict";
import { test } from "node:test";
import { lineSlots, planLine, renderLine, timeStretch, wordsFromAlignment } from "./guide";

test("character timings → words", () => {
  const text = "ciao  bella notte";
  const chars = [...text];
  const w = wordsFromAlignment({
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => i * 0.1),
    character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
  });
  assert.deepEqual(
    w.map((x) => x.text),
    ["ciao", "bella", "notte"],
  );
  assert.ok(Math.abs(w[1].start - 0.6) < 1e-9);
  assert.ok(Math.abs(w[1].end - 1.1) < 1e-9);
});

test("words start on the sung syllables", () => {
  // sung: 6 syllables at 10.0, 10.2 … 11.0; spoken "cammino da solo" = 3 + 1 + 2 = 6 syllables
  const slots = { times: [10, 10.2, 10.4, 10.6, 10.8, 11], end: 11.4 };
  const words = [
    { text: "cammino", start: 0.1, end: 0.6 },
    { text: "da", start: 0.65, end: 0.75 },
    { text: "solo", start: 0.8, end: 1.3 },
  ];
  const p = planLine(words, "it", slots);
  assert.deepEqual(
    p.map((x) => Math.round(x.at * 100) / 100),
    [10, 10.6, 10.8],
  );
  assert.ok(Math.abs(p[2].dur - 0.6) < 1e-9, "the last word lasts until the singing ends");
  // fewer spoken syllables than sung ones: still from the first to the last
  const q = planLine([{ text: "notte", start: 0, end: 0.5 }], "it", slots);
  assert.equal(q[0].at, 10);
  assert.ok(Math.abs(q[0].at + q[0].dur - 11.4) < 1e-9);
});

test("lines without a recorded timing: evenly from where they start", () => {
  const s = lineSlots({ text: "la luna", audio_at: 5, flow: null }, 8, "it")!;
  assert.equal(s.times.length, 3);
  assert.equal(s.times[0], 5);
  assert.ok(s.end <= 7.8);
});

test("time stretch keeps the pitch and changes the length", () => {
  const sr = 16000;
  const x = Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * 200 * i) / sr));
  for (const r of [0.7, 1.4]) {
    const y = timeStretch(x, r, sr);
    assert.equal(y.length, Math.round(sr * r));
    // zero crossings per second stay ~400 (200 Hz)
    let zc = 0;
    for (let i = 1 + 400; i < y.length - 400; i++) if (y[i - 1] < 0 !== y[i] < 0) zc++;
    const perSec = zc / ((y.length - 800) / sr);
    assert.ok(Math.abs(perSec - 400) < 25, `ratio ${r}: ${perSec} crossings/s`);
  }
});

test("render: each word lands where it is sung", () => {
  const sr = 8000;
  const src = new Float32Array(sr); // 1 s of speech: two words, at 0.1–0.3 and 0.5–0.8
  for (let i = 0.1 * sr; i < 0.3 * sr; i++) src[i] = 0.5;
  for (let i = 0.5 * sr; i < 0.8 * sr; i++) src[i] = -0.5;
  const { samples, origin } = renderLine(src, sr, [
    { from: 0.1, to: 0.3, at: 2, dur: 0.25 },
    { from: 0.5, to: 0.8, at: 2.5, dur: 0.3 },
  ]);
  assert.ok(Math.abs(origin - 1.95) < 1e-9);
  const at = (t: number) => samples[Math.round((t - origin) * sr)];
  assert.equal(at(1.97), 0);
  assert.ok(at(2.1) > 0.3);
  assert.ok(at(2.6) < -0.3);
});
