/**
 * Timing of a recording against the song.
 *
 * The beat and the recorder run on the same audio clock: song position s is
 * played at clock time base + s. A sound sung on the beat reaches the
 * recorder `latency` seconds later (output + input latency), so recorded
 * clock time t belongs to song position t - base - latency.
 */
export function songTimeOfFrame(frame: number, sampleRate: number, base: number, latency: number) {
  return frame / sampleRate - base - latency;
}

/** what a take of a section records: from the count-in to a bar after the section */
export function takeWindow(range: { start: number; end: number }, bar: number, countInBars: number, tailBars = 1) {
  return { from: range.start - countInBars * bar, to: range.end + tailBars * bar };
}

/**
 * Latency calibration: clicks were played at `clickTimes` (clock seconds)
 * and recorded starting at clock time `recStart`. Finds each click in the
 * recording (first sample above a threshold after it) and returns the median
 * delay in seconds, or null when the clicks weren't heard.
 */
export function measureLatency(rec: Float32Array, sampleRate: number, recStart: number, clickTimes: number[], maxDelay = 0.5): number | null {
  let peak = 0;
  for (let i = 0; i < rec.length; i++) peak = Math.max(peak, Math.abs(rec[i]));
  if (peak < 0.02) return null;
  const threshold = peak * 0.35;
  const delays: number[] = [];
  for (const t of clickTimes) {
    const from = Math.max(0, Math.floor((t - recStart) * sampleRate));
    const to = Math.min(rec.length, from + Math.floor(maxDelay * sampleRate));
    for (let i = from; i < to; i++) {
      if (Math.abs(rec[i]) >= threshold) {
        delays.push(i / sampleRate + recStart - t);
        break;
      }
    }
  }
  if (delays.length < Math.ceil(clickTimes.length / 2)) return null;
  delays.sort((a, b) => a - b);
  return delays[Math.floor(delays.length / 2)];
}
