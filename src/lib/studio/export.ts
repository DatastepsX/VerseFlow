"use client";

import { zipSync } from "fflate";
import type { PlayLayer } from "./engine";
import { softClip } from "./limiter";
import { encodeWav } from "./wav";

/**
 * Stems: every track of the song rendered on its own, each from 0:00 to the song's end — the same length and
 * the same start — so they line up when they are dropped side by side at bar 1 in Logic (or any DAW). WAV
 * (24-bit): an MP3 starts a few milliseconds late (the encoder's padding), which would put stems out of sync.
 */

export interface Stem {
  name: string;
  layers: PlayLayer[];
  /** this channel's volume and pan from the mixer (null: dry, as recorded) */
  channel: { vol: number; pan: number } | null;
  /** a beat: stereo; a voice: mono unless it is panned */
  stereo: boolean;
}

/** one stem, rendered offline (faster than real time) */
export async function renderStem(stem: Stem, seconds: number, sampleRate: number, withFx: boolean): Promise<Float32Array[]> {
  const stereo = stem.stereo || (!!stem.channel && Math.abs(stem.channel.pan) > 0.01) || (!!stem.channel && stem.layers.some((l) => Math.abs(l.pan ?? 0) > 0.01));
  const frames = Math.max(1, Math.ceil(seconds * sampleRate));
  const ctx = new OfflineAudioContext(stereo ? 2 : 1, frames, sampleRate);
  // the channel: volume → pan → out
  const bus = ctx.createGain();
  bus.gain.value = stem.channel?.vol ?? 1;
  let out: AudioNode = bus;
  if (stereo && stem.channel) {
    const p = ctx.createStereoPanner();
    p.pan.value = stem.channel.pan;
    bus.connect(p);
    out = p;
  }
  out.connect(ctx.destination);
  for (const l of stem.layers) {
    const c0 = Math.max(0, l.clip?.from ?? 0);
    const c1 = Math.min(l.buffer.duration, l.clip?.to ?? l.buffer.duration);
    if (c1 <= c0) continue;
    const src = ctx.createBufferSource();
    src.buffer = l.buffer;
    // the cut's edges faded (no click), then the take's own volume (and pan, mixed)
    const g = ctx.createGain();
    const t0 = l.at + c0;
    const t1 = l.at + c1;
    if (l.clip && (c0 > 0 || c1 < l.buffer.duration)) {
      g.gain.setValueAtTime(0, Math.max(0, t0));
      g.gain.linearRampToValueAtTime(1, Math.max(0, t0) + 0.008);
      g.gain.setValueAtTime(1, Math.max(t0 + 0.008, t1 - 0.012));
      g.gain.linearRampToValueAtTime(0, t1);
    }
    const level = ctx.createGain();
    level.gain.value = l.gain ?? 1;
    src.connect(g).connect(level);
    let last: AudioNode = level;
    if (stereo && stem.channel && l.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = l.pan;
      level.connect(p);
      last = p;
    }
    if (withFx && l.fx) {
      const chain = l.fx(ctx);
      last.connect(chain.input);
      chain.output.connect(bus);
    } else last.connect(bus);
    // a take that starts before 0:00 (a pickup recorded early): its part from 0:00 on
    const offset = c0 + Math.max(0, -t0);
    src.start(Math.max(0, t0), offset, c1 - offset);
  }
  const rendered = await ctx.startRendering();
  return Array.from({ length: rendered.numberOfChannels }, (_, k) => rendered.getChannelData(k).map(softClip));
}

export interface ExportSpec {
  song: string;
  stems: Stem[];
  /** the mix: all stems together, as heard */
  mix: Stem[] | null;
  seconds: number;
  sampleRate: number;
  withFx: boolean;
  bpm: number | null;
  /** where bar 1 starts in the song (s) */
  barOne: number;
  onProgress?: (done: number, total: number, what: string) => void;
}

export const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Song";

