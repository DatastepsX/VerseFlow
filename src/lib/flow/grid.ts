import type { LineFlow } from "@/lib/types";

/**
 * The flow grid: a line's rhythm on the beat, drum-machine style — 16 steps
 * (16th notes) per bar, each empty, a syllable, or a stressed syllable. The
 * sung syllables are snapped onto it; tapping fixes them; the grid becomes
 * the line's flow (syllable count, stresses, where each syllable starts).
 */

export interface BeatGrid {
  bpm: number | null;
  beat_offset: number;
  beats_per_bar: number;
}

/** 0 = empty, 1 = syllable, 2 = stressed syllable */
export type Cell = 0 | 1 | 2;

export interface FlowGridModel {
  /** song time of step 0 (a beat) */
  start: number;
  /** seconds per step (a 16th note) */
  step: number;
  cells: Cell[];
}

export const STEPS_PER_BEAT = 4;

/** the grid of a line: from the beat its singing starts on, 1 bar (2 when the line is longer) */
export function gridFor(flow: LineFlow | null, at: number | null, grid: BeatGrid): FlowGridModel | null {
  if (!grid.bpm) return null;
  const beat = 60 / grid.bpm;
  const step = beat / STEPS_PER_BEAT;
  const times = flow?.times ?? [];
  const first = times[0] ?? at;
  if (first === null || first === undefined) return null;
  // the beat at (or just before) the first syllable — a syllable a hair early still lands on it
  const start = grid.beat_offset + Math.floor((first - grid.beat_offset + step / 2) / beat) * beat;
  const bar = grid.beats_per_bar * STEPS_PER_BEAT;
  const last = times.length ? times[times.length - 1] : first;
  const n = (last - start) / step > bar - 0.5 ? 2 * bar : bar;
  const cells: Cell[] = new Array(n).fill(0);
  const stressed = stressedTimes(flow, times.length);
  times.forEach((t, i) => {
    const k = Math.min(n - 1, Math.max(0, Math.round((t - start) / step)));
    cells[k] = Math.max(cells[k], stressed.has(i) ? 2 : 1) as Cell;
  });
  return { start: round(start), step, cells };
}

/** which of the line's sung syllables (by index into times) carry a stress */
function stressedTimes(flow: LineFlow | null, n: number) {
  const out = new Set<number>();
  if (!flow || !n) return out;
  const scale = n / Math.max(1, flow.syllables);
  for (const s of flow.stress) out.add(Math.min(n - 1, Math.max(0, Math.round((s - 0.5) * scale - 0.5))));
  return out;
}

/** the grid → the line's flow (the rest — words, couplet, where it came from — stays) */
export function flowFromGrid(g: FlowGridModel, prev: LineFlow | null): LineFlow {
  const on = g.cells.map((c, i) => ({ c, i })).filter((x) => x.c > 0);
  const times = on.map((x) => round(g.start + x.i * g.step));
  const lastStep = on.length ? on[on.length - 1].i : 0;
  const held = prev?.held ?? false;
  return {
    syllables: on.length,
    stress: on.map((x, k) => (x.c === 2 ? k + 1 : 0)).filter(Boolean),
    held,
    words: prev?.words ?? "",
    source: prev?.source ?? "flow",
    pair: prev?.pair,
    times,
    end: round(g.start + (lastStep + (held ? 4 : 2)) * g.step),
  };
}

/** a tap: empty → syllable → stressed → empty */
export function cycle(c: Cell): Cell {
  return c === 0 ? 1 : c === 1 ? 2 : 0;
}

const round = (t: number) => Math.round(t * 1000) / 1000;
