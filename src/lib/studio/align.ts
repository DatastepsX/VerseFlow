/**
 * Takes in time — a studio's vocal alignment (VocAlign) and quantize (Flex Time), for a take's audio:
 *
 *  - toGuide: a double (or ad-lib) made to follow another take, syllable by syllable. Both are described every
 *    10 ms by their loudness in three bands (low / mid / high) and how sharply it rises; a time map between
 *    them is found with dynamic time warping (within ±0.4 s), and the double is stretched and squeezed along
 *    it — the pitch kept (WSOLA).
 *  - toGrid: each syllable's start (an onset) pulled onto the nearest step of the beat grid (1/16 or 1/8) by
 *    some strength, the audio between them stretched to fit.
 *
 * The take keeps its length and its place in the song: only the timing inside it changes. Pure TypeScript.
 */

import { fft } from "@/lib/audio/structure";

const HOP = 0.01;

/** one-pole low-pass */
function lowpass(x: Float32Array, sr: number, fc: number) {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
  const y = new Float32Array(x.length);
  let v = 0;
  for (let i = 0; i < x.length; i++) {
    v += a * (x[i] - v);
    y[i] = v;
  }
  return y;
}

/** every 10 ms: the loudness (log RMS) of the low, mid and high band and of the whole, and how sharply it rises */
export function features(x: Float32Array, sr: number): Float32Array[] {
  const hop = Math.max(1, Math.round(sr * HOP));
  const n = Math.floor(x.length / hop);
  const lo = lowpass(x, sr, 300);
  const lm = lowpass(x, sr, 2000);
  // running sums of each band's square: a frame's RMS in one subtraction
  const sums = [0, 1, 2, 3].map(() => new Float64Array(x.length + 1));
  for (let i = 0; i < x.length; i++) {
    const v = [lo[i], lm[i] - lo[i], x[i] - lm[i], x[i]];
    for (let k = 0; k < 4; k++) sums[k][i + 1] = sums[k][i] + v[k] * v[k];
  }
  const dims = sums.map((cs) => {
    const out = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      const a = Math.max(0, Math.round(f * hop - hop / 2));
      const e = Math.min(x.length, Math.round(f * hop + hop + hop / 2));
      out[f] = Math.log10(Math.sqrt((cs[e] - cs[a]) / Math.max(1, e - a)) + 1e-5);
    }
    return out;
  });
  const onset = new Float32Array(n);
  for (let f = 1; f < n; f++) onset[f] = Math.max(0, dims[3][f] - dims[3][f - 1]);
  // each dimension on its own scale (a louder or quieter take compares the same)
  return [...dims, onset].map((d) => {
    const sorted = Float32Array.from(d).sort();
    const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const dev = Float32Array.from(d, (v) => Math.abs(v - med)).sort();
    const mad = dev[Math.floor(d.length / 2)] || 1;
    return d.map((v) => (v - med) / mad);
  });
}

/**
 * What is being sung every 10 ms, whatever the voice or the level: 12 cepstral coefficients (MFCC — the shape of
 * the spectrum, which tells vowels and consonants apart), each normalised over the take's sung frames.
 */
