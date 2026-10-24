/**
 * Pitch work on a recorded take (pure TypeScript: in the browser and in
 * tests): autotune — every sung note pulled to the nearest note of the
 * song's key, instantly (the hard, robotic trap sound) or gently — and the
 * whole voice up / down. The pitch is found with YIN, the voice is
 * re-pitched with TD-PSOLA (grains one period long, laid out at the new
 * period), so it keeps its length and its timbre (formants).
 */

export interface MusicKey {
  /** 0 = C … 11 = B */
  root: number;
  minor: boolean;
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
export const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
export const keyName = (k: MusicKey | null) => (k ? `${NOTE_NAMES[k.root]} ${k.minor ? "minor" : "major"}` : "Chromatic");

/** hop of the pitch track (s) */
const HOP = 0.005;
const FMIN = 70;
const FMAX = 900;

/**
 * The pitch of a voice every 5 ms (Hz, 0 = no pitch: silence, breath,
 * consonants). Works on a 12 kHz copy — plenty for a voice and fast.
 */
export function detectPitch(x: Float32Array, sr: number): { f0: Float32Array; hop: number } {
  const down = Math.max(1, Math.round(sr / 12000));
  const dsr = sr / down;
  const n = Math.floor(x.length / down);
  const d = new Float32Array(n);
  // a little low-pass (mean of `down` samples) before taking every down-th
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < down; k++) s += x[i * down + k];
    d[i] = s / down;
  }
  const hop = Math.round(HOP * dsr);
  const W = Math.round(0.025 * dsr);
  const tauMin = Math.floor(dsr / FMAX);
  const tauMax = Math.ceil(dsr / FMIN);
  const frames = Math.max(0, Math.floor((n - W - tauMax) / hop));
  const f0 = new Float32Array(Math.ceil(x.length / (HOP * sr)) + 1);
  // loudness gate: quieter than 1/30 of the take's loud parts = no note
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  const gate = Math.max(0.004, peak / 30);
  const diff = new Float32Array(tauMax + 1);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    let rms = 0;
    for (let j = 0; j < W; j++) rms = Math.max(rms, Math.abs(d[o + j]));
    if (rms < gate) continue;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const v = d[o + j] - d[o + j + tau];
        s += v * v;
      }
      diff[tau] = s;
    }
    // cumulative mean normalised difference; the first dip under the threshold is the period
    let run = 0;
    let best = -1;
    let bestVal = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      run += diff[tau];
      const v = run > 0 ? (diff[tau] * tau) / run : 1;
      diff[tau] = v;
    }
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (diff[tau] < 0.15) {
        while (tau + 1 <= tauMax && diff[tau + 1] < diff[tau]) tau++;
        best = tau;
        bestVal = diff[tau];
        break;
      }
    }
    if (best < 0 || bestVal > 0.3) continue;
    // parabolic interpolation around the dip
    const a = diff[best - 1] ?? diff[best];
    const b = diff[best];
    const c = diff[best + 1] ?? diff[best];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
    const t = (o + W / 2) / dsr;
    const k = Math.round(t / HOP);
    if (k < f0.length) f0[k] = dsr / (best + Math.max(-0.5, Math.min(0.5, shift)));
  }
  // fill the hop grid (frames are `hop` apart in the 12 kHz copy ≈ 5 ms) and clean it
  return { f0: clean(f0), hop: HOP };
}

/** median of 5 (octave jumps out), single frames filled, islands under 30 ms dropped */
function clean(f0: Float32Array) {
  const out = new Float32Array(f0.length);
  for (let i = 0; i < f0.length; i++) {
    if (!f0[i]) {
      // a one-frame gap between two pitched frames
      if (f0[i - 1] && f0[i + 1]) out[i] = (f0[i - 1] + f0[i + 1]) / 2;
      continue;
    }
    const w = [f0[i - 2], f0[i - 1], f0[i], f0[i + 1], f0[i + 2]].filter((v) => v > 0).sort((p, q) => p - q);
    out[i] = w[Math.floor(w.length / 2)];
  }
  for (let i = 0; i < out.length; ) {
    if (!out[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j]) j++;
    if (j - i < 6) out.fill(0, i, j);
    i = j;
  }
  return out;
}

const midiOf = (f: number) => 69 + 12 * Math.log2(f / 440);

