/**
 * A gentle limiter for a recorded sample: up to −1 dB it stays as it is; louder, it is bent smoothly towards
 * full scale instead of cracking (a microphone turned up a lot, a shout).
 */
export function softClip(x: number) {
  const k = 0.89;
  const a = Math.abs(x);
  if (a <= k) return x;
  return Math.sign(x) * (k + (1 - k) * Math.tanh((a - k) / (1 - k)));
}
