import { prosody } from "@/lib/rhyme/prosody";
import type { LineFlow } from "@/lib/types";

/**
 * The guide voice: a line spoken in the writer's cloned voice, cut into
 * words and laid onto the flow they sang — every word starts on the sung
 * syllable it falls on and is stretched (pitch kept) to fit.
 *
 * Pure TypeScript: runs on the phone, and in tests.
 */

export interface SpokenWord {
  text: string;
  /** seconds in the spoken audio */
  start: number;
  end: number;
}

export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** character timings (from the speech service) → words */
export function wordsFromAlignment(a: Alignment): SpokenWord[] {
  const out: SpokenWord[] = [];
  let cur: SpokenWord | null = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      cur = null;
      return;
    }
    if (!cur) {
      cur = { text: "", start: a.character_start_times_seconds[i], end: a.character_end_times_seconds[i] };
      out.push(cur);
    }
    cur.text += ch;
    cur.end = a.character_end_times_seconds[i];
  });
  return out;
}

/** where the line's syllables are sung (song time) and where its singing ends */
export interface Slots {
  times: number[];
  end: number;
}

export function lineSlots(
  line: { text: string; audio_at: number | null; flow: LineFlow | null },
  nextAt: number | null,
  lang: string,
): Slots | null {
  const f = line.flow;
  if (f?.times && f.times.length >= 2) {
    const last = f.times[f.times.length - 1];
    return { times: f.times, end: Math.max(last + 0.12, f.end ?? last + (f.held ? 0.6 : 0.3)) };
  }
  if (line.audio_at === null) return null;
  // no recorded timing: the syllables evenly from the line's start, at a rap pace (≤ 0.3 s each)
  const n = Math.max(1, f?.syllables ?? prosody(line.text, lang).syllables);
  const room = (nextAt ?? line.audio_at + 3) - 0.2 - line.audio_at;
  const each = Math.max(0.1, Math.min(0.3, room / n));
  return { times: Array.from({ length: n }, (_, i) => line.audio_at! + i * each), end: line.audio_at + n * each };
}

export interface WordPlan {
  /** the word in the spoken audio (s) */
  from: number;
  to: number;
  /** where it starts in the song and how long it may last (s) */
  at: number;
  dur: number;
}

/**
 * Every word starts on the sung syllable it falls on: the line's syllables
 * (counted per word) are spread over the sung ones, so a line with more or
 * fewer syllables than the flow still starts and ends with it.
 */
export function planLine(words: SpokenWord[], lang: string, slots: Slots): WordPlan[] {
  const counts = words.map((w) => prosody(w.text, lang).syllables);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return [];
  const m = slots.times.length;
  const t = (i: number) => (i < m ? slots.times[i] : slots.end);
  const slot = (k: number) => {
    const x = (k * m) / total;
    const i = Math.floor(x);
    return i >= m ? slots.end : t(i) + (x - i) * (t(i + 1) - t(i));
  };
  const out: WordPlan[] = [];
  let k = 0;
  words.forEach((w, i) => {
    if (!counts[i]) return; // punctuation only
    const at = slot(k);
    k += counts[i];
    out.push({ from: w.start, to: w.end, at, dur: Math.max(0.06, slot(k) - at) });
  });
  return out;
}

/**
 * Time stretch with the pitch kept (WSOLA): overlapping 30 ms windows are
 * taken from the source at the stretched rate, each nudged to where it
 * continues the previous one most smoothly. ratio 1.5 = 50% longer.
 */
export function timeStretch(x: Float32Array, ratio: number, sr: number): Float32Array {
  const outLen = Math.max(1, Math.round(x.length * ratio));
  const n = Math.max(64, Math.round(sr * 0.03) & ~1);
  if (Math.abs(ratio - 1) < 0.03 || x.length < 2 * n) {
    if (outLen <= x.length) return x.slice(0, outLen);
    const y = new Float32Array(outLen);
    y.set(x);
    return y;
  }
  const hs = n / 2;
  const ha = hs / ratio;
  const tol = Math.round(n / 8);
  const win = Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const out = new Float32Array(outLen + n);
  const norm = new Float32Array(outLen + n);
  let prev = -1;
  for (let k = 0; k * hs < outLen; k++) {
    const nominal = Math.round(k * ha);
    let best = Math.min(nominal, x.length - n);
    if (best < 0) break;
    if (prev >= 0) {
      const target = prev + hs; // the natural continuation of the previous window
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
    const o = k * hs;
    for (let i = 0; i < n; i++) {
      out[o + i] += x[best + i] * win[i];
      norm[o + i] += win[i];
    }
    prev = best;
  }
  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-3) out[i] /= norm[i];
  return out.subarray(0, outLen);
}

/**
 * The line in the guide voice, laid on the flow: a mono buffer starting at
 * song time `origin` (returned). Words are stretched within 0.6–1.4× (the
 * last one up to 1.8× for a held note); a word never runs into the next.
 */
export function renderLine(src: Float32Array, sr: number, plan: WordPlan[]): { samples: Float32Array; origin: number } {
  if (!plan.length) return { samples: new Float32Array(0), origin: 0 };
  const origin = Math.max(0, plan[0].at - 0.05);
  const last = plan[plan.length - 1];
  const out = new Float32Array(Math.ceil((last.at + last.dur * 1.2 + 0.6 - origin) * sr));
  plan.forEach((w, i) => {
    const a = Math.max(0, Math.round((w.from - 0.01) * sr));
    const b = Math.min(src.length, Math.round((w.to + 0.03) * sr));
    if (b - a < 16) return;
    const seg = src.subarray(a, b);
    const isLast = i === plan.length - 1;
    const ratio = Math.max(0.6, Math.min(isLast ? 1.8 : 1.4, w.dur / (seg.length / sr)));
    const y = timeStretch(seg, ratio, sr);
    const start = Math.round((w.at - origin) * sr);
    // room until the next word starts
    const room = isLast ? out.length - start : Math.max(0, Math.round((plan[i + 1].at - origin) * sr) - start);
    const len = Math.min(y.length, room, out.length - start);
    const fadeIn = Math.min(len, Math.round(sr * 0.004));
    const fadeOut = Math.min(len, Math.round(sr * 0.012));
    for (let j = 0; j < len; j++) {
      const g = Math.min(1, j / Math.max(1, fadeIn), (len - j) / Math.max(1, fadeOut));
      out[start + j] += y[j] * g;
    }
  });
  return { samples: out, origin };
}
