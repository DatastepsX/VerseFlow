/**
 * Syllables in a sung / rapped flow take (voice only, recorded over the
 * beat with headphones). Every syllable has a vowel = a burst of energy, so
 * syllables are the peaks of the voice's energy envelope that stand out from
 * the dip before them. Works the same for real words and for "na-na".
 *
 * Pure TypeScript: runs on the phone right after recording, and in tests.
 */

export interface Syllable {
  /** seconds from the start of the recording */
  t: number;
  /** 0..1, loudness relative to the loudest syllable around it (stress) */
  strength: number;
  /** how long the syllable is held (s) */
  dur: number;
}

const FRAME = 0.01; // 10 ms

export function energyEnvelope(samples: Float32Array, sampleRate: number) {
  const hop = Math.max(1, Math.round(sampleRate * FRAME));
  const frames = Math.floor(samples.length / hop);
  const env = new Float32Array(frames);
  // one-pole high-pass (~100 Hz): breath and rumble don't make syllables
  const a = Math.exp((-2 * Math.PI * 100) / sampleRate);
  let prevIn = 0;
  let prevOut = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const y = a * (prevOut + samples[i] - prevIn);
      prevIn = samples[i];
      prevOut = y;
      e += y * y;
    }
    env[f] = Math.sqrt(e / hop);
  }
  // smooth over ~50 ms: one bump per vowel
  const sm = new Float32Array(frames);
  const k = 2;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    let n = 0;
    for (let j = -k; j <= k; j++) {
      const v = env[f + j];
      if (v !== undefined) {
        s += v * (k + 1 - Math.abs(j));
        n += k + 1 - Math.abs(j);
      }
    }
    sm[f] = s / n;
  }
  return sm;
}

export function detectSyllables(samples: Float32Array, sampleRate: number): Syllable[] {
  const env = energyEnvelope(samples, sampleRate);
  const n = env.length;
  if (n < 10) return [];
  const sorted = Float32Array.from(env).sort();
  const noise = sorted[Math.floor(n * 0.15)];
  const loud = sorted[Math.floor(n * 0.98)] || 1e-9;
  // voiced: clearly above the noise floor (or 4 % of the loud level, whichever is higher)
  const floor = Math.max(noise * 3, loud * 0.04);
  const minGap = Math.round(0.075 / FRAME); // ~13 syllables / s at most
  const peaks: { f: number; v: number }[] = [];
  let valley = Infinity;
  for (let f = 1; f < n - 1; f++) {
    const v = env[f];
    valley = Math.min(valley, v);
    if (v < floor || v < env[f - 1] || v < env[f + 1]) continue;
    const last = peaks[peaks.length - 1];
    // a new syllable needs a dip of ~25 % (≈ 2.5 dB) since the previous one
    const dipped = !last || valley < Math.min(v, last.v) * 0.75;
    if (last && (f - last.f < minGap || !dipped)) {
      if (v > last.v && f - last.f < minGap) peaks[peaks.length - 1] = { f, v };
      continue;
    }
    peaks.push({ f, v });
    valley = v;
  }
  return peaks.map((p, i) => {
    // the syllable starts where its energy rises through half of the peak (its onset, what lands on the beat)
    const prev = peaks[i - 1]?.f ?? -1;
    let o = p.f;
    while (o - 1 > prev && env[o - 1] > p.v * 0.5) o--;
    // held until the energy falls to 35 % of the peak (or the next syllable)
    const next = peaks[i + 1]?.f ?? n;
    let e = p.f;
    while (e < next && env[e] > p.v * 0.35) e++;
    // stress: relative to the loudest syllable within ±1 s
    let around = 0;
    for (const q of peaks) if (Math.abs(q.f - p.f) <= 100) around = Math.max(around, q.v);
    return { t: Math.round(o * FRAME * 1000) / 1000, strength: Math.round((p.v / (around || p.v)) * 100) / 100, dur: Math.round((e - o) * FRAME * 100) / 100 };
  });
}
