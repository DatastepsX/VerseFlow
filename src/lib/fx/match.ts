import { fft } from "@/lib/audio/structure";
import type { FxCategory, FxPreset } from "./presets";
import { detectPitch } from "./tune";

/**
 * A sound from a voice: a recording of a voice with its effects (a song's vocals, a file, a take) is measured
 * and the effect chain that sounds like it is estimated — its tone (EQ, against a dry voice: your own take when
 * there is one), how compressed it is, its reverb (how the voice dies away after a phrase), echoes on the tempo,
 * its width and whether it is autotuned. The result is an ordinary preset (`FxPreset`) with a name and what was
 * found. Pure: runs in the browser and in tests; no AI call.
 */

export interface SoundMatch {
  preset: FxPreset;
  /** what was found, one line each ("Reverb: 1.8 s, 22 %") */
  found: string[];
}

/** band centres (Hz), about 2/3 of an octave apart */
const BANDS = [60, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 14000];
/** a typical dry, close-miked voice: its average spectrum per band (dB, 400–1000 Hz = 0) — used without a take of your own */
const DRY_VOICE = [-14, -8, -4, -1, 0, 0, -1, -3, -5, -7, -10, -14, -20];

const db = (v: number) => 10 * Math.log10(Math.max(1e-12, v));
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const round = (v: number, step = 1) => Number((Math.round(v / step) * step).toFixed(3));
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

export const monoOf = (channels: Float32Array[]) => {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] += c[i] / channels.length;
  return out;
};

/** short-term level (dB) every `hop` seconds */
function envelope(x: Float32Array, sr: number, hop = 0.01) {
  const h = Math.max(1, Math.round(hop * sr));
  const out = new Float32Array(Math.floor(x.length / h));
  for (let k = 0; k < out.length; k++) {
    let s = 0;
    for (let i = k * h; i < (k + 1) * h; i++) s += x[i] * x[i];
    out[k] = db(s / h);
  }
  return out;
}

/** the frames where the voice sings: within 20 dB of its loud parts */
function loudFrames(env: Float32Array) {
  const sorted = [...env].sort((a, b) => a - b);
  const top = pct(sorted, 0.95);
  return { top, loud: (v: number) => v > top - 20 };
}

/** average spectrum per band (dB, normalised: 400–1000 Hz = 0), over the frames where the voice sings */
export function bandLevels(x: Float32Array, sr: number): number[] {
  const N = 2048;
  const hop = 1024;
  const env = envelope(x, sr, hop / sr);
  const { loud } = loudFrames(env);
  const acc = new Float64Array(BANDS.length);
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  let frames = 0;
  for (let k = 0; (k + 1) * hop + N <= x.length && k < env.length; k++) {
    if (!loud(env[k])) continue;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[k * hop + i] * win[i];
    fft(re, im);
    for (let b = 0; b < BANDS.length; b++) {
      const lo = Math.max(1, Math.floor((BANDS[b] / 1.26 / sr) * N));
      const hi = Math.min(N / 2, Math.ceil((BANDS[b] * 1.26 * N) / sr));
      let s = 0;
      for (let i = lo; i <= hi; i++) s += re[i] * re[i] + im[i] * im[i];
      acc[b] += s / Math.max(1, hi - lo + 1);
    }
    frames++;
  }
  const out = Array.from(acc, (v) => db(v / Math.max(1, frames)));
  const mid = (out[4] + out[5] + out[6]) / 3;
  return out.map((v) => v - mid);
}

/** how much the level moves while singing (dB, the 90th − 20th percentile of 50 ms levels): less = more compressed */
export function dynamicRange(x: Float32Array, sr: number) {
  const env = envelope(x, sr, 0.05);
  const { loud } = loudFrames(env);
  const sung = [...env].filter(loud).sort((a, b) => a - b);
  return sung.length < 8 ? 18 : pct(sung, 0.9) - pct(sung, 0.2);
}

/**
 * Where phrases end (10 ms frames): `peak` — the last loud moment of the phrase, `stop` — where the voice itself
 * stops (the last frame within `voice` dB of the peak), followed by at least 300 ms where it never comes back
 * that loud (what rings on there is reverb or echo). Short gaps between syllables don't count.
 */