/** the nearest note of the key (chromatic: any semitone) */
export function snap(midi: number, key: MusicKey | null): number {
  const r = Math.round(midi);
  if (!key) return r;
  const scale = key.minor ? MINOR : MAJOR;
  let best = r;
  let dist = Infinity;
  for (let c = r - 2; c <= r + 2; c++) {
    const pc = (((c - key.root) % 12) + 12) % 12;
    if (scale.includes(pc) && Math.abs(c - midi) < dist) {
      dist = Math.abs(c - midi);
      best = c;
    }
  }
  return best;
}

/**
 * The new pitch ratio every 5 ms: autotune (`speed` 0 = instant and flat,
 * up to 1 = slow and loose: slides between notes, some vibrato left) and / or
 * a shift in semitones.
 */
export function pitchRatios(f0: Float32Array, opts: { key: MusicKey | null; speed?: number; tune?: boolean; shift?: number }): Float32Array {
  const ratio = new Float32Array(f0.length).fill(1);
  const speed = Math.max(0, Math.min(1, opts.speed ?? 0));
  // how fast a new note is reached: hard = at once, gentle = ~120 ms
  const alpha = speed === 0 ? 1 : 1 - Math.exp(-HOP / (speed * 0.12));
  let held = 0;
  for (let i = 0; i < f0.length; i++) {
    if (!f0[i]) {
      held = 0;
      continue;
    }
    const m = midiOf(f0[i]);
    let out = m;
    if (opts.tune) {
      const target = snap(m, opts.key);
      held = held ? held + (target - held) * alpha : target;
      // gentle: some of the singer's own movement stays
      out = held + (m - target) * speed * 0.5;
    }
    out += opts.shift ?? 0;
    ratio[i] = Math.pow(2, Math.max(-12, Math.min(12, out - m)) / 12);
  }
  return ratio;
}

/**
 * TD-PSOLA: the voice cut into grains two periods long around each pitch
 * mark (aligned to the waveform's peaks), laid out again `period / ratio`
 * apart. Unpitched parts pass unchanged. Same length as the input.
 */
export function psola(x: Float32Array, sr: number, f0: Float32Array, hop: number, ratio: Float32Array): Float32Array {
  const n = x.length;
  const at = (i: number) => Math.min(f0.length - 1, Math.max(0, Math.round(i / sr / hop)));
  // analysis marks: a period apart where there is a pitch, 5 ms apart where there isn't
  const marks: { pos: number; T: number; r: number }[] = [];
  const unvoiced = Math.round(0.005 * sr);
  let pos = 0;
  let prevVoiced = false;
  while (pos < n) {
    const k = at(pos);
    const f = f0[k];
    if (f > 0) {
      const T = Math.round(sr / f);
      // on the period's peak, so the grains line up
      const reach = prevVoiced ? Math.round(T / 4) : Math.round(T / 2);
      let best = pos;
      for (let i = Math.max(0, pos - reach); i < Math.min(n, pos + reach); i++) if (x[i] > x[best]) best = i;
      if (marks.length && best <= marks[marks.length - 1].pos) best = marks[marks.length - 1].pos + Math.round(T / 2);
      marks.push({ pos: best, T, r: ratio[k] });
      pos = best + T;
      prevVoiced = true;
    } else {
      marks.push({ pos, T: unvoiced, r: 1 });
      pos += unvoiced;
      prevVoiced = false;
    }
  }
  const y = new Float32Array(n);
  const wsum = new Float32Array(n);
  // synthesis: grains of the nearest analysis mark, spaced by the new period
  let t = marks[0]?.pos ?? 0;
  let m = 0;
  while (t < n && marks.length) {
    while (m + 1 < marks.length && Math.abs(marks[m + 1].pos - t) <= Math.abs(marks[m].pos - t)) m++;
    const mk = marks[m];
    const T = mk.T;
    for (let j = -T; j < T; j++) {
      const src = mk.pos + j;
      const dst = Math.round(t) + j;
      if (src < 0 || src >= n || dst < 0 || dst >= n) continue;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * j) / T);
      y[dst] += x[src] * w;
      wsum[dst] += w;
    }
    t += Math.max(8, T / mk.r);
  }
  for (let i = 0; i < n; i++) y[i] = wsum[i] > 0.05 ? y[i] / wsum[i] : 0;
  return y;
}

/** autotune and / or shift a take; nothing to do → the same samples */
export function retune(x: Float32Array, sr: number, opts: { key: MusicKey | null; speed?: number; tune?: boolean; shift?: number }): Float32Array {
  if (!opts.tune && !opts.shift) return x;
  const { f0, hop } = detectPitch(x, sr);
  return psola(x, sr, f0, hop, pitchRatios(f0, opts));
}
