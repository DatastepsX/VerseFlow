import { fft } from "@/lib/audio/structure";
import type { MusicKey } from "./tune";

/**
 * The key of a beat (for autotune): how much of each of the 12 notes it
 * plays (chroma, 60 Hz–2 kHz, across the whole track), compared with the
 * Krumhansl–Kessler key profiles. Pure TypeScript.
 */

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export function chromaOf(x: Float32Array, sr: number): number[] {
  const down = Math.max(1, Math.round(sr / 11025));
  const dsr = sr / down;
  const N = 4096;
  const step = Math.round(dsr * 0.25);
  const chroma = new Array(12).fill(0);
  const bin = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * dsr) / N;
    if (f >= 60 && f <= 2000) bin[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12; // 0 = C
  }
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const frames = Math.floor((x.length / down - N) / step);
  for (let f = 0; f < frames; f++) {
    const o = f * step * down;
    for (let i = 0; i < N; i++) {
      re[i] = x[o + i * down] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      im[i] = 0;
    }
    fft(re, im);
    const frame = new Array(12).fill(0);
    for (let k = 1; k < N / 2; k++) if (bin[k] >= 0) frame[bin[k]] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    // each frame counts the same (loud parts don't decide alone)
    const sum = frame.reduce((a, b) => a + b, 0);
    if (sum > 0) frame.forEach((v, i) => (chroma[i] += v / sum));
  }
  return chroma;
}

function corr(a: number[], b: number[]) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** the most likely key, or null when the track has no clear notes */
export function detectKey(x: Float32Array, sr: number): MusicKey | null {
  const chroma = chromaOf(x, sr);
  if (!chroma.some((v) => v > 0)) return null;
  let best: MusicKey | null = null;
  let score = -Infinity;
  for (let root = 0; root < 12; root++) {
    for (const minor of [false, true]) {
      const prof = minor ? MINOR : MAJOR;
      const rotated = chroma.map((_, i) => chroma[(i + root) % 12]);
      const s = corr(rotated, prof);
      if (s > score) {
        score = s;
        best = { root, minor };
      }
    }
  }
  return score > 0.3 ? best : null;
}
