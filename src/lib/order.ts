/**
 * Song order of sections: sections anchored on the beat follow their start
 * time; unanchored sections keep their place. The slots held by anchored
 * sections (in stored order) are refilled with the anchored sections sorted
 * by time, so e.g. a "Rap" anchored before the "Hook" moves in front of it.
 */
export function orderSections<T extends { position: number; audio_start: number | null }>(sections: T[]): T[] {
  const byPos = [...sections].sort((a, b) => a.position - b.position);
  const anchored = byPos.filter((s) => s.audio_start !== null).sort((a, b) => a.audio_start! - b.audio_start!);
  let k = 0;
  return byPos.map((s) => (s.audio_start !== null ? anchored[k++] : s));
}
