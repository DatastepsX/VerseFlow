"use client";

import { noteSeconds, type FxPreset } from "./presets";

/**
 * A preset as a Web Audio chain (live or offline): filters and EQ →
 * compressor → saturation → the dry voice (widened for doubles), plus sends
 * to a reverb (a generated room: no files to load) and an echo on the
 * song's tempo. Connect a source to `input` and `output` to the speakers.
 */
export interface FxChain {
  input: AudioNode;
  output: AudioNode;
}

export function buildChain(ctx: BaseAudioContext, p: FxPreset, bpm: number): FxChain {
  const input = ctx.createGain();
  const output = ctx.createGain();
  output.gain.value = p.gain ?? 1;
  let node: AudioNode = input;
  const then = (n: AudioNode) => {
    node.connect(n);
    node = n;
  };
  if (p.hpf) then(filter(ctx, "highpass", p.hpf, 0.7));
  if (p.lpf) then(filter(ctx, "lowpass", p.lpf, 0.7));
  for (const b of p.eq ?? []) {
    const f = filter(ctx, b.type, b.f, b.q ?? 0.8);
    f.gain.value = b.gain;
    then(f);
  }
  if (p.comp) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = p.comp.threshold;
    c.ratio.value = p.comp.ratio;
    c.attack.value = p.comp.attack;
    c.release.value = p.comp.release;
    c.knee.value = 6;
    then(c);
    const makeup = ctx.createGain();
    makeup.gain.value = Math.pow(10, p.comp.makeup / 20);
    then(makeup);
  }
  if (p.drive) {
    const ws = ctx.createWaveShaper();
    ws.curve = driveCurve(p.drive);
    ws.oversample = "2x";
    then(ws);
  }
  const voice = node;

  // the dry voice: in the middle, or one side a few ms later (wide)
  if (p.widen) {
    const merge = ctx.createChannelMerger(2);
    const late = ctx.createDelay(0.1);
    late.delayTime.value = p.widen / 1000;
    voice.connect(merge, 0, 0);
    voice.connect(late).connect(merge, 0, 1);
    merge.connect(output);
  } else voice.connect(output);

  if (p.reverb) {
    const pre = ctx.createDelay(0.5);
    pre.delayTime.value = p.reverb.predelay ?? 0.01;
    const conv = ctx.createConvolver();
    conv.buffer = roomImpulse(ctx, p.reverb.seconds, !!p.reverb.bright);
    const wet = ctx.createGain();
    wet.gain.value = p.reverb.mix;
    voice.connect(pre).connect(conv).connect(wet).connect(output);
  }

  if (p.delay) {
    const time = noteSeconds(p.delay.note, bpm);
    const wet = ctx.createGain();
    wet.gain.value = p.delay.mix;
    const tone = (n: AudioNode) => {
      if (!p.delay!.dark) return n;
      const lp = filter(ctx, "lowpass", 3000, 0.7);
      n.connect(lp);
      return lp;
    };
    if (p.delay.pingpong) {
      // left, then right, then left… each repeat a little quieter
      const merge = ctx.createChannelMerger(2);
      const l = ctx.createDelay(4);
      const r = ctx.createDelay(4);
      l.delayTime.value = time;
      r.delayTime.value = time;
      const fb = ctx.createGain();
      fb.gain.value = p.delay.feedback;
      voice.connect(l);
      tone(l).connect(r);
      r.connect(fb).connect(l);
      l.connect(merge, 0, 0);
      r.connect(merge, 0, 1);
      merge.connect(wet).connect(output);
    } else {
      const d = ctx.createDelay(4);
      d.delayTime.value = time;
      const fb = ctx.createGain();
      fb.gain.value = p.delay.feedback;
      voice.connect(d);
      tone(d).connect(fb).connect(d);
      d.connect(wet).connect(output);
    }
  }
  return { input, output };
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, f: number, q: number) {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  return b;
}

/** soft clipping: more drive, more grit */
function driveCurve(amount: number) {
  const k = 1 + amount * 20;
  const n = 2048;
  const curve = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

const impulses = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

/** a room: stereo noise fading out over `seconds` (darker unless bright) — made once per length */
function roomImpulse(ctx: BaseAudioContext, seconds: number, bright: boolean) {
  let cache = impulses.get(ctx);
  if (!cache) impulses.set(ctx, (cache = new Map()));
  const key = `${seconds}|${bright}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * sr));
  const buf = ctx.createBuffer(2, len, sr);
  // a fixed seed: the same room every time
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    const smooth = bright ? 0.15 : 0.55;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      lp = lp * smooth + rnd() * (1 - smooth);
      // -60 dB at the end; a soft start (no click)
      d[i] = lp * Math.exp((-6.9 * t) / seconds) * Math.min(1, t / 0.004);
    }
  }
  cache.set(key, buf);
  return buf;
}