export function spectral(x: Float32Array, sr: number): Float32Array[] {
  const hop = Math.max(1, Math.round(sr * HOP));
  const n = Math.floor(x.length / hop);
  const down = Math.max(1, Math.round(sr / 16000));
  const dsr = sr / down;
  const N = 512;
  const bands = 26;
  const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
  const hz = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const edges = Array.from({ length: bands + 2 }, (_, i) => hz(mel(100) + ((mel(Math.min(7000, dsr / 2 - 100)) - mel(100)) * i) / (bands + 1)));
  const binOf = (f: number) => (f * N) / dsr;
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const logMel = new Float64Array(bands);
  const C = 13;
  const out = Array.from({ length: C - 1 }, () => new Float32Array(n));
  for (let f = 0; f < n; f++) {
    const centre = f * hop + hop / 2;
    for (let i = 0; i < N; i++) {
      const k = Math.round(centre + (i - N / 2) * down);
      re[i] = (k >= 0 && k < x.length ? x[k] : 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bands; b++) {
      const lo = binOf(edges[b]);
      const mid = binOf(edges[b + 1]);
      const hi = binOf(edges[b + 2]);
      let e = 0;
      for (let k = Math.max(1, Math.floor(lo)); k <= Math.min(N / 2 - 1, Math.ceil(hi)); k++) {
        const w = k < mid ? (k - lo) / Math.max(1e-9, mid - lo) : (hi - k) / Math.max(1e-9, hi - mid);
        if (w > 0) e += w * (re[k] * re[k] + im[k] * im[k]);
      }
      logMel[b] = Math.log(e + 1e-10);
    }
    // the cepstrum (a DCT of the log bands); c0 — the loudness — left out
    for (let c = 1; c < C; c++) {
      let v = 0;
      for (let b = 0; b < bands; b++) v += logMel[b] * Math.cos((Math.PI * c * (b + 0.5)) / bands);
      out[c - 1][f] = v;
    }
  }
  // normalised over the sung frames (the take's own voice and microphone taken out)
  const loud = features(x, sr)[3];
  return out.map((d) => {
    let m = 0;
    let cnt = 0;
    for (let f = 0; f < n; f++)
      if (loud[f] > 0.5) {
        m += d[f];
        cnt++;
      }
    m /= Math.max(1, cnt);
    let v = 0;
    for (let f = 0; f < n; f++) if (loud[f] > 0.5) v += (d[f] - m) ** 2;
    const sd = Math.sqrt(v / Math.max(1, cnt)) || 1;
    return d.map((x2) => (x2 - m) / sd);
  });
}

/**
 * Dynamic time warping within a band around the diagonal: for each frame of `b` (the guide), the frame of `a`
 * (the take) that matches it. Both start at the same song time; `band` frames either way.
 */
export function warpPath(a: Float32Array[], b: Float32Array[], band: number, step = 0.15): Float32Array {
  const na = a[0].length;
  const nb = b[0].length;
  const w = 2 * band + 1;
  const INF = 1e30;
  const D = new Float64Array(na * w).fill(INF);
  const dist = (i: number, j: number) => {
    let s = 0;
    for (let k = 0; k < a.length; k++) s += Math.abs(a[k][i] - b[k][j]) * (k === a.length - 1 ? 2 : 1);
    return s;
  };
  // D[i][j] stored at i*w + (j - i + band)
  const at = (i: number, j: number) => (i < 0 || j < 0 || j - i > band || i - j > band || j >= nb ? INF : D[i * w + (j - i + band)]);
  // `step`: off the diagonal costs a little — no wandering where both are silent
  for (let i = 0; i < na; i++) {
    for (let j = Math.max(0, i - band); j <= Math.min(nb - 1, i + band); j++) {
      const c = dist(i, j);
      const prev = i === 0 && j === 0 ? 0 : Math.min(at(i - 1, j - 1), at(i - 1, j) + step, at(i, j - 1) + step);
      D[i * w + (j - i + band)] = c + prev;
    }
  }
  // back from the end: for each guide frame j, the take frames on the path (their mean)
  const sum = new Float64Array(nb);
  const cnt = new Float64Array(nb);
  let i = na - 1;
  let j = Math.min(nb - 1, na - 1 + band);
  while (j > 0 && at(i, j) >= INF) j--;
  while (i >= 0 && j >= 0) {
    sum[j] += i;
    cnt[j]++;
    if (i === 0 && j === 0) break;
    const d = at(i - 1, j - 1);
    const u = at(i - 1, j) + step;
    const l = at(i, j - 1) + step;
    if (d <= u && d <= l) {
      i--;
      j--;
    } else if (u <= l) i--;
    else j--;
  }
  const src = new Float32Array(nb);
  for (let k = 0; k < nb; k++) src[k] = cnt[k] ? sum[k] / cnt[k] : k;
  // smoothed (a median over 90 ms), and never going back in time
  const out = new Float32Array(nb);
  for (let k = 0; k < nb; k++) {
    const win = [];
    for (let d = -4; d <= 4; d++) win.push(src[Math.max(0, Math.min(nb - 1, k + d))]);
    win.sort((p, q) => p - q);
    out[k] = win[4];
  }
  for (let k = 1; k < nb; k++) out[k] = Math.max(out[k], out[k - 1]);
  return out;
}

/**
 * The audio along a time map (pitch kept): output time t takes the sound at source time srcAt(t). 30 ms
 * windows, each nudged (±4 ms) to continue the previous one smoothly, overlapped and added.
 */
export function warpAudio(x: Float32Array, sr: number, srcAt: (t: number) => number, outLen = x.length): Float32Array {
  const n = Math.max(64, Math.round(sr * 0.03) & ~1);
  const hs = n / 2;
  const tol = Math.round(n / 8);
  const win = Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const out = new Float32Array(outLen + n);
  const norm = new Float32Array(outLen + n);
  let prev = -1;
  for (let k = 0; k * hs < outLen; k++) {
    const o = k * hs;
    const nominal = Math.round(srcAt((o + hs) / sr) * sr) - hs;
    let best = Math.max(0, Math.min(nominal, x.length - n));
    if (prev >= 0 && x.length > n) {
      const target = prev + hs;
      let bestCorr = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const c = nominal + d;
        if (c < 0 || c + n > x.length) continue;
        let corr = 0;
        for (let i = 0; i < n && target + i < x.length; i += 4) corr += x[target + i] * x[c + i];
        if (corr > bestCorr) {
          bestCorr = corr;
          best = c;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      out[o + i] += (x[best + i] ?? 0) * win[i];
      norm[o + i] += win[i];
    }
    prev = best;
  }
  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-3) out[i] /= norm[i];
  return out.slice(0, outLen);
}

/** a time map from its points (out → src, both rising): straight lines between them, outside them a shift */
export function mapFrom(points: { out: number; src: number }[]) {
  const p = [...points].sort((a, b) => a.out - b.out);
  return (t: number) => {
    if (!p.length) return t;
    if (t <= p[0].out) return t - p[0].out + p[0].src;
    for (let k = 1; k < p.length; k++)
      if (t <= p[k].out) {
        const a = p[k - 1];
        const b = p[k];
        return a.src + ((t - a.out) / Math.max(1e-9, b.out - a.out)) * (b.src - a.src);
      }
    const z = p[p.length - 1];
    return t - z.out + z.src;
  };
}

export interface SyncResult {
  samples: Float32Array;
  /** a take to follow a guide: how well the two match (0: not the same words … 1: the same performance) */
  match?: number;
  /** how far the syllables moved, on average (s) */
  moved: number;
  /** how many places it moved (syllables, or 10 ms frames for a guide) */
  count: number;
}

/**
 * A take made to follow a guide take (a double on the Lead). `offset`: where the guide's audio starts,
 * counted from the take's start (s; negative: before it).
 */
export function toGuide(take: Float32Array, guide: Float32Array, sr: number, offset: number, maxShift = 0.3, step = 0.6): SyncResult {
  // the guide on the take's timeline
  const g = new Float32Array(take.length);
  const o = Math.round(offset * sr);
  for (let i = 0; i < take.length; i++) {
    const k = i - o;
    if (k >= 0 && k < guide.length) g[i] = guide[k];
  }
  const fa = features(take, sr);
  const fb = features(g, sr);
  // matched by what is sung (the spectrum's shape) and when it starts (the rise, weighted double: the last)
  const sa = [...spectral(take, sr), fa[4]];
  const sb = [...spectral(g, sr), fb[4]];
  const band = Math.round(maxShift / HOP);
  const path = warpPath(sa, sb, band, step);
  // where the guide sings (in its silences the map is unsure: the take holds still or runs on there)
  const points: { out: number; src: number }[] = [];
  let moved = 0;
  let count = 0;
  let singing = false;
  for (let k = 0; k < path.length; k += 2) {
    // only where both sing: a double that leaves words out has nothing to follow there (it runs on as it is)
    if (fb[3][k] < 0.5 || (fa[3][Math.round(path[k])] ?? -9) < 0.5) {
      singing = false;
      continue;
    }
    // a syllable starting after a gap: pinned 30 ms before too, so its start isn't smeared across the gap
    if (!singing && k * HOP > 0.04) points.push({ out: k * HOP - 0.03, src: path[k] * HOP - 0.03 });
    singing = true;
    points.push({ out: k * HOP, src: path[k] * HOP });
    moved += Math.abs(path[k] - k) * HOP;
    count++;
  }
  // do they say the same thing? how well the path fits, against how well the take fits other words (the guide
  // 3 s on) — warped just as freely
  const fit = (g: Float32Array[], loudG: Float32Array, p: Float32Array) => {
    let sum = 0;
    let pairs = 0;
    for (let k = 0; k < p.length; k += 2) {
      const i = Math.round(p[k]);
      if (loudG[k] < 0.5 || (fa[3][i] ?? -9) < 0.5) continue;
      for (let q = 0; q < sa.length - 1; q++) sum += Math.abs(sa[q][i] - g[q][k]);
      pairs++;
    }
    return pairs < 20 ? null : sum / pairs;
  };
  const roll = Math.round(3 / HOP);
  const rolled = (dim: Float32Array) => dim.map((_, k) => dim[(k + roll) % dim.length]);
  const other = sb.map(rolled);
  const same = fit(sb, fb[3], path);
  const diff = fit(other, rolled(fb[3]), warpPath(sa, other, band, step));
  const match = same === null || diff === null ? 0 : Math.max(0, Math.min(1, 1 - same / Math.max(1e-9, diff)));
  // anchors at both ends: the take keeps its place and length
  const end = take.length / sr;
  // the path holds still through a gap (a syllable starting early waits): steep there is fine
  const map = mapFrom(steady([{ out: 0, src: 0 }, ...points, { out: end, src: end }], 0.05, 8));
  return { samples: warpAudio(take, sr, map), moved: count ? moved / count : 0, count, match };
}

/** keep a map gentle: rising, and never faster than `hi`× or slower than `lo`× between two points */
function steady(points: { out: number; src: number }[], lo = 0.5, hi = 2) {
  const kept = [points[0]];
  for (const p of points.slice(1)) {
    const q = kept[kept.length - 1];
    const dOut = p.out - q.out;
    const dSrc = p.src - q.src;
    if (dOut <= 0) continue;
    const r = dSrc / dOut;
    if (r >= lo && r <= hi) kept.push(p);
  }
  const last = points[points.length - 1];
  if (kept[kept.length - 1] !== last) {
    // the end must stay: drop the points that would make the last stretch too steep
    while (kept.length > 1) {
      const q = kept[kept.length - 1];
      const r = (last.src - q.src) / Math.max(1e-9, last.out - q.out);
      if (r >= lo && r <= hi) break;
      kept.pop();
    }
    kept.push(last);
  }
  return kept;
}

/** where syllables start: sharp rises of loudness, at least 90 ms apart, not in the noise floor (s) */
export function onsets(x: Float32Array, sr: number): number[] {
  const f = features(x, sr);
  const level = f[3];
  const rise = f[4];
  const n = rise.length;
  const mean = rise.reduce((s, v) => s + v, 0) / Math.max(1, n);
  const sd = Math.sqrt(rise.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n));
  const out: number[] = [];
  for (let i = 2; i < n - 2; i++) {
    if (rise[i] < mean + 1.2 * sd) continue;
    let peak = true;
    for (let d = -4; d <= 4; d++) if (d && rise[i + d] > rise[i]) peak = false;
    // a sound has to follow (not a click into silence)
    const after = Math.max(level[i + 1] ?? -9, level[i + 2] ?? -9);
    if (!peak || after < -0.3) continue;
    if (out.length && i * HOP - out[out.length - 1] < 0.09) continue;
    out.push(i * HOP);
  }
  return out;
}

/**
 * The take's syllables onto the beat grid. `start`: the take's place in the song (s); the grid: its first
 * step (s, e.g. bar 1) and its step (s, a 16th = a beat / 4). Each onset within `reach` of a step (as a part
 * of a step) moves `strength` of the way to it.
 */
export function toGrid(take: Float32Array, sr: number, start: number, grid: { origin: number; step: number }, strength = 1, reach = 0.45): SyncResult {
  const on = onsets(take, sr);
  const points: { out: number; src: number }[] = [];
  let moved = 0;
  for (const t of on) {
    const song = start + t;
    const k = Math.round((song - grid.origin) / grid.step);
    const g = grid.origin + k * grid.step;
    const d = g - song;
    if (Math.abs(d) > reach * grid.step) continue;
    const to = t + strength * d;
    points.push({ out: to, src: t });
    moved += Math.abs(strength * d);
  }
  const end = take.length / sr;
  const kept = steady([{ out: 0, src: 0 }, ...points, { out: end, src: end }]);
  const count = kept.length - 2;
  return { samples: warpAudio(take, sr, mapFrom(kept)), moved: points.length ? moved / points.length : 0, count: Math.max(0, count) };
}
