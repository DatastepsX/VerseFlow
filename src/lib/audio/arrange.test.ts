import assert from "node:assert/strict";
import { test } from "node:test";
import { extendSamples } from "./arrange";

const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => i);

test("the part's last bars come again where it ends, the rest of the song later", () => {
  // 1 sample = 1 s; bars 4 long; the part is 0..8, add one bar at 8 (repeating 4..8)
  const { data } = extendSamples(ramp(12), 1, [{ at: 8, from: 4, len: 4 }]);
  assert.deepEqual([...data], [0, 1, 2, 3, 4, 5, 6, 7, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("a part shorter than what is added repeats", () => {
  const { data } = extendSamples(ramp(6), 1, [{ at: 4, from: 2, len: 6 }]);
  assert.deepEqual([...data], [0, 1, 2, 3, 2, 3, 2, 3, 2, 3, 4, 5]);
});

test("the added bars come from the music without vocals, both stay in step", () => {
  // each extension is in the song's time as it was then (after the ones before it)
  const full = ramp(8);
  const music = Float32Array.from({ length: 8 }, (_, i) => 100 + i);
  const r = extendSamples(full, 1, [{ at: 4, from: 2, len: 2 }, { at: 8, from: 6, len: 2 }], music);
  assert.deepEqual([...r.data], [0, 1, 2, 3, 102, 103, 4, 5, 104, 105, 6, 7]);
  assert.deepEqual([...r.src!], [100, 101, 102, 103, 102, 103, 104, 105, 104, 105, 106, 107]);
});

test("a part pasted elsewhere: its bars go in at that point — the music alone, or with its vocals", () => {
  const full = ramp(10);
  const music = Float32Array.from({ length: 10 }, (_, i) => 100 + i);
  // the part 2..4 pasted at 8
  const plain = extendSamples(full, 1, [{ at: 8, from: 2, to: 4, len: 2 }], music);
  assert.deepEqual([...plain.data], [0, 1, 2, 3, 4, 5, 6, 7, 102, 103, 8, 9]);
  assert.deepEqual([...plain.src!], [100, 101, 102, 103, 104, 105, 106, 107, 102, 103, 108, 109]);
  const sung = extendSamples(full, 1, [{ at: 8, from: 2, to: 4, len: 2, vocals: true }], music);
  assert.deepEqual([...sung.data], [0, 1, 2, 3, 4, 5, 6, 7, 2, 3, 8, 9]);
  // pasted before where it comes from
  assert.deepEqual([...extendSamples(full, 1, [{ at: 2, from: 6, to: 8, len: 2 }]).data], [0, 1, 6, 7, 2, 3, 4, 5, 6, 7, 8, 9]);
});
