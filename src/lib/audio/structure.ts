import { onsetEnvelope } from "./tempo";

/**
 * The song's bar grid and where the beat changes.
 *
 * fitGrid: the exact tempo (no rounding: 83.33 is not 83 — over 100 bars
 * that is a whole beat) and phase from the onsets of the whole song, then
 * bar 1 = the beat position with the most kick. A rough BPM (detected, or
 * typed by the writer) is refined within ±3 %.
 *
 * beatChanges: bar-synchronous timbre (16 bands) + harmony (chroma) per bar,
 * a self-similarity matrix and a checkerboard kernel: peaks are the bar
 * starts where the arrangement changes (verse → hook, drop, break…).
 *
 * Pure TypeScript: runs in the browser on the decoded beat, and in tests.
 */

export interface BeatChange {
  /** bar start in seconds */
  t: number;
  /** 0..1 relative strength */
  s: number;
}

export interface GridFit {
  bpm: number;
  /** first downbeat (bar 1) in seconds */
  offset: number;
}

export function fitGrid(samples: Float32Array, sampleRate: number, approxBpm: number, beatsPerBar = 4, span = 0.03): GridFit {
  // half-time (slow) readings: which half of the long bar is "1" is ambiguous — fit at double speed
  // and start the long bar with a full-speed bar line
  if (approxBpm < 90) {
    const fast = fitGrid(samples, sampleRate, approxBpm * 2, beatsPerBar, span);
    return { bpm: Math.round((fast.bpm / 2) * 1000) / 1000, offset: fast.offset };
  }
  const { env, kick, fps } = onsetEnvelope(samples, sampleRate);
  const at = (e: Float32Array, t: number) => {
    const f = t * fps;
    const i = Math.floor(f);
    if (i < 0 || i + 1 >= e.length) return 0;
    return e[i] + (e[i + 1] - e[i]) * (f - i);
  };
  const dur = env.length / fps;
  const score = (bpm: number, phase: number) => {
    const b = 60 / bpm;
    let s = 0;
    let n = 0;
    for (let t = phase; t < dur; t += b) {
      s += at(env, t);
      n++;
    }
    return s / Math.max(1, n);
  };
  let best = { bpm: approxBpm, phase: 0, s: -1 };
  const search = (b0: number, b1: number, bStep: number, p0: (bpm: number) => number, p1: (bpm: number) => number, pStep: number) => {
    for (let bpm = b0; bpm <= b1; bpm += bStep)
      for (let ph = p0(bpm); ph < p1(bpm); ph += pStep) {
        const s = score(bpm, ph);
        if (s > best.s) best = { bpm, phase: ph, s };
      }
  };
  // coarse over ±span, then fine around the best
  search(approxBpm * (1 - span), approxBpm * (1 + span), 0.01, () => 0, (bpm) => 60 / bpm, 0.02);
  const c = best;
  search(c.bpm - 0.03, c.bpm + 0.03, 0.002, () => Math.max(0, c.phase - 0.03), () => c.phase + 0.03, 0.002);

  // bar 1: arrangements change on bar lines, so the beat position (of the bar) that collects the most
  // beat-to-beat change is the downbeat; the kick on bar starts breaks ties
  const beat = 60 / best.bpm;
  const bar = beatsPerBar * beat;
  const phase0 = best.phase % beat;
  const hist = new Array(beatsPerBar).fill(0);
  for (const c of beatChanges(samples, sampleRate, { bpm: best.bpm, offset: phase0, beatsPerBar: 1 })) {
    const k = Math.round((c.t - phase0) / beat);
    hist[((k % beatsPerBar) + beatsPerBar) % beatsPerBar] += c.s;
  }
  const histSum = hist.reduce((x, y) => x + y, 0) || 1;
  const kickBar = hist.map((_, k) => {
    let e = 0;
    let n = 0;
    for (let t = phase0 + k * beat; t < dur; t += bar) {
      e += at(kick, t);
      n++;
    }
    return e / Math.max(1, n);
  });
  const kickSum = kickBar.reduce((x, y) => x + y, 0) || 1;
  let down = 0;
  hist.forEach((_, k) => {
    const v = (k2: number) => hist[k2] / histSum + 0.3 * (kickBar[k2] / kickSum);
    if (v(k) > v(down)) down = k;
  });
  let offset = phase0 + down * beat;
  while (offset - bar >= -0.02) offset -= bar;
  return { bpm: Math.round(best.bpm * 1000) / 1000, offset: Math.round(Math.max(0, offset) * 1000) / 1000 };
}

