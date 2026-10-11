import type { AudioTrack, Section } from "@/lib/types";

export interface SectionRange {
  start: number;
  end: number;
  /** length in musical bars (when the BPM is known) */
  bars: number | null;
}

export function barLength(audio: Pick<AudioTrack, "bpm" | "beats_per_bar">) {
  return audio.bpm ? (audio.beats_per_bar * 60) / audio.bpm : null;
}

/** Each anchored section runs until the next anchor (or the end of the track). */
export function sectionRanges(sections: Pick<Section, "id" | "audio_start">[], audio: AudioTrack | null) {
  const map = new Map<string, SectionRange>();
  if (!audio) return map;
  const anchored = sections
    .filter((s) => s.audio_start !== null && s.audio_start !== undefined)
    .sort((a, b) => (a.audio_start ?? 0) - (b.audio_start ?? 0));
  const bl = barLength(audio);
  anchored.forEach((s, i) => {
    const start = s.audio_start ?? 0;
    const end = i + 1 < anchored.length ? (anchored[i + 1].audio_start ?? start) : (audio.duration ?? start);
    map.set(s.id, { start, end, bars: bl ? Math.round((end - start) / bl) : null });
  });
  return map;
}

/** Which section and which written line the playhead is on. */
export function positionAt(
  time: number,
  sections: Pick<Section, "id" | "audio_start" | "bars_per_line">[],
  audio: AudioTrack | null,
) {
  if (!audio) return null;
  const ranges = sectionRanges(sections, audio);
  const bl = barLength(audio);
  for (const s of sections) {
    const r = ranges.get(s.id);
    if (!r || time < r.start || time >= r.end) continue;
    const lineIndex = bl ? Math.floor((time - r.start + 0.02) / (bl * (s.bars_per_line || 1))) : null;
    return { sectionId: s.id, lineIndex };
  }
  return null;
}

export function fmtTime(t: number) {
  if (!Number.isFinite(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
