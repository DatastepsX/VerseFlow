import type { Line } from "@/lib/types";
import { lineEnd } from "./fit-parts";

/**
 * The bars a line is sung over, to loop while writing it: from the bar line it starts on (a pickup just before
 * a bar belongs to that bar) to the bar line after its last word — 1, 2 or 4 bars, so the loop comes round as
 * the music does. Pure.
 */
export function loopBars(line: Pick<Line, "audio_at" | "flow">, grid: { bpm: number | null; beat_offset: number; beats_per_bar: number }, duration: number | null) {
  if (line.audio_at === null || !grid.bpm) return null;
  const bar = ((grid.beats_per_bar || 4) * 60) / grid.bpm;
  const origin = grid.beat_offset ?? 0;
  const pos = (line.audio_at - origin) / bar;
  // a pickup up to a quarter of a bar before the bar line: the loop starts on that bar line
  const first = Math.max(0, Math.floor(pos + 0.25));
  const end = lineEnd(line) ?? line.audio_at + bar;
  const sung = Math.max(1, Math.ceil((end - origin) / bar - first - 0.05));
  const bars = sung <= 1 ? 1 : sung <= 2 ? 2 : 4;
  const from = origin + first * bar;
  let to = from + bars * bar;
  if (duration && to > duration) to = Math.max(from + bar, from + Math.floor((duration - from) / bar) * bar);
  return { from: Math.max(0, from), to, bars };
}
