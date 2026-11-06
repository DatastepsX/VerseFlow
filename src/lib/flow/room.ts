import type { AudioTrack, LineFlow, ProjectTree } from "@/lib/types";
import { lineFlowFrom, lineStarts } from "./pattern";

/**
 * The beat without vocals at the end of a part, before the next part's singing starts: room for more lines of
 * the part's flow. Pure: the browser shows the button with it, the server adds the line with it.
 */

type Sections = ProjectTree["sections"];

/** where the singing of the part after `sIdx` starts (its first sung line), and where that part starts now */
export function nextSinging(sections: Sections, sIdx: number, audio: Pick<AudioTrack, "duration">) {
  const k = sections.findIndex((x, i) => i > sIdx && x.audio_start !== null);
  const next = k >= 0 ? sections[k] : null;
  const sung = next?.lines
    .filter((l) => l.kind === "lyric" && l.audio_at !== null && (l.text.trim() || l.flow?.source === "vocals"))
    .map((l) => l.audio_at!)
    .sort((a, b) => a - b)[0];
  const start = next?.audio_start ?? audio.duration ?? null;
  // a part with nothing sung: the beat is free up to where it starts
  return { next, start, singing: sung !== undefined ? Math.max(sung, start ?? sung) : start };
}

/** the next line of the part's flow, after its last line — if it is sung before the next part's singing */
export function roomForLine(sections: Sections, sectionId: string, flows: ProjectTree["flows"], audio: AudioTrack | null) {
  if (!audio?.bpm) return null;
  const sIdx = sections.findIndex((s) => s.id === sectionId);
  const lyric = sections[sIdx]?.lines.filter((l) => l.kind === "lyric") ?? [];
  const last = lyric[lyric.length - 1];
  const f = last?.flow;
  const pattern = flows.find((x) => x.id === f?.flowId)?.pattern;
  if (!last || last.audio_at === null || !f?.flowId || !pattern?.lines.length) return null;
  const bar = ((audio.beats_per_bar || 4) * 60) / audio.bpm;
  const p = f.patternLine ?? 0;
  // the next line as far after this one as in the pattern
  const starts = lineStarts(pattern, bar, p + 2);
  const step = starts[p + 1] - starts[p];
  const slot = last.audio_at - (lineFlowFrom(pattern, p, 0, bar, f.flowId).times?.[0] ?? 0);
  const flow: LineFlow = lineFlowFrom(pattern, p + 1, slot + step, bar, f.flowId);
  const at = flow.times?.[0] ?? slot + step;
  const end = flow.times?.[flow.times.length - 1] ?? at;
  const { next, start, singing } = nextSinging(sections, sIdx, audio);
  if (step <= 0 || at <= last.audio_at || (singing !== null && end + 0.1 > singing)) return null;
  // the line runs past where the next part starts: that part then starts after it (its singing stays where it is)
  const moveNext = next && start !== null && end + 0.1 > start ? Math.min((singing ?? end) - 0.05, end + 0.25) : null;
  return { flow, at, nextId: next?.id ?? null, nextName: next?.name ?? null, moveNext };
}
