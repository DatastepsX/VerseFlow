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

/**
 * Latency by ear: clicks were played at `clickTimes` (clock seconds) and the writer clapped (or said "ta") on
 * each one, recorded from clock time `recStart`. Each clap is the loudest sound near its click — its onset where
 * it rises through half its peak — and the delay is the median of clap − click: the hardware's round trip plus
 * where this writer feels the beat, which is what lines a take up with the song. Works with echo cancellation
 * (no headphones): the clicks themselves are filtered out, the claps aren't. Null when fewer than half the claps
 * were found or they scatter too much (`spread`, s: the middle half of the delays).
 */
export function measureClaps(
  rec: Float32Array,
  sampleRate: number,
  recStart: number,
  clickTimes: number[],
): { delay: number; spread: number; found: number } | null {
  const hop = Math.max(1, Math.round(sampleRate * 0.005));
  const env = new Float32Array(Math.floor(rec.length / hop));
  for (let f = 0; f < env.length; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) e += rec[i] * rec[i];
    env[f] = Math.sqrt(e / hop);
  }
  const sorted = Float32Array.from(env).sort();
  const noise = sorted[Math.floor(env.length * 0.3)] ?? 0;
  const frameOf = (t: number) => Math.round(((t - recStart) * sampleRate) / hop);
  const delays: number[] = [];
  for (const t of clickTimes) {
    // a clap a little early still counts; a late one up to 0.4 s
    const a = Math.max(1, frameOf(t - 0.15));
    const b = Math.min(env.length, frameOf(t + 0.4));
    let top = a;
    for (let f = a; f < b; f++) if (env[f] > env[top]) top = f;
    if (env[top] < Math.max(noise * 6, 0.01)) continue;
    let on = top;
    while (on > a && env[on - 1] > env[top] * 0.5) on--;
    delays.push((on * hop) / sampleRate + recStart - t);
  }
  if (delays.length < Math.ceil(clickTimes.length / 2)) return null;
  delays.sort((x, y) => x - y);
  const q = (p: number) => delays[Math.min(delays.length - 1, Math.floor(p * delays.length))];
  const spread = q(0.75) - q(0.25);
  if (spread > 0.08) return null;
  return { delay: q(0.5), spread, found: delays.length };
}