/** every stem, rendered (and the mix, summed as the mixer has it) */
export async function renderAll(o: ExportSpec): Promise<{ stems: { name: string; channels: Float32Array[] }[]; mix: Float32Array[] | null }> {
  const total = o.stems.length + (o.mix ? 1 : 0);
  let n = 0;
  const stems: { name: string; channels: Float32Array[] }[] = [];
  for (const s of o.stems) {
    o.onProgress?.(n++, total, s.name);
    stems.push({ name: s.name, channels: await renderStem(s, o.seconds, o.sampleRate, o.withFx) });
  }
  let mix: Float32Array[] | null = null;
  if (o.mix) {
    o.onProgress?.(n++, total, "Mix");
    const parts = await Promise.all(o.mix.map((s) => renderStem({ ...s, stereo: true }, o.seconds, o.sampleRate, true)));
    const len = Math.max(...parts.map((p) => p[0].length));
    const sum = [new Float32Array(len), new Float32Array(len)];
    for (const p of parts) for (let c = 0; c < 2; c++) p[Math.min(c, p.length - 1)].forEach((v, i) => (sum[c][i] += v));
    mix = sum.map((c) => c.map(softClip));
  }
  return { stems, mix };
}

/** the note in a ZIP (and on a share page): tempo, sample rate, where bar 1 is, how to open them in Logic */
export function logicNote(o: Pick<ExportSpec, "song" | "bpm" | "sampleRate" | "barOne" | "seconds" | "withFx">) {
  const bar1 = o.barOne > 0.0005 ? `${o.barOne.toFixed(3)} s` : "0:00";
  return [
    `${o.song} — stems from VerseFlow`,
    "",
    `Tempo: ${o.bpm ? `${Math.round(o.bpm * 100) / 100} BPM` : "unknown"}`,
    `Sample rate: ${o.sampleRate} Hz · WAV`,
    `Bar 1 starts at: ${bar1} into each file`,
    `Every file starts at 0:00 and lasts ${o.seconds.toFixed(2)} s, so they line up.`,
    `Sound: ${o.withFx ? "with the mixer (volume, pan, effects)" : "dry — as recorded (each take's own volume kept)"}`,
    "",
    "In Logic Pro:",
    `1. New empty project, set the tempo to ${o.bpm ? Math.round(o.bpm * 100) / 100 : "the song's"} BPM (and the sample rate to ${o.sampleRate / 1000} kHz).`,
    "2. Select all the WAV files and drag them into the tracks area at bar 1 (1 1 1 1).",
    '3. When Logic asks, choose "Create new tracks" and "Place all files on separate tracks".',
    bar1 === "0:00" ? "" : `4. The song's bar 1 is ${bar1} in: to line Logic's bars up with it, move all regions ${bar1} earlier — or leave them: they stay in sync with each other either way.`,
  ]
    .filter((x) => x !== "")
    .join("\n");
}

/** the stems and (optionally) the whole mix as WAVs in one ZIP, with a note on how to open them in Logic */
export async function exportStems(o: ExportSpec): Promise<Blob> {
  const { stems, mix } = await renderAll(o);
  o.onProgress?.(stems.length + (mix ? 1 : 0), stems.length + (mix ? 1 : 0), "ZIP");
  const files: Record<string, Uint8Array> = {};
  stems.forEach((s, i) => (files[`${safeName(o.song)} - ${String(i + 1).padStart(2, "0")} ${safeName(s.name)}.wav`] = encodeWav(s.channels, o.sampleRate, 24)));
  if (mix) files[`${safeName(o.song)} - Mix.wav`] = encodeWav(mix, o.sampleRate, 24);
  files["How to open in Logic.txt"] = new TextEncoder().encode(logicNote(o));
  const zip = zipSync(files, { level: 0 });
  return new Blob([zip.buffer as ArrayBuffer], { type: "application/zip" });
}

/** an MP3 (LAME, constant bit rate) of a stereo or mono signal — encoded in steps, the page stays responsive */
export async function encodeMp3(channels: Float32Array[], sampleRate: number, kbps = 256, onProgress?: (part: number) => void): Promise<Uint8Array> {
  const { Mp3Encoder } = await import("@breezystack/lamejs");
  const stereo = channels.length > 1;
  const enc = new Mp3Encoder(stereo ? 2 : 1, sampleRate, kbps);
  const toInt = (x: Float32Array, a: number, b: number) => {
    const out = new Int16Array(b - a);
    for (let i = a; i < b; i++) {
      const v = Math.max(-1, Math.min(1, x[i]));
      out[i - a] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  };
  const parts: Uint8Array[] = [];
  const len = channels[0].length;
  const block = 1152 * 64;
  for (let a = 0; a < len; a += block) {
    const b = Math.min(len, a + block);
    const chunk = enc.encodeBuffer(toInt(channels[0], a, b), stereo ? toInt(channels[1], a, b) : undefined);
    if (chunk.length) parts.push(chunk);
    onProgress?.(b / len);
    if ((a / block) % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
  const end = enc.flush();
  if (end.length) parts.push(end);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