function phraseEnds(env: Float32Array, voice = 6) {
  const { top } = loudFrames(env);
  const out: { peak: number; stop: number }[] = [];
  for (let i = 0; i + 75 < env.length; i++) {
    if (env[i] < top - 12) continue;
    // the voice's last frame near this level within the next 250 ms
    let stop = i;
    for (let k = i + 1; k <= i + 25; k++) if (env[k] >= env[i] - voice) stop = k;
    // then quiet for 300 ms: never back within `voice` dB, and never louder than this phrase
    let quiet = true;
    for (let k = stop + 1; k <= stop + 30 && quiet; k++) if (env[k] >= env[i] - voice) quiet = false;
    if (!quiet) continue;
    // the last loud moment: the peak just before the stop
    let peak = stop;
    for (let k = Math.max(0, stop - 25); k <= stop; k++) if (env[k] > env[peak]) peak = k;
    out.push({ peak, stop });
    i = stop + 30;
  }
  return out;
}

/**
 * How the voice dies away where a phrase ends: the decay rate (dB/s, its median over the phrase ends — a dry
 * voice stops almost at once, reverb rings on) and how loud the ringing is 150 ms after the voice stops
 * (dB under the phrase).
 */
export function tails(x: Float32Array, sr: number) {
  const env = envelope(x, sr, 0.01);
  const floor = pct([...env].sort((a, b) => a - b), 0.05);
  const slopes: number[] = [];
  const rings: number[] = [];
  for (const { peak, stop } of phraseEnds(env)) {
    // the decay from 30 to 250 ms after the voice stops, above the noise floor — on its lowest level so far,
    // so echoes coming back on top of it don't hide how the reverb dies away
    const pts: [number, number][] = [];
    let low = env[stop];
    for (let k = stop + 1; k <= Math.min(stop + 25, env.length - 1); k++) {
      low = Math.min(low, env[k]);
      if (k >= stop + 3 && low > floor + 6) pts.push([k * 0.01, low]);
    }
    if (pts.length >= 8) {
      const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      slopes.push(pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / Math.max(1e-9, pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0)));
    } else slopes.push(-600);
    rings.push(Math.max(floor, env[Math.min(env.length - 1, stop + 15)]) - env[peak]);
  }
  if (!slopes.length) return null;
  const med = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];
  return { decay: med(slopes), ring: med(rings), count: slopes.length };
}

/**
 * Echoes: after a phrase ends, the phrase coming back softer — its last half second of level, found again in
 * what rings on after it (the distance where the pattern matches best, s), how loud it comes back (dB under the
 * phrase) and whether it repeats. Null: none heard.
 */
export function echoes(x: Float32Array, sr: number) {
  const env = envelope(x, sr, 0.01);
  const lin = Array.from(env, (v) => 10 ** (v / 20));
  const lags: number[] = [];
  const levels: number[] = [];
  const seconds: boolean[] = [];
  for (const { peak, stop } of phraseEnds(env, 4)) {
    // the phrase's last 500 ms, as a pattern (its mean taken off)
    const a = Math.max(0, stop - 50);
    const src = lin.slice(a, stop + 1);
    const ms = src.reduce((p, v) => p + v, 0) / src.length;
    const pat = src.map((v) => v - ms);
    const norm = Math.sqrt(pat.reduce((p, v) => p + v * v, 0)) || 1;
    // slid over what follows the stop: the shift where it comes back best (100 ms … 1.1 s)
    const scored: { lag: number; score: number }[] = [];
    for (let L = 10; L <= 110; L++) {
      if (a + L + pat.length >= lin.length) break;
      // only what rings on after the voice stopped is compared (the pattern's part that lands there)
      const ks = pat.map((_, k) => k).filter((k) => a + L + k > stop);
      if (ks.length < 15) continue;
      const p0 = ks.reduce((p, k) => p + pat[k], 0) / ks.length;
      const v0 = ks.reduce((p, k) => p + lin[a + L + k], 0) / ks.length;
      let c = 0;
      let n1 = 0;
      let n2 = 0;
      for (const k of ks) {
        const u = pat[k] - p0;
        const v = lin[a + L + k] - v0;
        c += u * v;
        n1 += u * u;
        n2 += v * v;
      }
      scored.push({ lag: L, score: c / (Math.sqrt(n1 * n2) || 1) });
    }
    if (!scored.length) continue;
    const top = Math.max(...scored.map((x) => x.score));
    if (top < 0.6) continue;
    // the shortest distance that matches about as well (an echo's second repeat matches too)
    const best = scored.find((x) => x.score >= top - 0.06)!;
    const scores = scored.map((x) => x.score);
    const sorted = [...scores].sort((p, q) => p - q);
    if (top - sorted[Math.floor(sorted.length / 2)] < 0.25) continue;
    lags.push(best.lag * 0.01);
    // how loud it comes back: the matched stretch against the phrase
    const back = Math.max(...lin.slice(stop + 1, Math.min(lin.length, a + best.lag + pat.length)));
    levels.push(20 * Math.log10(Math.max(1e-6, back) / Math.max(1e-6, lin[peak])));
    const k2 = stop + best.lag;
    seconds.push(k2 + 5 < env.length && env[k2] > env[peak] - 30);
  }
  if (lags.length < 2) return null;
  // the distance most of them share (within 30 ms)
  const sorted = [...lags].sort((a, b) => a - b);
  let bestAt = 0;
  let bestN = 0;
  for (const l of sorted) {
    const n = sorted.filter((m) => Math.abs(m - l) <= 0.03).length;
    if (n > bestN) [bestAt, bestN] = [l, n];
  }
  if (bestN < Math.max(2, lags.length * 0.4)) return null;
  const idx = lags.map((l, k) => (Math.abs(l - bestAt) <= 0.03 ? k : -1)).filter((k) => k >= 0);
  const lag = idx.reduce((a, k) => a + lags[k], 0) / idx.length;
  const level = idx.reduce((a, k) => a + levels[k], 0) / idx.length;
  return { lag, level, repeats: idx.filter((k) => seconds[k]).length >= idx.length / 2 ? 2 : 1 };
}

