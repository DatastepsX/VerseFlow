import type { ProjectSettings } from "@/lib/types";

/**
 * The song's mixer: a channel for the beat, your recorded flow, your voice (Hear) and each recording layer
 * (Lead, Double, Ad-libs…) — its volume, pan, mute and solo — kept with the song, so the phone mixes what
 * the Mac plays. Each take has its own volume and pan on top (takes.gain / takes.pan). Pure.
 */

/** a channel's volume up to this (+8 dB; the vocals have a limiter, so a louder voice doesn't crack) */
export const MIX_MAX = 2.5;
export const laneBus = (lane: string) => `lane:${lane}`;

export interface Channel {
  /** 0–MIX_MAX (1: as is) */
  vol: number;
  /** −1 left … 0 centre … 1 right */
  pan: number;
  mute: boolean;
  solo: boolean;
}

export type ChannelPatch = Partial<Channel>;

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);

/** a channel as set (older songs: the volumes in `mix`, the layers off in `mixOff`) */
export function channelOf(s: ProjectSettings | undefined, key: string): Channel {
  const c = s?.mixer?.[key];
  const lane = key.startsWith("lane:") ? key.slice(5) : null;
  return {
    vol: num(c?.vol ?? s?.mix?.[key], 0, MIX_MAX, 1),
    pan: num(c?.pan, -1, 1, 0),
    mute: c?.mute ?? (lane !== null && !!s?.mixOff?.includes(lane)),
    solo: !!c?.solo,
  };
}

/** the channels of a song: the beat, the flow, your voice, the layers */
export const channelKeys = (lanes: string[]) => ["beat", "flow", "voice", ...lanes.map(laneBus)];

/** what each channel plays at: its volume — 0 when muted, or when others are soloed and it isn't */
export function mixVolumes(s: ProjectSettings | undefined, lanes: string[]): Record<string, number> {
  const keys = channelKeys(lanes);
  const ch = Object.fromEntries(keys.map((k) => [k, channelOf(s, k)]));
  const soloing = keys.some((k) => ch[k].solo);
  return Object.fromEntries(keys.map((k) => [k, ch[k].mute || (soloing && !ch[k].solo) ? 0 : ch[k].vol]));
}

export function mixPans(s: ProjectSettings | undefined, lanes: string[]): Record<string, number> {
  return Object.fromEntries(channelKeys(lanes).map((k) => [k, channelOf(s, k).pan]));
}

/** a channel changed: the song's settings to save (the older fields folded in) */
export function withChannel(s: ProjectSettings | undefined, key: string, patch: ChannelPatch): ProjectSettings {
  const lanes = [...new Set([...Object.keys(s?.mix ?? {}), ...(s?.mixOff ?? []).map(laneBus), ...Object.keys(s?.mixer ?? {}), key])];
  const mixer = Object.fromEntries(lanes.map((k) => [k, channelOf(s, k)]));
  mixer[key] = { ...mixer[key], ...patch };
  const rest = { ...(s ?? {}) };
  delete rest.mix;
  delete rest.mixOff;
  return { ...rest, mixer };
}

/** a take's clip (cut), for the engine */
/** the part of a take that plays (its cut), with its fades (`fades`: the song's, settings.takeFades) */
export const clipOf = (t: { id?: string; trim_in: number; trim_out: number | null }, fades?: Record<string, { in: number; out: number }>) => {
  const f = t.id ? fades?.[t.id] : undefined;
  return t.trim_in > 0 || t.trim_out !== null || f ? { from: t.trim_in ?? 0, to: t.trim_out, ...(f ? { fadeIn: f.in, fadeOut: f.out } : {}) } : undefined;
};

export const pct = (v: number) => `${Math.round(v * 100)}%`;

/** a take's volume up to this (a quiet take made louder: +18 dB) */
export const TAKE_MAX = 8;

/** how loud a voice should be (about LUFS): where a voice sits in a mastered beat */
export const VOICE_TARGET_DB = -16;

/**
 * A recording's loudness in dB (close to LUFS for a voice): the level of its 400 ms blocks, the silent ones
 * left out — below −70 dB, then those 10 dB under the rest — so pauses between lines don't count. null: silence.
 */
export function loudnessDb(x: Float32Array, sampleRate: number): number | null {
  const n = Math.max(1, Math.round(sampleRate * 0.4));
  const blocks: number[] = [];
  for (let i = 0; i + n <= x.length; i += Math.round(n / 4)) {
    let sum = 0;
    for (let k = i; k < i + n; k++) sum += x[k] * x[k];
    blocks.push(sum / n);
  }
  const db = (ms: number) => 10 * Math.log10(ms + 1e-12);
  const loud = blocks.filter((m) => db(m) > -70);
  if (!loud.length) return null;
  const gate = db(loud.reduce((a, b) => a + b, 0) / loud.length) - 10;
  const kept = loud.filter((m) => db(m) > gate);
  return db(kept.reduce((a, b) => a + b, 0) / kept.length);
}

/** the volume that brings a take to the voice's loudness (VOICE_TARGET_DB); null: no voice in it */
export function levelGain(x: Float32Array, sampleRate: number): number | null {
  const l = loudnessDb(x, sampleRate);
  if (l === null || l < -60) return null;
  return Math.round(Math.max(0.5, Math.min(TAKE_MAX, Math.pow(10, (VOICE_TARGET_DB - l) / 20))) * 100) / 100;
}

/** the volume that brings a take's loudest moment to about −1 dB (its waveform: 0…1 peaks); null: no sound */
export function louderGain(peaks: number[]): number | null {
  const top = Math.max(0, ...peaks);
  if (top < 0.005) return null;
  return Math.round(Math.min(TAKE_MAX, 0.89 / top) * 100) / 100;
}
/** a pan as read: L 40 · C · R 40 */
export const panLabel = (p: number) => (Math.abs(p) < 0.02 ? "C" : `${p < 0 ? "L" : "R"} ${Math.round(Math.abs(p) * 100)}`);
