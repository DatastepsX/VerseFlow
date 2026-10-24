/**
 * Vocal effect presets: the typical modern recording chains, picked per
 * layer (Lead, Double, Ad-libs…). Pure data — `chain.ts` builds them with
 * the Web Audio API (playing and exporting), `tune.ts` does the pitch work
 * (autotune, voice up / down) on the take before it plays. The recorded
 * take itself never changes.
 */

export type FxCategory = "Clean" | "Space" | "Tuned" | "Character" | "Layers";

export interface FxPreset {
  id: string;
  name: string;
  /** one line: what it sounds like / what it's for */
  about: string;
  category: FxCategory;
  /** high-pass (Hz): rumble and breath noise out */
  hpf?: number;
  /** low-pass (Hz) */
  lpf?: number;
  /** EQ bands: peaking (gain dB at f) or shelves */
  eq?: { type: "peaking" | "lowshelf" | "highshelf"; f: number; gain: number; q?: number }[];
  /** compressor: the voice even and upfront */
  comp?: { threshold: number; ratio: number; attack: number; release: number; makeup: number };
  /** saturation 0..1 */
  drive?: number;
  /** reverb: length (s) and mix 0..1 */
  reverb?: { seconds: number; mix: number; predelay?: number; bright?: boolean };
  /** echo on the song's tempo */
  delay?: { note: "1/8" | "1/8d" | "1/4" | "1/2"; feedback: number; mix: number; pingpong?: boolean; dark?: boolean };
  /** stereo width: one side a few ms later (ms) */
  widen?: number;
  /** pitch correction to the song's key: 0 = hard (the robotic trap sound) … 1 = gentle */
  tune?: { speed: number };
  /** the whole voice up / down (semitones), formants kept */
  shift?: number;
  /** output level — the presets are matched in loudness, so switching compares sounds, not volume */
  gain?: number;
}

