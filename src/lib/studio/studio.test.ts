import assert from "node:assert/strict";
import { test } from "node:test";
import { measureLatency, songTimeOfFrame, takeWindow } from "./timing";
import { encodeWav, peaksOf, resample } from "./wav";

test("24-bit WAV header and samples", () => {
  const wav = encodeWav([Float32Array.from([0, 1, -1, 0.5])], 48000);
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(v.getUint16(22, true), 1); // mono
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint16(34, true), 24);
  assert.equal(v.getUint32(40, true), 12); // 4 samples × 3 bytes
  const s = (i: number) => (wav[44 + i * 3] | (wav[45 + i * 3] << 8) | (wav[46 + i * 3] << 16)) << 8 >> 8;
  assert.equal(s(0), 0);
  assert.equal(s(1), 0x7fffff);
  assert.equal(s(2), -0x800000);
  assert.ok(Math.abs(s(3) - 0x3fffff) <= 1);
  assert.deepEqual(peaksOf(Float32Array.from([0, 0.5, -1, 0.2]), 2), [0.5, 1]);
});

test("recorded frames map to song time with latency removed", () => {
  // song position 10 s is played at clock 12 s (base 2); 20 ms latency
  assert.ok(Math.abs(songTimeOfFrame(12.02 * 48000, 48000, 2, 0.02) - 10) < 1e-9);
  assert.deepEqual(takeWindow({ start: 20, end: 40 }, 2, 1), { from: 18, to: 42 });
});

test("latency calibration finds the clicks", () => {
  const sr = 48000;
  const rec = new Float32Array(sr * 3);
  const recStart = 1;
  const clicks = [1.5, 2, 2.5, 3];
  const lat = 0.023;
  for (const t of clicks) {
    const i = Math.round((t + lat - recStart) * sr);
    for (let k = 0; k < 200; k++) rec[i + k] = 0.6 * Math.exp(-k / 50) * (k % 2 ? 1 : -1);
  }
  for (let i = 0; i < rec.length; i++) rec[i] += (Math.sin(i) * 0.01); // a little noise
  const m = measureLatency(rec, sr, recStart, clicks);
  assert.ok(m !== null && Math.abs(m - lat) < 0.001, String(m));
  assert.equal(measureLatency(new Float32Array(sr), sr, 0, clicks), null);
});

test("resampling keeps the duration and a tone's level", () => {
  const x = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 200 * i) / 48000));
  const y = resample(x, 48000, 16000);
  assert.equal(y.length, 16000);
  assert.ok(Math.max(...y) > 0.9 && Math.max(...y) <= 1);
});
