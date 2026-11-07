import type { FlowPattern, Line, LineFlow, PatternLine } from "@/lib/types";
import { lineFlowFrom, lineFromText } from "./pattern";

/**
 * A part's flow taken from its lyrics as they are now: one pattern line per written line — its syllables,
 * stresses and breaks from the words, its timing as sung (or as the flow had it), each line where it is in the
 * part. Another part can then follow it: the same rhythm, the same number of lines, as long. Pure.
 */
export function patternFromPart(
  lines: Pick<Line, "id" | "text" | "audio_at" | "flow">[],
  lang: string,
  bar: number,
  origin: number,
  part: { id: string; name: string },
): { pattern: FlowPattern; start: number; ids: string[] } | null {
  const sung = lines.filter((l) => l.text.trim() && l.audio_at !== null).sort((a, b) => a.audio_at! - b.audio_at!);
  if (!sung.length) return null;
  // the bar the part's first line is sung in
  const start = origin + Math.floor((sung[0].audio_at! - origin) / bar + 1e-6) * bar;
  const out: PatternLine[] = sung.map((l) => {
    const f = l.flow;
    const at = Math.round(((l.audio_at! - start) / bar) * 1000) / 1000;
    const times = f?.times ?? [];
    const keep: PatternLine | undefined = f
      ? {
          text: l.text,
          written: true,
          ...(times.length > 1 ? { sung: true } : {}),
          syllables: f.syllables,
          stress: f.stress,
          long: f.long ?? (f.held && f.syllables ? [f.syllables] : []),
          pauses: f.pauses ?? [],
          ...(f.fast?.length ? { fast: f.fast } : {}),
          offsets: times.map((t) => Math.round((t - l.audio_at!) * 1000) / 1000),
          at,
        }
      : undefined;
    // the words as they are now decide the syllables; the timing stays where it can
    const pl = lineFromText(l.text.trim(), lang, bar, keep);
    return { ...pl, at };
  });
  return { pattern: { lines: out, scheme: "AABB", bar, source: "write", part }, start, ids: sung.map((l) => l.id) };
}

/** the part's own line i following that flow: its words, recorded timing and couplet kept */
export function lineFlowOfPart(pattern: FlowPattern, i: number, start: number, bar: number, flowId: string, old: LineFlow | null): LineFlow {
  const lf = lineFlowFrom(pattern, i, start + (pattern.lines[i].at ?? 0) * bar, bar, flowId);
  const sameTimes = old?.times && old.times.length === lf.syllables;
  return {
    ...lf,
    words: old?.words ?? "",
    source: old?.source ?? "flow",
    ...(sameTimes ? { times: old!.times, end: old!.end ?? lf.end } : {}),
    ...(old?.pair !== undefined ? { pair: old.pair } : {}),
  };
}