/** how far the sides are from the middle where the voice sings (side / mid level): 0 mono … 1 very wide */
export function widthOf(channels: Float32Array[]) {
  if (channels.length < 2) return 0;
  const [l, r] = channels;
  const h = 2048;
  const ratios: number[] = [];
  for (let k = 0; (k + 1) * h <= l.length; k++) {
    let m = 0;
    let s = 0;
    for (let i = k * h; i < (k + 1) * h; i++) {
      m += ((l[i] + r[i]) / 2) ** 2;
      s += ((l[i] - r[i]) / 2) ** 2;
    }
    if (m > 1e-6) ratios.push(Math.sqrt(s / m));
  }
  if (!ratios.length) return 0;
  ratios.sort((a, b) => a - b);
  return pct(ratios, 0.5);
}

/** how tightly the pitch sits on notes: the share of sung moments within 12 cents of a note (natural ≈ 0.25–0.4, autotuned 0.6 and more) */
export function tuneTightness(x: Float32Array, sr: number) {
  const { f0 } = detectPitch(x, sr);
  const cents: number[] = [];
  for (const f of f0) if (f > 60 && f < 1200) cents.push((((1200 * Math.log2(f / 440)) % 100) + 150) % 100 - 50);
  if (cents.length < 300) return null;
  // the singer's own tuning (a voice may sit a little off 440 Hz): the offset most of it is near
  let best = 0;
  for (let c = -50; c < 50; c += 2) {
    const n = cents.filter((d) => Math.abs((((d - c) % 100) + 150) % 100 - 50) <= 12).length;
    if (n > best) best = n;
  }
  return best / cents.length;
}

/**
 * The effect chain that sounds like `ref` (a voice with its effects) — against `dry` (the same kind of voice
 * dry: your own take) when there is one. `bpm`: the song's tempo, for echoes.
 */
