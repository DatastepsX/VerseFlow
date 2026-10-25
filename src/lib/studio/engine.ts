"use client";

import { measureClaps, measureLatency, songTimeOfFrame } from "./timing";

/**
 * The studio's audio engine (browser): the beat, other takes and the
 * recorder all run on one AudioContext clock, so a take lands on the beat
 * to the sample. Song position s plays at clock time `base + s`.
 *
 * Input is taken raw (no echo cancellation / noise suppression / auto gain)
 * from the chosen device; monitoring is left to the audio interface (direct
 * monitoring) — the browser would add delay.
 */

export interface PlayLayer {
  buffer: AudioBuffer;
  /** song position where the buffer starts */
  at: number;
  gain?: number;
  /** its sound: an effect chain built for this playback (see lib/fx) */
  fx?: (ctx: BaseAudioContext) => { input: AudioNode; output: AudioNode };
  /** a cut take: only this part of the buffer plays (seconds of the buffer; `at` stays where the buffer starts) */
  clip?: { from: number; to: number | null };
  /** its mixer channel ("lane:Lead", "flow"…): turned up / down live with setVolume */
  bus?: string;
  /** a take's id: its own volume can change while it plays (setLayerGain) */
  id?: string;
}

export interface Recording {
  samples: Float32Array;
  sampleRate: number;
  /** song position of samples[0] (latency removed) */
  startAt: number;
}

const workletReady = new WeakSet<BaseAudioContext>();
/** the AudioContexts open in this tab */
const open = new Set<AudioContext>();
let unlockInstalled = false;

/**
 * A browser plays sound only after a click on the page: any click or key anywhere resumes every AudioContext
 * open in the tab. (Each song page has its own context, made fresh — a long-lived one can stay on an old
 * audio route in Safari, and record next to nothing.)
 */
function installUnlock() {
  if (unlockInstalled) return;
  unlockInstalled = true;
  const unlock = () => {
    for (const c of open) if (c.state !== "running") void c.resume().catch(() => {});
  };
  for (const ev of ["pointerdown", "keydown", "touchend"]) window.addEventListener(ev, unlock, { capture: true });
}

/** sound can play in this tab: the song's sound runs (no song open: the page was clicked once) */
export function soundAllowed() {
  if (open.size) return [...open].every((c) => c.state === "running");
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return !!ua?.hasBeenActive;
}

export class StudioEngine {
  ctx: AudioContext;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private recorder: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private playing: AudioScheduledSourceNode[] = [];
  /** the effect chains of what plays (cut off on stop) */
  private chains: AudioNode[] = [];
  /** the mixer: a channel per key, its volume kept between plays */
  private buses = new Map<string, GainNode>();
  private volumes = new Map<string, number>();
  /** what plays now, by take id: its volume */
  private layerGains = new Map<string, GainNode>();
  private chunks: { frame: number; channels: Float32Array[] }[] = [];
  private onDone: (() => void) | null = null;
  base = 0;
  /** what the hardware reports (output + input), used until calibrated */
  reportedLatency = 0;