export const FX_PRESETS: FxPreset[] = [
  { id: "raw", name: "Raw", about: "The take as recorded", category: "Clean" },
  {
    id: "studio",
    name: "Studio vocal",
    about: "Clean, warm and present — the safe choice for a lead",
    category: "Clean",
    hpf: 90,
    eq: [
      { type: "peaking", f: 300, gain: -2, q: 1 },
      { type: "peaking", f: 3500, gain: 3, q: 0.9 },
      { type: "highshelf", f: 10000, gain: 3 },
    ],
    comp: { threshold: -20, ratio: 3, attack: 0.008, release: 0.15, makeup: 3 },
    reverb: { seconds: 0.9, mix: 0.12 },
  },
  {
    id: "pop",
    name: "Pop shine",
    about: "Bright and glossy, plate reverb and a soft echo",
    category: "Clean",
    hpf: 100,
    eq: [
      { type: "peaking", f: 250, gain: -2, q: 1 },
      { type: "peaking", f: 4000, gain: 4, q: 0.8 },
      { type: "highshelf", f: 12000, gain: 5 },
    ],
    comp: { threshold: -24, ratio: 4, attack: 0.005, release: 0.12, makeup: 5 },
    reverb: { seconds: 1.6, mix: 0.18, predelay: 0.02, bright: true },
    delay: { note: "1/8", feedback: 0.2, mix: 0.08 },
    gain: 0.85,
  },
  {
    id: "rap",
    name: "Rap upfront",
    about: "Dry, punchy and loud — every word on top of the beat",
    category: "Clean",
    hpf: 110,
    eq: [
      { type: "peaking", f: 250, gain: -3, q: 1 },
      { type: "peaking", f: 3000, gain: 4, q: 1 },
      { type: "highshelf", f: 9000, gain: 2 },
    ],
    comp: { threshold: -26, ratio: 6, attack: 0.003, release: 0.08, makeup: 7 },
    drive: 0.15,
    reverb: { seconds: 0.5, mix: 0.06 },
    gain: 0.4,
  },
  {
    id: "rnb",
    name: "R&B smooth",
    about: "Warm and silky, long hall and a dark quarter echo",
    category: "Space",
    hpf: 80,
    eq: [
      { type: "peaking", f: 200, gain: 2, q: 0.8 },
      { type: "peaking", f: 3000, gain: 2, q: 1 },
      { type: "highshelf", f: 10000, gain: 3 },
    ],
    comp: { threshold: -20, ratio: 3, attack: 0.01, release: 0.2, makeup: 3 },
    reverb: { seconds: 2.8, mix: 0.25, predelay: 0.03 },
    delay: { note: "1/4", feedback: 0.3, mix: 0.12, dark: true },
    gain: 0.85,
  },
  {
    id: "dreamy",
    name: "Dreamy",
    about: "Big space, ping-pong echoes — intros, hooks, outros",
    category: "Space",
    hpf: 150,
    lpf: 9000,
    comp: { threshold: -22, ratio: 3, attack: 0.01, release: 0.2, makeup: 3 },
    reverb: { seconds: 4, mix: 0.35, predelay: 0.04 },
    delay: { note: "1/4", feedback: 0.45, mix: 0.2, pingpong: true, dark: true },
  },
  {
    id: "trap",
    name: "Trap autotune",
    about: "Hard-tuned to the key, slap echo and plate — the modern trap voice",
    category: "Tuned",
    tune: { speed: 0 },
    hpf: 100,
    eq: [
      { type: "peaking", f: 300, gain: -2, q: 1 },
      { type: "peaking", f: 5000, gain: 3, q: 0.8 },
      { type: "highshelf", f: 11000, gain: 3 },
    ],
    comp: { threshold: -24, ratio: 5, attack: 0.004, release: 0.1, makeup: 6 },
    drive: 0.1,
    reverb: { seconds: 1.4, mix: 0.15, bright: true },
    delay: { note: "1/8", feedback: 0.3, mix: 0.15 },
    gain: 0.45,
  },
  {
    id: "melodic",
    name: "Melodic rap",
    about: "Autotune that still sounds human, wide echo",
    category: "Tuned",
    tune: { speed: 0.35 },
    hpf: 100,
    eq: [
      { type: "peaking", f: 4000, gain: 3, q: 0.9 },
      { type: "highshelf", f: 11000, gain: 3 },
    ],
    comp: { threshold: -22, ratio: 4, attack: 0.006, release: 0.12, makeup: 5 },
    reverb: { seconds: 2, mix: 0.2 },
    delay: { note: "1/4", feedback: 0.35, mix: 0.14, pingpong: true },
    gain: 0.7,
  },
  {
    id: "tuned",
    name: "Soft tune",
    about: "Gentle pitch correction, otherwise studio clean",
    category: "Tuned",
    tune: { speed: 0.7 },
    hpf: 90,
    eq: [
      { type: "peaking", f: 3500, gain: 3, q: 0.9 },
      { type: "highshelf", f: 10000, gain: 3 },
    ],
    comp: { threshold: -20, ratio: 3, attack: 0.008, release: 0.15, makeup: 3 },
    reverb: { seconds: 1, mix: 0.12 },
    gain: 0.85,
  },
  {
    id: "phone",
    name: "Phone / lo-fi",
    about: "Small and gritty, like through a phone",
    category: "Character",
    hpf: 450,
    lpf: 3200,
    eq: [{ type: "peaking", f: 1500, gain: 5, q: 1.2 }],
    comp: { threshold: -24, ratio: 6, attack: 0.003, release: 0.1, makeup: 6 },
    drive: 0.45,
    gain: 0.4,
  },
  {
    id: "megaphone",
    name: "Megaphone",
    about: "Loud and distorted — shouts and hype lines",
    category: "Character",
    hpf: 650,
    lpf: 2600,
    eq: [{ type: "peaking", f: 1200, gain: 8, q: 1.5 }],
    drive: 0.75,
    reverb: { seconds: 0.6, mix: 0.1 },
    gain: 0.4,
  },
  {
    id: "dark",
    name: "Dark & close",
    about: "Whispery, intimate, no air",
    category: "Character",
    hpf: 80,
    lpf: 5000,
    eq: [{ type: "peaking", f: 180, gain: 3, q: 0.8 }],
    comp: { threshold: -28, ratio: 6, attack: 0.005, release: 0.15, makeup: 8 },
    reverb: { seconds: 0.7, mix: 0.1 },
    gain: 0.6,
  },
  {
    id: "deep",
    name: "Deep voice",
    about: "Four semitones down — dark ad-libs, intros",
    category: "Character",
    shift: -4,
    hpf: 70,
    comp: { threshold: -22, ratio: 4, attack: 0.006, release: 0.15, makeup: 4 },
    reverb: { seconds: 1.2, mix: 0.12 },
    gain: 0.8,
  },
  {
    id: "high",
    name: "High voice",
    about: "Five semitones up — pitched ad-libs",
    category: "Character",
    shift: 5,
    hpf: 200,
    comp: { threshold: -22, ratio: 4, attack: 0.006, release: 0.15, makeup: 3 },
    delay: { note: "1/8", feedback: 0.25, mix: 0.12 },
  },
  {
    id: "double",
    name: "Wide double",
    about: "Spread left and right behind the lead — for the Double layer",
    category: "Layers",
    hpf: 150,
    eq: [{ type: "highshelf", f: 9000, gain: 2 }],
    comp: { threshold: -24, ratio: 5, attack: 0.005, release: 0.12, makeup: 4 },
    widen: 18,
    reverb: { seconds: 1.2, mix: 0.12 },
    gain: 0.7,
  },
  {
    id: "adlib",
    name: "Ad-lib echo",
    about: "Thin, panned echoes that answer the lead — for Ad-libs",
    category: "Layers",
    hpf: 220,
    lpf: 8000,
    eq: [{ type: "peaking", f: 2500, gain: 4, q: 1 }],
    comp: { threshold: -24, ratio: 5, attack: 0.004, release: 0.1, makeup: 4 },
    delay: { note: "1/4", feedback: 0.45, mix: 0.3, pingpong: true },
    reverb: { seconds: 2, mix: 0.18 },
    gain: 0.8,
  },
];

export const FX_CATEGORIES: FxCategory[] = ["Clean", "Space", "Tuned", "Character", "Layers"];

export const presetById = (id: string | undefined | null) => FX_PRESETS.find((p) => p.id === id) ?? FX_PRESETS[0];

/** the preset a layer uses (the song's choice; none chosen: raw) */
export function layerPreset(fx: Record<string, string> | undefined, lane: string) {
  return presetById(fx?.[lane]);
}

/** a delay note in seconds at the song's tempo */
export function noteSeconds(note: NonNullable<FxPreset["delay"]>["note"], bpm: number) {
  const beat = 60 / (bpm > 0 ? bpm : 90);
  return note === "1/8" ? beat / 2 : note === "1/8d" ? beat * 0.75 : note === "1/4" ? beat : beat * 2;
}