export function matchSound(ref: Float32Array[], sr: number, opts: { dry?: Float32Array | null; drySr?: number; bpm?: number | null } = {}): SoundMatch {
  const x = monoOf(ref);
  const found: string[] = [];
  const preset: FxPreset = { id: "", name: "", about: "", category: "Clean" };

  // the tone: what is louder or softer than in a dry voice
  const refBands = bandLevels(x, sr);
  const dryBands = opts.dry ? bandLevels(opts.dry, opts.drySr ?? sr) : DRY_VOICE;
  const diff = refBands.map((v, i) => v - dryBands[i]);
  const tone: string[] = [];
  if (diff[0] < -8 && diff[1] < -6) {
    preset.hpf = diff[2] < -5 ? 160 : 120;
    tone.push(`low cut ${preset.hpf} Hz`);
  }
  if (diff[11] < -10 && diff[12] < -10) {
    preset.lpf = 8000;
    tone.push("top cut 8 kHz");
  }
  const eq: NonNullable<FxPreset["eq"]> = [];
  const band = (type: "peaking" | "lowshelf" | "highshelf", f: number, g: number, label: string, q?: number) => {
    const gain = round(clamp(g, -8, 8), 0.5);
    if (Math.abs(gain) < 1.5) return;
    eq.push({ type, f, gain, ...(q ? { q } : {}) });
    tone.push(`${gain > 0 ? "+" : ""}${gain} dB ${label}`);
  };
  if (!preset.hpf) band("lowshelf", 160, (diff[1] + diff[2]) / 2, "bass");
  band("peaking", 300, (diff[3] + diff[4]) / 2, "body", 1);
  band("peaking", 3200, (diff[8] + diff[9]) / 2, "presence", 0.9);
  if (!preset.lpf) band("highshelf", 10000, (diff[11] + diff[12]) / 2, "air");
  if (eq.length) preset.eq = eq;
  found.push(`Tone: ${tone.length ? tone.join(", ") : "natural"}`);

  // dynamics: an evenly loud voice is compressed
  const range = dynamicRange(x, sr);
  const dryRange = opts.dry ? dynamicRange(opts.dry, opts.drySr ?? sr) : 18;
  if (range < dryRange - 3) {
    const ratio = round(clamp(1 + (dryRange - range) / 3, 2, 8), 0.5);
    preset.comp = { threshold: -24, ratio, attack: 0.005, release: 0.12, makeup: round(clamp((ratio - 1) * 1.2, 1, 8), 0.5) };
    found.push(`Compression: ${ratio >= 5 ? "strong" : ratio >= 3 ? "medium" : "light"} (${ratio}:1)`);
  } else found.push("Compression: light or none");

  // space: reverb from how the voice dies away, echoes from it coming back
  const t = tails(x, sr);
  const rt60 = t && t.decay < 0 ? 60 / -t.decay : 0;
  if (t && rt60 > 0.35) {
    const seconds = round(clamp(rt60 * 0.9, 0.4, 5), 0.1);
    const mix = round(clamp(10 ** (t.ring / 20) * 1.6, 0.05, 0.45), 0.01);
    preset.reverb = { seconds, mix, ...(seconds > 1.2 ? { predelay: 0.02 } : {}), ...(diff[11] > 1 ? { bright: true } : {}) };
    found.push(`Reverb: ${seconds} s, ${Math.round(mix * 100)} %`);
  } else found.push("Reverb: dry");
  const e = echoes(x, sr);
  if (e && opts.bpm) {
    const beat = 60 / opts.bpm;
    const notes: [NonNullable<FxPreset["delay"]>["note"], number][] = [
      ["1/8", beat / 2],
      ["1/8d", beat * 0.75],
      ["1/4", beat],
      ["1/2", beat * 2],
    ];
    const [note, at] = notes.reduce((a, n) => (Math.abs(n[1] - e.lag) < Math.abs(a[1] - e.lag) ? n : a));
    if (Math.abs(at - e.lag) < Math.max(0.04, at * 0.12)) {
      const mix = round(clamp(10 ** (e.level / 20) * 1.4, 0.06, 0.35), 0.01);
      preset.delay = { note, feedback: e.repeats > 1 ? 0.35 : 0.15, mix };
      found.push(`Echo: ${note} note, ${e.repeats > 1 ? "repeating" : "one repeat"}`);
    } else found.push(`Echo: ${Math.round(e.lag * 1000)} ms (off the tempo — left out)`);
  }

  // width: a voice spread left and right (doubled, widened)
  const w = widthOf(ref);
  if (w > 0.12) {
    preset.widen = round(clamp(w * 60, 6, 20));
    found.push(`Width: ${w > 0.3 ? "wide" : "a little wide"}`);
  }

  // pitch: autotuned voices sit right on the notes
  const tight = tuneTightness(x, sr);
  if (tight !== null && tight >= 0.5) {
    preset.tune = { speed: tight >= 0.62 ? 0 : 0.5 };
    found.push(`Pitch: ${tight >= 0.62 ? "hard-tuned (autotune)" : "gently tuned"}`);
  } else if (tight !== null) found.push("Pitch: natural");

  preset.name = nameOf(preset);
  preset.category = categoryOf(preset);
  preset.about = found.map((f) => f.replace(/^[^:]+: /, "")).filter((f) => !/^(natural|dry|light or none)$/.test(f)).join(" · ") || "A clean, natural voice";
  return { preset, found };
}