  constructor() {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: "interactive" });
    open.add(this.ctx);
    installUnlock();
  }

  get armed() {
    return !!this.recorder;
  }

  /** needs a click (browsers allow audio + microphone only after a user gesture) */
  /**
   * voiceProcessing: the browser's echo cancellation / noise suppression / auto gain — for a flow
   * recorded without headphones (the beat from the speaker is mostly removed); studio takes stay raw
   */
  private arming: Promise<string> | null = null;
  /** one microphone request at a time: asked twice at once, a browser (Safari) can hand back a silent stream */
  arm(deviceId?: string, opts: { voiceProcessing?: boolean } = {}) {
    if (!this.arming) this.arming = this.armNow(deviceId, opts).finally(() => (this.arming = null));
    return this.arming;
  }

  /** the microphone is on and really sending (not ended or muted by the browser) */
  get inputAlive() {
    const t = this.stream?.getAudioTracks()[0];
    return !!this.recorder && !!t && t.readyState === "live" && t.enabled && !t.muted;
  }

  private async armNow(deviceId?: string, opts: { voiceProcessing?: boolean } = {}) {
    // without a click the sound can't start yet (it waits for one): the microphone goes on all the same
    await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
    this.disarm();
    const vp = !!opts.voiceProcessing;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: vp,
        noiseSuppression: vp,
        autoGainControl: vp,
        channelCount: { ideal: 2 },
      },
    });
    if (!workletReady.has(this.ctx)) {
      await this.ctx.audioWorklet.addModule("/recorder-worklet.js");
      workletReady.add(this.ctx);
    }
    this.wire();
    const track = this.stream.getAudioTracks()[0];
    const inLat = (track?.getSettings() as { latency?: number }).latency ?? 0;
    const ctx = this.ctx as AudioContext & { outputLatency?: number };
    this.reportedLatency = (ctx.baseLatency ?? 0) + (ctx.outputLatency ?? 0) + inLat;
    return track?.label ?? "Microphone";
  }

  private mute: GainNode | null = null;
  /** the microphone into the recorder and the level meter */
  private wire() {
    if (!this.stream) return;
    this.source?.disconnect();
    this.recorder?.disconnect();
    this.mute?.disconnect();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.recorder = new AudioWorkletNode(this.ctx, "vf-recorder", { numberOfInputs: 1, numberOfOutputs: 1, channelCountMode: "explicit", channelCount: 2 });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    // the recorder must be pulled by the graph to run: route it to a silent output
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.source.connect(this.recorder).connect(this.mute).connect(this.ctx.destination);
    this.source.connect(this.analyser);
    this.recorder.port.onmessage = (e) => {
      if (e.data?.done) this.onDone?.();
      else if (e.data?.channels) this.chunks.push(e.data);
    };
  }

  /**
   * Ready to record: the sound runs (it may wait for a click on the page — false then), and the microphone is
   * wired again now that it runs (Safari can feed silence through a connection made while it was paused).
   */
  async readyToRecord() {
    if (this.ctx.state !== "running") await Promise.race([this.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
    if (this.ctx.state !== "running") return false;
    this.wire();
    return true;
  }

  /** what the microphone and the sound are doing (for the diagnostics of a failed take) */
  info() {
    const t = this.stream?.getAudioTracks()[0];
    const st = (t?.getSettings() ?? {}) as MediaTrackSettings & { latency?: number };
    return {
      ctx: this.ctx.state,
      ctxRate: this.ctx.sampleRate,
      track: t ? { label: t.label, state: t.readyState, muted: t.muted, enabled: t.enabled } : null,
      settings: { sampleRate: st.sampleRate, channelCount: st.channelCount, echoCancellation: st.echoCancellation, autoGainControl: st.autoGainControl, noiseSuppression: st.noiseSuppression },
      lastTake: this.lastTake,
    };
  }
  /** the last take as the recorder got it: its batches, and each input's loudest sample */
  lastTake: { chunks: number; channels: number; peaks: number[] } | null = null;

  disarm() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.recorder?.disconnect();
    this.mute?.disconnect();
    this.stream = null;
    this.source = null;
    this.recorder = null;
  }

  async inputs() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "audioinput").map((d) => ({ id: d.deviceId, label: d.label || "Input" }));
  }

  /** input level 0..1 (peak of the last few ms) */
  level() {
    if (!this.analyser) return 0;
    const a = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(a);
    let m = 0;
    for (const v of a) m = Math.max(m, Math.abs(v));
    return m;
  }

  async decode(data: ArrayBuffer) {
    return this.ctx.decodeAudioData(data);
  }

  /** current song position while playing */
  position() {
    return this.ctx.currentTime - this.base;
  }

  private click(when: number, accent: boolean) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.6, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g).connect(this.ctx.destination);
    o.start(when);
    o.stop(when + 0.06);
    this.playing.push(o);
  }

  /**
   * Plays from song position `from`: the beat and layers (each from where it
   * starts), plus metronome clicks at the given song positions. Returns the
   * clock base (song position s plays at base + s).
   */
  play(from: number, opts: { beat: AudioBuffer | null; layers?: PlayLayer[]; clicks?: { at: number; accent: boolean }[]; beatGain?: number }) {
    this.stop();
    const start = this.ctx.currentTime + 0.12;
    this.base = start - from;
    this.layerGains.clear();
    const schedule = (buffer: AudioBuffer, at: number, gainValue: number, fx?: PlayLayer["fx"], clip?: PlayLayer["clip"], bus?: string, id?: string) => {
      // a cut take: only [c0, c1] of the buffer, at its place in the song
      const c0 = Math.max(0, clip?.from ?? 0);
      const c1 = Math.min(buffer.duration, clip?.to ?? buffer.duration);
      const offset = c0 + Math.max(0, from - (at + c0));
      if (offset >= c1) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      // g: the cut's fades; level: the take's volume; then its sound; then its mixer channel
      const g = this.ctx.createGain();
      src.connect(g);
      const level = this.ctx.createGain();
      level.gain.value = gainValue;
      g.connect(level);
      if (id) this.layerGains.set(id, level);
      this.chains.push(level);
      const out = bus ? this.bus(bus) : this.ctx.destination;
      if (fx) {
        const chain = fx(this.ctx);
        level.connect(chain.input);
        chain.output.connect(out);
        this.chains.push(chain.output);
      } else level.connect(out);
      // a short fade at a cut's edges: no click
      if (clip && (c0 > 0 || c1 < buffer.duration)) {
        const t0 = this.base + Math.max(at + c0, from);
        const t1 = t0 + (c1 - offset);
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(1, t0 + 0.008);
        g.gain.setValueAtTime(1, Math.max(t0 + 0.008, t1 - 0.012));
        g.gain.linearRampToValueAtTime(0, t1);
      }
      src.start(this.base + Math.max(at + c0, from), offset, c1 - offset);
      this.playing.push(src);
    };
    if (opts.beat) schedule(opts.beat, 0, opts.beatGain ?? 1, undefined, undefined, "beat");
    for (const l of opts.layers ?? []) schedule(l.buffer, l.at, l.gain ?? 1, l.fx, l.clip, l.bus, l.id);
    for (const c of opts.clicks ?? []) if (c.at >= from) this.click(this.base + c.at, c.accent);
    return this.base;
  }

  /** a mixer channel's volume (1: as is), live — also for what plays now */
  setVolume(key: string, v: number) {
    this.volumes.set(key, v);
    const b = this.buses.get(key);
    if (b) b.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** a take's own volume while it plays */
  setLayerGain(id: string, v: number) {
    this.layerGains.get(id)?.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  private bus(key: string) {
    let b = this.buses.get(key);
    if (!b) {
      b = this.ctx.createGain();
      b.gain.value = this.volumes.get(key) ?? 1;
      b.connect(this.ctx.destination);
      this.buses.set(key, b);
    }
    return b;
  }

  stop() {
    for (const s of this.playing) {
      try {
        s.stop();
      } catch {}
    }
    this.playing = [];
    // echo and reverb tails stop too
    for (const c of this.chains) c.disconnect();
    this.chains = [];
  }

  /** start recording now (call right after play()) */
  startRecording() {
    if (!this.recorder) throw new Error("Arm the studio first.");
    this.chunks = [];
    this.recorder.port.postMessage("start");
  }

  /**
   * Stops recording and playback. `channel` 0 / 1 = interface input 1 / 2,
   * -1 = both mixed. The result starts at song position max(keepFrom, 0).
   */
  async stopRecording(latency: number, channel: number, keepFrom: number): Promise<Recording | null> {
    if (!this.recorder) return null;
    const done = new Promise<void>((r) => (this.onDone = r));
    this.recorder.port.postMessage("stop");
    await Promise.race([done, new Promise((r) => setTimeout(r, 1500))]);
    this.stop();
    const chunks = this.chunks;
    this.chunks = [];
    const nch = chunks[0]?.channels.length ?? 0;
    this.lastTake = {
      chunks: chunks.length,
      channels: nch,
      peaks: Array.from({ length: nch }, (_, k) => Math.round(chunks.reduce((m, c) => c.channels[k].reduce((a, v) => Math.max(a, Math.abs(v)), m), 0) * 10000) / 10000),
    };
    if (!chunks.length) return null;
    const sr = this.ctx.sampleRate;
    const total = chunks.reduce((n, c) => n + c.channels[0].length, 0);
    // the input chosen is silent but the other one isn't (a microphone on input 1 with input 2 chosen): the other
    const silentIn = (k: number) => chunks.every((c) => !c.channels[k] || c.channels[k].every((v) => v === 0));
    if (channel >= 0 && chunks[0].channels.length > 1 && silentIn(Math.min(channel, chunks[0].channels.length - 1))) {
      const other = channel === 0 ? 1 : 0;
      if (!silentIn(other)) channel = other;
    }
    const mono = new Float32Array(total);
    let o = 0;
    for (const c of chunks) {
      const a = c.channels[Math.min(Math.max(0, channel), c.channels.length - 1)];
      const b = channel < 0 && c.channels.length > 1 ? c.channels[1] : null;
      for (let i = 0; i < a.length; i++) mono[o + i] = b ? (a[i] + b[i]) / 2 : a[i];
      o += a.length;
    }
    const first = songTimeOfFrame(chunks[0].frame, sr, this.base, latency);
    // drop what was recorded before the take window (and before the song starts)
    const from = Math.max(0, keepFrom);
    const skip = Math.max(0, Math.round((from - first) * sr));
    if (skip >= mono.length) return null;
    return { samples: mono.subarray(skip), sampleRate: sr, startAt: first + skip / sr };
  }

  /**
   * Latency calibration: plays clicks and records them back (hold the
   * headphones to the mic, or loop an output into an input). Returns the
   * round-trip delay in seconds, or null when the clicks weren't heard.
   */
  async calibrate(channel: number): Promise<number | null> {
    if (!this.recorder) throw new Error("Arm the studio first.");
    const clicks = Array.from({ length: 6 }, (_, i) => ({ at: 0.4 + i * 0.5, accent: false }));
    this.play(0, { beat: null, clicks });
    const base = this.base;
    this.startRecording();
    await new Promise((r) => setTimeout(r, (0.4 + 6 * 0.5 + 0.5) * 1000));
    const rec = await this.stopRecording(0, channel, -10);
    if (!rec) return null;
    // stopRecording returns song time with latency 0 = clock time - base
    return measureLatency(rec.samples, rec.sampleRate, rec.startAt + base, clicks.map((c) => base + c.at));
  }

  /**
   * Latency by ear: 4 count-in clicks, then 8 clicks to clap (or say "ta") on. Returns the delay in seconds
   * (null: the claps weren't heard, or scattered too much).
   */
  async calibrateClaps(channel: number): Promise<{ delay: number; spread: number; found: number } | null> {
    if (!this.recorder) throw new Error("Arm the studio first.");
    const beat = 0.6;
    const clicks = Array.from({ length: 12 }, (_, i) => ({ at: 0.5 + i * beat, accent: i < 4 ? i === 0 : (i - 4) % 4 === 0 }));
    this.play(0, { beat: null, clicks });
    const base = this.base;
    this.startRecording();
    await new Promise((r) => setTimeout(r, (0.5 + 12 * beat + 0.6) * 1000));
    const rec = await this.stopRecording(0, channel, -10);
    this.stop();
    if (!rec) return null;
    return measureClaps(rec.samples, rec.sampleRate, rec.startAt + base, clicks.slice(4).map((c) => base + c.at));
  }

  close() {
    this.stop();
    this.disarm();
    open.delete(this.ctx);
    void this.ctx.close();
  }
}
