/**
 * A take recorded in pieces ("Continue"): the take so far up to the joint, then the new piece from it — one
 * take, as if sung in one go. At the joint the two cross over in a few milliseconds (no click). Pure: runs in
 * the browser and in tests.
 */

export interface TakeAudio {
  samples: Float32Array;
  sampleRate: number;
  /** song position of samples[0] (s) */
  at: number;
  /** a cut take: only this part plays (seconds of the take; to null: its end) */
  clip?: { from: number; to: number | null };
}

/** a signal at another sample rate (linear: a phone and a USB microphone may differ) */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const r = from / to;
  const y = new Float32Array(Math.floor(x.length / r));
  for (let i = 0; i < y.length; i++) {
    const p = i * r;
    const k = Math.floor(p);
    const a = x[k] ?? 0;
    y[i] = a + ((x[k + 1] ?? a) - a) * (p - k);
  }
  return y;
}

/**
 * `before` up to `joint` (song time, s), `after` from it on. The result starts where `before` starts to play
 * (its cut kept) — or where `after` starts, if that is earlier — and ends with `after`.
 */
export function joinTakes(before: TakeAudio, after: TakeAudio, joint: number, fade = 0.02): TakeAudio {
  const sr = before.sampleRate;
  const b = resample(after.samples, after.sampleRate, sr);
  const aFrom = before.at + Math.max(0, before.clip?.from ?? 0);
  const aTo = before.at + Math.min(before.samples.length / sr, before.clip?.to ?? Infinity);
  const start = Math.min(aFrom, after.at);
  const end = after.at + b.length / sr;
  const out = new Float32Array(Math.max(0, Math.ceil((end - start) * sr)));
  const half = fade / 2;
  for (let i = 0; i < out.length; i++) {
    const t = start + i / sr;
    // how much of the piece is heard: none before the joint, all after it, crossing over around it
    const w = t <= joint - half ? 0 : t >= joint + half ? 1 : (t - (joint - half)) / fade;
    let v = 0;
    if (w < 1 && t >= aFrom && t < aTo) v += (1 - w) * (before.samples[Math.floor((t - before.at) * sr)] ?? 0);
    if (w > 0 && t >= after.at) v += w * (b[Math.floor((t - after.at) * sr)] ?? 0);
    out[i] = v;
  }
  return { samples: out, sampleRate: sr, at: start };
}

/** "3 parts": how many pieces a take was recorded in (from its note) */
export const partsOf = (note: string | null | undefined) => Number(/(\d+) parts/.exec(note ?? "")?.[1] ?? 1);
