/**
 * Tempo (BPM) and beat-grid detection from raw audio samples.
 *
 * 1. Onset envelope at 100 frames/s from two bands: a low-passed band (kick)
 *    and the full band, as positive changes of log energy.
 * 2. Autocorrelation over 60–200 BPM, reinforced with the double period and a
 *    mild prior around 100 BPM, picks the beat period.
 * 3. A comb search refines the BPM to 0.05 and finds the beat phase; the
 *    downbeat (bar 1) is the beat phase with the strongest kick energy.
 *
 * Pure TypeScript (no Web Audio) so it can run in the browser or in tests.
 */

export interface TempoResult {
  bpm: number;
  /** time in seconds of the first downbeat (bar 1, beat 1) */
  offset: number;
  /** 0..1, how clearly periodic the onsets are */
  confidence: number;
  /** alternative readings, e.g. half/double time */
  alternatives: number[];
}

/** target analysis rate; the exact rate is sampleRate / hop */
const FRAME_RATE = 100;

function onsetEnvelope(x: Float32Array, sr: number) {
  const hop = Math.round(sr / FRAME_RATE);
  const frames = Math.floor(x.length / hop);
  const low = new Float32Array(frames);
  const full = new Float32Array(frames);
  // one-pole low-pass ≈ 150 Hz for the kick band
  const a = Math.exp((-2 * Math.PI * 150) / sr);
  let lp = 0;
  for (let f = 0; f < frames; f++) {
    let eL = 0;
    let eF = 0;
    const end = (f + 1) * hop;
    for (let i = f * hop; i < end; i++) {
      const s = x[i];
      lp = (1 - a) * s + a * lp;
      eL += lp * lp;
      eF += s * s;
    }
    low[f] = Math.log1p(1000 * eL);
    full[f] = Math.log1p(1000 * eF);
  }
  const diff = (e: Float32Array) => {
    const d = new Float32Array(e.length);
    for (let i = 1; i < e.length; i++) d[i] = Math.max(0, e[i] - e[i - 1]);
    return d;
  };
  const dl = diff(low);
  const df = diff(full);
  const mean = (d: Float32Array) => d.reduce((n, v) => n + v, 0) / Math.max(1, d.length) || 1;
  const ml = mean(dl);
  const mf = mean(df);
  const env = new Float32Array(frames);
  for (let i = 0; i < frames; i++) env[i] = dl[i] / ml + 0.6 * (df[i] / mf);
  // subtract a moving average (0.5 s) to keep only peaks
  const w = 25;
  const out = new Float32Array(frames);
  let acc = 0;
  for (let i = 0; i < frames; i++) {
    acc += env[i];
    if (i >= 2 * w + 1) acc -= env[i - 2 * w - 1];
    const n = Math.min(i + 1, 2 * w + 1);
    const c = i - w;
    if (c >= 0) out[c] = Math.max(0, env[c] - acc / n);
  }
  // light smoothing so a period that falls between two frames still correlates
  const sm = new Float32Array(frames);
  const k = [1, 3, 4, 3, 1];
  for (let i = 0; i < frames; i++) {
    let v = 0;
    for (let j = -2; j <= 2; j++) v += (out[i + j] ?? 0) * k[j + 2];
    sm[i] = v / 12;
  }
  return { env: sm, kick: dl, fps: sr / hop };
}

function sampleAt(e: Float32Array, t: number) {
  const i = Math.floor(t);
  if (i < 0 || i + 1 >= e.length) return 0;
  const f = t - i;
  return e[i] * (1 - f) + e[i + 1] * f;
}

/** Best phase and score for a period (in frames) via a comb over the whole track. */
function comb(env: Float32Array, period: number) {
  let best = { phase: 0, score: -1 };
  const steps = Math.ceil(period);
  for (let p = 0; p < steps; p++) {
    let s = 0;
    let n = 0;
    for (let t = p; t < env.length - 1; t += period) {
      s += sampleAt(env, t);
      n++;
    }
    s /= Math.max(1, n);
    if (s > best.score) best = { phase: p, score: s };
  }
  return best;
}