/** a short name from what it is: "Bright plate · echo · tuned" */
export function nameOf(p: FxPreset): string {
  const eq = (f: number) => p.eq?.find((b) => b.f === f)?.gain ?? 0;
  const tone = p.lpf ? "Lo-fi" : eq(3200) + eq(10000) >= 4 ? "Bright" : eq(3200) + eq(10000) <= -4 ? "Dark" : eq(300) >= 2 || eq(160) >= 2 ? "Warm" : p.comp && p.comp.ratio >= 5 ? "Upfront" : "Clean";
  const space = !p.reverb ? "dry" : p.reverb.seconds >= 2.5 ? "hall" : p.reverb.seconds >= 1.2 ? "plate" : "room";
  return [`${tone} ${space}`, p.delay ? "echo" : "", p.tune ? (p.tune.speed === 0 ? "tuned" : "soft tune") : "", p.widen ? "wide" : ""].filter(Boolean).join(" · ");
}

function categoryOf(p: FxPreset): FxCategory {
  if (p.tune) return "Tuned";
  if (p.delay || (p.reverb && p.reverb.mix >= 0.2)) return "Space";
  if (p.lpf || p.drive) return "Character";
  return "Clean";
}

/** a preset from outside (a library, a song) made safe: known fields, numbers in range */
export function cleanPreset(v: unknown): FxPreset | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  const num = (x: unknown, a: number, b: number) => (typeof x === "number" && Number.isFinite(x) ? clamp(x, a, b) : undefined);
  const str = (x: unknown, n: number) => (typeof x === "string" ? x.slice(0, n) : "");
  const id = str(p.id, 60);
  if (!/^[a-z0-9:_-]{2,60}$/i.test(id)) return null;
  const out: FxPreset = {
    id,
    name: str(p.name, 60).trim() || "My sound",
    about: str(p.about, 200),
    category: (["Clean", "Space", "Tuned", "Character", "Layers"] as FxCategory[]).find((c) => c === p.category) ?? "Clean",
  };
  const hpf = num(p.hpf, 20, 1000);
  if (hpf) out.hpf = hpf;
  const lpf = num(p.lpf, 1000, 20000);
  if (lpf) out.lpf = lpf;
  if (Array.isArray(p.eq))
    out.eq = p.eq.slice(0, 8).flatMap((b) => {
      const x = b as Record<string, unknown>;
      const type = (["peaking", "lowshelf", "highshelf"] as const).find((t) => t === x.type);
      const f = num(x.f, 20, 20000);
      const gain = num(x.gain, -18, 18);
      return type && f !== undefined && gain !== undefined ? [{ type, f, gain, ...(num(x.q, 0.1, 10) !== undefined ? { q: num(x.q, 0.1, 10) } : {}) }] : [];
    });
  if (p.comp && typeof p.comp === "object") {
    const c = p.comp as Record<string, unknown>;
    out.comp = { threshold: num(c.threshold, -60, 0) ?? -24, ratio: num(c.ratio, 1, 20) ?? 3, attack: num(c.attack, 0.001, 0.2) ?? 0.005, release: num(c.release, 0.01, 1) ?? 0.12, makeup: num(c.makeup, 0, 18) ?? 3 };
  }
  const drive = num(p.drive, 0, 1);
  if (drive) out.drive = drive;
  if (p.reverb && typeof p.reverb === "object") {
    const r = p.reverb as Record<string, unknown>;
    out.reverb = { seconds: num(r.seconds, 0.1, 8) ?? 1, mix: num(r.mix, 0, 1) ?? 0.15, ...(num(r.predelay, 0, 0.2) !== undefined ? { predelay: num(r.predelay, 0, 0.2) } : {}), ...(r.bright ? { bright: true } : {}) };
  }
  if (p.delay && typeof p.delay === "object") {
    const d = p.delay as Record<string, unknown>;
    const note = (["1/8", "1/8d", "1/4", "1/2"] as const).find((n) => n === d.note);
    if (note) out.delay = { note, feedback: num(d.feedback, 0, 0.9) ?? 0.2, mix: num(d.mix, 0, 1) ?? 0.1, ...(d.pingpong ? { pingpong: true } : {}), ...(d.dark ? { dark: true } : {}) };
  }
  const widen = num(p.widen, 0, 40);
  if (widen) out.widen = widen;
  if (p.tune && typeof p.tune === "object") out.tune = { speed: num((p.tune as Record<string, unknown>).speed, 0, 1) ?? 0.5 };
  const shift = num(p.shift, -12, 12);
  if (shift) out.shift = shift;
  const gain = num(p.gain, 0, 4);
  if (gain !== undefined) out.gain = gain;
  return out;
}
