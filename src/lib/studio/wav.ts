/**
 * WAV encoding for recorded takes and exports: PCM 24-bit (studio standard,
 * what Logic expects), any channel count, interleaved.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number, bits: 16 | 24 = 24): Uint8Array {
  const nch = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytes = bits / 8;
  const dataLen = frames * nch * bytes;
  const buf = new Uint8Array(44 + dataLen);
  const view = new DataView(buf.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, nch, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * nch * bytes, true);
  view.setUint16(32, nch * bytes, true);
  view.setUint16(34, bits, true);
  str(36, "data");
  view.setUint32(40, dataLen, true);
  let o = 44;
  const max = bits === 24 ? 0x7fffff : 0x7fff;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      const s = Math.round(v < 0 ? v * (max + 1) : v * max);
      if (bits === 24) {
        buf[o++] = s & 0xff;
        buf[o++] = (s >> 8) & 0xff;
        buf[o++] = (s >> 16) & 0xff;
      } else {
        view.setInt16(o, s, true);
        o += 2;
      }
    }
  }
  return buf;
}

/** max |amplitude| per bucket, 0..1 — a small waveform for the takes list */
export function peaksOf(samples: Float32Array, buckets = 160): number[] {
  const size = Math.max(1, Math.floor(samples.length / buckets));
  const out: number[] = [];
  for (let b = 0; b < buckets && b * size < samples.length; b++) {
    let m = 0;
    for (let i = b * size; i < Math.min(samples.length, (b + 1) * size); i++) m = Math.max(m, Math.abs(samples[i]));
    out.push(Math.round(Math.min(1, m) * 100) / 100);
  }
  return out;
}