export function detectTempo(samples: Float32Array, sampleRate: number): TempoResult {
  const { env, kick, fps } = onsetEnvelope(samples, sampleRate);
  if (env.length < fps * 4) return { bpm: 0, offset: 0, confidence: 0, alternatives: [] };

  const minLag = Math.floor((60 / 200) * fps);
  const maxLag = Math.ceil((60 / 60) * fps);
  const ac = new Float32Array(2 * maxLag + 2);
  let zero = 0;
  for (let i = 0; i < env.length; i++) zero += env[i] * env[i];
  for (let lag = minLag; lag < ac.length; lag++) {
    let s = 0;
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
    ac[lag] = s / (env.length - lag);
  }
  const prior = (bpm: number) => Math.exp(-0.5 * (Math.log2(bpm / 100) / 1.0) ** 2);
  const scores: { lag: number; score: number }[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    // the half period backs a faster reading, the double period a slower one
    const half = lag % 2 ? (ac[(lag - 1) / 2] + ac[(lag + 1) / 2]) / 2 : ac[lag / 2];
    scores.push({ lag, score: (ac[lag] + 0.5 * ac[2 * lag] + 0.25 * half) * prior(bpm) });
  }
  // local maxima, best first
  const peaks = scores
    .filter((s, i) => i > 0 && i < scores.length - 1 && s.score >= scores[i - 1].score && s.score >= scores[i + 1].score)
    .sort((a, b) => b.score - a.score);
  if (!peaks.length) return { bpm: 0, offset: 0, confidence: 0, alternatives: [] };

  // the autocorrelation decides the tempo octave; when the double tempo is almost as strong,
  // prefer it (128 rather than 64) — the UI offers ×2 / ÷2 for the other reading
  let top = peaks[0];
  const dbl = peaks.find((p) => Math.abs(p.lag * 2 - top.lag) <= 2);
  if (dbl && dbl.score >= 0.8 * top.score && (60 * fps) / dbl.lag <= 165) top = dbl;
  let best = { bpm: 0, phase: 0, score: -1 };
  const center = (60 * fps) / top.lag;
  for (let bpm = center * 0.97; bpm <= center * 1.03; bpm += 0.05) {
    const c = comb(env, (60 * fps) / bpm);
    if (c.score > best.score) best = { bpm, phase: c.phase, score: c.score };
  }

  let bpm = Math.round(best.bpm * 10) / 10;
  if (Math.abs(bpm - Math.round(bpm)) <= 0.3) bpm = Math.round(bpm);
  const period = (60 * fps) / bpm;
  const beat = comb(env, period);

  // downbeat: of the 4 beat positions in a bar, the one with the most kick energy
  let down = { k: 0, e: -1 };
  for (let k = 0; k < 4; k++) {
    let e = 0;
    for (let t = beat.phase + k * period; t < kick.length - 1; t += 4 * period) e += sampleAt(kick, t);
    if (e > down.e) down = { k, e };
  }
  let offset = (beat.phase + down.k * period) / fps;
  const barLen = (4 * 60) / bpm;
  while (offset - barLen >= -0.02) offset -= barLen;
  offset = Math.max(0, offset);

  const meanAc = scores.reduce((n, s) => n + s.score, 0) / scores.length;
  const confidence = Math.max(0, Math.min(1, (peaks[0].score - meanAc) / (zero / env.length || 1)));
  const alternatives = [bpm / 2, bpm * 2].filter((b) => b >= 50 && b <= 220).map((b) => Math.round(b * 10) / 10);
  return { bpm, offset: Math.round(offset * 1000) / 1000, confidence, alternatives };
}

/** Peak amplitudes for drawing a waveform. */
export function waveformPeaks(samples: Float32Array, buckets: number): number[] {
  const size = Math.max(1, Math.floor(samples.length / buckets));
  const out: number[] = [];
  let max = 0;
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    const end = Math.min(samples.length, (b + 1) * size);
    for (let i = b * size; i < end; i += 4) m = Math.max(m, Math.abs(samples[i]));
    out.push(m);
    max = Math.max(max, m);
  }
  return out.map((v) => (max ? v / max : 0));
}

/** Bar/beat position (1-based) at a time, given the grid. */
export function barAt(time: number, bpm: number, offset: number, beatsPerBar = 4) {
  if (!bpm) return null;
  const beatLen = 60 / bpm;
  const beats = Math.floor((time - offset) / beatLen + 1e-6);
  return { bar: Math.floor(beats / beatsPerBar) + 1, beat: (((beats % beatsPerBar) + beatsPerBar) % beatsPerBar) + 1 };
}

/** Snap a time to the nearest bar line of the grid. */
export function snapToBar(time: number, bpm: number, offset: number, beatsPerBar = 4) {
  if (!bpm) return time;
  const barLen = (beatsPerBar * 60) / bpm;
  return Math.max(0, offset + Math.round((time - offset) / barLen) * barLen);
}