/* ---------- beat changes ---------- */

const N = 2048;
const BANDS = 16;

export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const half = len / 2;
    for (let k = 0; k < half; k++) {
      const wr = Math.cos(ang * k);
      const wi = Math.sin(ang * k);
      for (let i = k; i < n; i += len) {
        const j = i + half;
        const vr = re[j] * wr - im[j] * wi;
        const vi = re[j] * wi + im[j] * wr;
        re[j] = re[i] - vr;
        im[j] = im[i] - vi;
        re[i] += vr;
        im[i] += vi;
      }
    }
  }
}

/** one feature vector per bar: 16 log band energies + 12 chroma */
function barFeatures(x: Float32Array, sr: number, offset: number, bar: number) {
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const band = new Int8Array(N / 2).fill(-1);
  const chroma = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N;
    if (f >= 40 && f < 8000) band[k] = Math.min(BANDS - 1, Math.floor((BANDS * Math.log(f / 40)) / Math.log(8000 / 40)));
    if (f > 60 && f < 2000) chroma[k] = (((Math.round(12 * Math.log2(f / 440)) % 12) + 12) % 12) as number;
  }
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const bars = Math.floor((x.length / sr - offset) / bar);
  const out: number[][] = [];
  for (let b = 0; b < bars; b++) {
    const s0 = Math.floor((offset + b * bar) * sr);
    const s1 = Math.floor((offset + (b + 1) * bar) * sr);
    const B = new Float64Array(BANDS);
    const C = new Float64Array(12);
    let frames = 0;
    for (let s = s0; s + N <= s1; s += N / 2) {
      for (let i = 0; i < N; i++) {
        re[i] = x[s + i] * win[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 1; k < N / 2; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        if (band[k] >= 0) B[band[k]] += p;
        if (chroma[k] >= 0) C[chroma[k]] += p;
      }
      frames++;
    }
    const cs = Math.hypot(...C) || 1;
    out.push([...Array.from(B, (v) => Math.log1p(v / Math.max(1, frames))), ...Array.from(C, (v) => v / cs)]);
  }
  return out;
}

