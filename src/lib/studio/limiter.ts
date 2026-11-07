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

/**
 * The vocals' limiter (live and in the export): a voice made loud enough to sit in the beat has peaks above
 * full scale — they are held just under it instead of cracking. Quiet passages pass untouched.
 */
export function vocalLimiter(ctx: BaseAudioContext) {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = -3;
  c.knee.value = 2;
  c.ratio.value = 20;
  c.attack.value = 0.002;
  c.release.value = 0.12;
  return c;
}
