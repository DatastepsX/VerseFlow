import type { LineFlow } from "@/lib/types";

/**
 * Every line rhymes with a partner: the couplets a section's lines form —
 * as sung (flow.pair 1 → 2, a line ending on its rhyme), crossed in an ABAB
 * flow (1+3, 2+4), and the lines left
 * over paired in order (1+2, 3+4…), so a line never stays without a rhyme.
 * The same pairs on the screen and for the AI.
 */
export function coupletsOf<T extends { flow: LineFlow | null }>(lines: T[]): [T, T][] {
  const out: [T, T][] = [];
  const used = new Set<number>();
  // a 4-line flow rhyming ABAB: lines 1+3 and 2+4 of each round
  lines.forEach((l, k) => {
    if (used.has(k) || l.flow?.scheme !== "ABAB" || l.flow.patternLine !== 0) return;
    const four = lines.slice(k, k + 4);
    if (four.length === 4 && four.every((x, j) => x.flow?.flowId === l.flow?.flowId && x.flow?.patternLine === j)) {
      out.push([four[0], four[2]], [four[1], four[3]]);
      [0, 1, 2, 3].forEach((j) => used.add(k + j));
    }
  });
  lines.forEach((l, k) => {
    if (used.has(k) || used.has(k + 1)) return;
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
