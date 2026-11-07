import type { AudioTrack, Line } from "@/lib/types";

/**
 * Parts of beat without recorded voice (an instrumental, a part to write) start where the singing before them
 * stops: when a part's singing has ended and the beat plays on, the next part starts there — on the beat change right after the last
 * sung word, else on the next bar line — not where it was first placed. Only ever earlier, never past a line of
 * the part before. Pure: the server moves the parts with it.
 */

type Part = { id: string; audio_start: number | null; lines: Pick<Line, "text" | "audio_at" | "flow" | "kind">[] };

/** where a sung line's voice stops: its last syllable, held a little (a word stretched over the beat is cut) */
export function lineEnd(l: Pick<Line, "audio_at" | "flow">): number | null {
  if (l.audio_at === null) return null;
  const f = l.flow;
  const times = f?.times ?? [];
  const last = times.length ? times[times.length - 1] : null;
  if (last === null) return l.audio_at + 0.8 + 0.45 * (f?.syllables ?? 4);
  return Math.min(f?.end ?? last + 0.3, last + 0.8);
}

export function fitPartStarts(parts: Part[], audio: Pick<AudioTrack, "bpm" | "beat_offset" | "beats_per_bar" | "changes">): { id: string; from: number; to: number }[] {
  if (!audio.bpm) return [];
  const bar = ((audio.beats_per_bar || 4) * 60) / audio.bpm;
  const origin = audio.beat_offset ?? 0;
  const changes = (audio.changes ?? []).map((c) => c.t).sort((a, b) => a - b);
  const out: { id: string; from: number; to: number }[] = [];
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const start = part.audio_start;
    // a part with recorded singing starts where its music starts: only a part of beat without voice moves
    if (start === null || part.lines.some((l) => l.flow?.source === "vocals")) continue;
    const prev = [...parts.slice(0, i)].reverse().find((p) => p.audio_start !== null);
    if (!prev) continue;
    const lyric = prev.lines.filter((l) => l.kind === "lyric" && l.audio_at !== null);
    const sung = lyric.filter((l) => l.text.trim() || l.flow?.source === "vocals");
    if (!sung.length) continue;
    const voiceEnd = Math.max(...sung.map((l) => lineEnd(l) ?? 0));
    // never before a line of the part before (an empty one waiting to be written too) — nor before its own start
    const floor = Math.max(voiceEnd, ...lyric.map((l) => l.audio_at! + 0.05), prev.audio_start! + bar);
    if (start - floor < bar) continue;
    // the beat changes soon after the voice stops: the new part starts there; else on the next bar line
    const change = changes.find((t) => t >= floor - 0.05 && t <= floor + 2 * bar && t < start - 0.5 * bar);
    const onBar = origin + Math.ceil((floor - origin) / bar - 1e-6) * bar;
    const to = Math.round((change ?? onBar) * 1000) / 1000;
    // the part's own first line stays in it
    const first = Math.min(...part.lines.filter((l) => l.audio_at !== null).map((l) => l.audio_at!), Infinity);
    if (to < start - 0.5 * bar && to <= first) out.push({ id: part.id, from: start, to });
  }
  return out;
}

/**
 * The lines of a part of beat without recorded voice start on its first bar: when they were laid out later
 * (the part began later then), they move earlier by whole bars — each keeps its place in the bar and its rhythm.
 */
export function alignPartLines(parts: Part[], audio: Pick<AudioTrack, "bpm" | "beat_offset" | "beats_per_bar">): { id: string; shift: number }[] {
  if (!audio.bpm) return [];
  const bar = ((audio.beats_per_bar || 4) * 60) / audio.bpm;
  const origin = audio.beat_offset ?? 0;
  const barOf = (t: number) => Math.round((t - origin) / bar);
  const out: { id: string; shift: number }[] = [];
  parts.forEach((part, i) => {
    const lines = part.lines.filter((l) => l.kind === "lyric" && l.audio_at !== null);
    if (part.audio_start === null || !lines.length || part.lines.some((l) => l.flow?.source === "vocals")) return;
    const first = Math.min(...lines.map((l) => l.audio_at!));
    const bars = barOf(first) - barOf(part.audio_start);
    if (bars < 1) return;
    const shift = bars * bar;
    // never into the singing of the part before
    const prev = [...parts.slice(0, i)].reverse().find((p) => p.audio_start !== null);
    const sung = (prev?.lines ?? []).filter((l) => l.kind === "lyric" && l.audio_at !== null && (l.text.trim() || l.flow?.source === "vocals"));
    const voiceEnd = sung.length ? Math.max(...sung.map((l) => lineEnd(l) ?? 0)) : -Infinity;
    if (first - shift < voiceEnd) return;
    out.push({ id: part.id, shift: Math.round(shift * 1000) / 1000 });
  });
  return out;
}
