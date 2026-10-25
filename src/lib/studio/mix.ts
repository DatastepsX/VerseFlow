import type { ProjectSettings } from "@/lib/types";

/**
 * The song's mix: a volume for each channel — the beat, your flow, your voice (Hear), each recording layer —
 * and the layers turned off. Kept with the song, so the phone mixes what the Mac plays.
 */

export const MIX_MAX = 1.5;
export const laneBus = (lane: string) => `lane:${lane}`;

export function volumeOf(s: ProjectSettings | undefined, key: string) {
  const v = s?.mix?.[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(MIX_MAX, v)) : 1;
}

/** what each channel plays at (an off layer: 0) */
export function mixVolumes(s: ProjectSettings | undefined, lanes: string[]): Record<string, number> {
  const off = s?.mixOff ?? [];
  const out: Record<string, number> = { beat: volumeOf(s, "beat"), flow: volumeOf(s, "flow"), voice: volumeOf(s, "voice") };
  for (const l of lanes) out[laneBus(l)] = off.includes(l) ? 0 : volumeOf(s, laneBus(l));
  return out;
}

/** a take's clip (cut), for the engine */
export const clipOf = (t: { trim_in: number; trim_out: number | null }) => (t.trim_in > 0 || t.trim_out !== null ? { from: t.trim_in ?? 0, to: t.trim_out } : undefined);

export const pct = (v: number) => `${Math.round(v * 100)}%`;
