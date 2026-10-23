import type { LineFlow } from "@/lib/types";

/**
 * Every line rhymes with a partner: the couplets a section's lines form —
 * as sung (flow.pair 1 → 2, a line ending on its rhyme), and the lines left
 * over paired in order (1+2, 3+4…), so a line never stays without a rhyme.
 * The same pairs on the screen and for the AI.
 */
export function coupletsOf<T extends { flow: LineFlow | null }>(lines: T[]): [T, T][] {
  const out: [T, T][] = [];
  const used = new Set<number>();
  lines.forEach((l, k) => {
    if (l.flow?.pair === 1 && lines[k + 1]?.flow?.pair === 2) {
      out.push([l, lines[k + 1]]);
      used.add(k).add(k + 1);
    }
  });
  // the rest, in order: a line with the next one that has no partner either
  for (let k = 0; k < lines.length - 1; k++) {
    if (used.has(k) || used.has(k + 1)) continue;
    out.push([lines[k], lines[k + 1]]);
    used.add(k).add(k + 1);
  }
  return out.sort((a, b) => lines.indexOf(a[0]) - lines.indexOf(b[0]));
}
