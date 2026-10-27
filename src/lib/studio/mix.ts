import type { ProjectSettings } from "@/lib/types";

/**
 * The song's mixer: a channel for the beat, your recorded flow, your voice (Hear) and each recording layer
 * (Lead, Double, Ad-libs…) — its volume, pan, mute and solo — kept with the song, so the phone mixes what
 * the Mac plays. Each take has its own volume and pan on top (takes.gain / takes.pan). Pure.
 */

export const MIX_MAX = 1.5;
export const laneBus = (lane: string) => `lane:${lane}`;

export interface Channel {
  /** 0–1.5 (1: as is) */
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
export const clipOf = (t: { trim_in: number; trim_out: number | null }) => (t.trim_in > 0 || t.trim_out !== null ? { from: t.trim_in ?? 0, to: t.trim_out } : undefined);

export const pct = (v: number) => `${Math.round(v * 100)}%`;

/** a take's volume up to this (a quiet take made louder) */
export const TAKE_MAX = 4;

/** the volume that brings a take's loudest moment to about −1 dB (its waveform: 0…1 peaks); null: no sound */
export function louderGain(peaks: number[]): number | null {
  const top = Math.max(0, ...peaks);
  if (top < 0.005) return null;
  return Math.round(Math.min(TAKE_MAX, 0.89 / top) * 100) / 100;
}
/** a pan as read: L 40 · C · R 40 */
export const panLabel = (p: number) => (Math.abs(p) < 0.02 ? "C" : `${p < 0 ? "L" : "R"} ${Math.round(Math.abs(p) * 100)}`);