export function beatChanges(samples: Float32Array, sampleRate: number, grid: { bpm: number; offset: number; beatsPerBar?: number }): BeatChange[] {
  const bar = ((grid.beatsPerBar ?? 4) * 60) / grid.bpm;
  if (!(bar > 0.2)) return [];
  const feats = barFeatures(samples, sampleRate, grid.offset, bar);
  const n = feats.length;
  if (n < 8) return [];
  // z-score every dimension, chroma counts double
  const D = feats[0].length;
  for (let d = 0; d < D; d++) {
    const m = feats.reduce((s, f) => s + f[d], 0) / n;
    const sd = Math.sqrt(feats.reduce((s, f) => s + (f[d] - m) ** 2, 0) / n) || 1;
    const w = d >= BANDS ? 2 : 1;
    for (const f of feats) f[d] = ((f[d] - m) / sd) * w;
  }
  const norm = feats.map((f) => Math.hypot(...f) || 1);
  const sim = (a: number, b: number) => {
    let s = 0;
    for (let d = 0; d < D; d++) s += feats[a][d] * feats[b][d];
    return s / (norm[a] * norm[b]);
  };
  // checkerboard kernel, 4 bars each side, gaussian taper
  const K = 4;
  const nov = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    let s = 0;
    for (let a = -K; a < K; a++)
      for (let c = -K; c < K; c++) {
        const p = i + a;
        const q = i + c;
        if (p < 0 || q < 0 || p >= n || q >= n) continue;
        const sign = a < 0 === c < 0 ? 1 : -1;
        s += sign * sim(p, q) * Math.exp(-((a + 0.5) ** 2 + (c + 0.5) ** 2) / (K * K));
      }
    nov[i] = Math.max(0, s);
  }
  const max = Math.max(...nov) || 1;
  const peaks: BeatChange[] = [];
  for (let i = 1; i < n; i++) {
    if (nov[i] < 0.25 * max || nov[i] < nov[i - 1] || nov[i] < (nov[i + 1] ?? 0)) continue;
    const t = Math.round((grid.offset + i * bar) * 1000) / 1000;
    const last = peaks[peaks.length - 1];
    // two changes closer than 2 bars: keep the stronger
    if (last && t - last.t < 2 * bar - 0.01) {
      if (nov[i] / max > last.s) peaks[peaks.length - 1] = { t, s: Math.round((nov[i] / max) * 100) / 100 };
      continue;
    }
    peaks.push({ t, s: Math.round((nov[i] / max) * 100) / 100 });
  }
  return peaks;
}

/* ---------- snapping ---------- */

/** grid + changes for a beat: detect the beat changes once the grid is fitted */
export function analyseBeat(samples: Float32Array, sampleRate: number, approxBpm: number, beatsPerBar = 4) {
  const grid = fitGrid(samples, sampleRate, approxBpm, beatsPerBar);
  return { ...grid, changes: beatChanges(samples, sampleRate, { ...grid, beatsPerBar }) };
}

export interface SnapGrid {
  bpm: number | null;
  beat_offset: number;
  beats_per_bar: number;
  changes?: BeatChange[] | null;
}

/**
 * Where a section starting near `t` really starts: the nearest beat change
 * within about a bar (≤ 2.5 s), else the nearest bar start (a vocal pickup just
 * before the bar lands on that bar).
 */
export function snapSectionStart(t: number, grid: SnapGrid, maxBars = 1.25) {
  if (!grid.bpm) return t;
  const bar = (grid.beats_per_bar * 60) / grid.bpm;
  const near = (grid.changes ?? [])
    // at most ~a bar and 2.5 s away: fixes a start that is a little off, never moves a section elsewhere
    .filter((c) => Math.abs(c.t - t) <= Math.min(maxBars * bar, 2.5) + 0.01)
    // closer wins; a strong change may be a little further away
    .sort((a, b) => Math.abs(a.t - t) / bar - 0.5 * a.s - (Math.abs(b.t - t) / bar - 0.5 * b.s))[0];
  if (near) return near.t;
  const k = Math.round((t - grid.beat_offset) / bar);
  return Math.max(0, Math.round((grid.beat_offset + k * bar) * 1000) / 1000);
}

/** Snap every section start; sections keep their order (equal starts stay equal). */
export function alignStarts(starts: number[], grid: SnapGrid) {
  if (!grid.bpm) return starts;
  const bar = (grid.beats_per_bar * 60) / grid.bpm;
  const order = starts.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t);
  const out = [...starts];
  let prev: { t: number; snapped: number } | null = null;
  for (const { t, i } of order) {
    let s = snapSectionStart(t, grid);
    if (prev && t === prev.t) s = prev.snapped;
    else if (prev && s <= prev.snapped) {
      s = snapSectionStart(t, { ...grid, changes: [] });
      if (s <= prev.snapped) s = Math.round((prev.snapped + bar) * 1000) / 1000;
    }
    out[i] = s;
    prev = { t, snapped: s };
  }
  return out;
}
