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

/** the level (RMS) of a stretch of a take, song time [t0, t1) */
function levelAt(x: TakeAudio, t0: number, t1: number) {
  const a = Math.max(0, Math.floor((t0 - x.at) * x.sampleRate));
  const b = Math.min(x.samples.length, Math.floor((t1 - x.at) * x.sampleRate));
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += x.samples[i] * x.samples[i];
  return Math.sqrt(s / (b - a));
}

/**
 * Where a continued take really joins: the planned joint (after the last word, or a line's start) — or earlier,
 * when the new piece's voice comes in before it (a pickup, coming in early): then just before that voice, so its
 * first syllables aren't cut. Never into the take so far's last word, and never from the take so far heard
 * through the speakers (the search starts once its voice has stopped). Pure.
 */
export function findJoint(before: TakeAudio, after: TakeAudio, joint: number, frame = 0.02): number {
  const end = (x: TakeAudio) => x.at + x.samples.length / x.sampleRate;
  // the take so far: where its voice stops before the joint (its words up to there)
  const bFrom = Math.max(before.at, joint - 8);
  let bPeak = 0;
  for (let t = bFrom; t < joint; t += frame) bPeak = Math.max(bPeak, levelAt(before, t, t + frame));
  let voiceEnd = Math.max(before.at, joint - 4);
  if (bPeak > 0)
    for (let t = Math.min(joint, end(before)) - frame; t >= joint - 4; t -= frame)
      if (levelAt(before, t, t + frame) > bPeak * 0.12) {
        voiceEnd = t + frame;
        break;
      }
  // the new piece: its voice's level, and its quiet before it (the noise floor)
  const from = Math.max(after.at, voiceEnd + 0.05);
  if (from >= joint - 0.03) return joint;
  const frames: number[] = [];
  for (let t = from; t < Math.min(end(after), joint + 4); t += frame) frames.push(levelAt(after, t, t + frame));
  if (!frames.length) return joint;
  const peak = Math.max(...frames);
  const floor = [...frames].sort((p, q) => p - q)[Math.floor(frames.length * 0.2)] ?? 0;
  const thr = Math.max(peak * 0.1, floor * 3, 0.003);
  const onset = frames.findIndex((v) => v > thr);
  if (onset < 0) return joint;
  const at = from + onset * frame;
  if (at >= joint - 0.03) return joint;
  return Math.max(voiceEnd + 0.03, at - 0.08);
}
