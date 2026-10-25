/**
 * A part made longer: bars of the beat repeated at a point of the song, the
 * rest of the song coming later. The uploaded file never changes — the
 * project's `settings.extensions` say where bars were added (in song time
 * as it was when each was added) and they are applied in order when the song
 * is loaded. Times stored in the project (parts, lines, takes) are already in
 * the extended song's time.
 */

export interface Extension {
  /** where the bars go in (a bar line: the end of the part) */
  at: number;
  /** where the repeated bars start (the part's last bars; repeated if the part is shorter) */
  from: number;
  /** where they end (a part pasted elsewhere); none: at `at` (a part made longer) */
  to?: number;
  /** the bars with the original vocals (a part pasted with its vocals on); else the music alone, when there is one */
  vocals?: boolean;
  /** how long (whole bars, in seconds) */
  len: number;
}

const FADE = 0.008;

/**
 * One channel with the extensions applied. `src` = what the added bars are taken from (the music without
 * vocals when the song was split, so the new bars are free to write on), extended in step with `data`.
 */
export function extendSamples(data: Float32Array, sr: number, extensions: Extension[], src?: Float32Array): { data: Float32Array; src: Float32Array | undefined } {
  let out = data;
  let from = src;
  for (const e of extensions) {
    const at = Math.max(0, Math.min(out.length, Math.round(e.at * sr)));
    const a = Math.max(0, Math.min(out.length, Math.round(e.from * sr)));
    const b = Math.max(a, Math.min(out.length, Math.round((e.to ?? e.at) * sr)));
    const n = Math.max(0, Math.round(e.len * sr));
    if (!n || b <= a) continue;
    const piece = (base: Float32Array) => {
      const p = new Float32Array(n);
      // the bars copied, again and again if they are shorter than what is added
      for (let i = 0; i < n; i++) p[i] = base[a + (i % (b - a))] ?? 0;
      return p;
    };
    const splice = (x: Float32Array, add: Float32Array) => {
      const y = new Float32Array(x.length + n);
      y.set(x.subarray(0, at), 0);
      y.set(add, at);
      y.set(x.subarray(at), at + n);
      // short crossfades at both seams: no clicks
      const f = Math.min(Math.round(FADE * sr), n >> 1);
      for (let i = 0; i < f; i++) {
        const k = i / f;
        y[at + i] = add[i] * k + (x[at + i] ?? 0) * (1 - k);
        y[at + n - f + i] = add[n - f + i] * (1 - k) + (x[at - f + i] ?? 0) * k;
      }
      return y;
    };
    // the music alone gets the music; the song gets the music too, unless the bars keep their vocals
    const music = from ? piece(from) : undefined;
    out = splice(out, e.vocals || !music ? piece(out) : music);
    if (from) from = splice(from, music!);
  }
  return { data: out, src: from };
}

/** the song (and its music without vocals) with the extensions applied */
export function extendBuffers(ctx: BaseAudioContext, full: AudioBuffer, music: AudioBuffer | null, extensions: Extension[]) {
  if (!extensions.length) return { full, music };
  const make = (chs: Float32Array[], sr: number) => {
    const b = ctx.createBuffer(chs.length, chs[0].length, sr);
    chs.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    return b;
  };
  const fullChs: Float32Array[] = [];
  const musicChs: Float32Array[] = [];
  for (let c = 0; c < full.numberOfChannels; c++) {
    const m = music ? music.getChannelData(Math.min(c, music.numberOfChannels - 1)) : undefined;
    const r = extendSamples(full.getChannelData(c), full.sampleRate, extensions, m);
    fullChs.push(r.data);
    if (r.src) musicChs.push(r.src);
  }
  return { full: make(fullChs, full.sampleRate), music: music && musicChs.length ? make(musicChs, full.sampleRate) : null };
}
