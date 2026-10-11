"use client";

import { analyseBeat, type BeatChange } from "./structure";
import { detectTempo, waveformPeaks, type TempoResult } from "./tempo";

export interface AudioAnalysis {
  duration: number;
  tempo: TempoResult;
  /** beat changes on the fitted grid */
  changes: BeatChange[];
  peaks: number[];
}

/** Decode an audio file/blob in the browser; returns mono samples (≤ 22 kHz) and duration. */
export async function decodeAudio(data: Blob): Promise<{ mono: Float32Array; sampleRate: number; duration: number }> {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const buf = await ctx.decodeAudioData(await data.arrayBuffer());
    // mix down to mono and decimate to ≤ 22 kHz — plenty for beat tracking, 2× faster
    const step = buf.sampleRate > 30000 ? 2 : 1;
    const len = Math.floor(buf.length / step);
    const mono = new Float32Array(len);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += ch[i * step] / buf.numberOfChannels;
    }
    return { mono, sampleRate: buf.sampleRate / step, duration: buf.duration };
  } finally {
    void ctx.close();
  }
}

export async function analyzeAudio(data: Blob, buckets = 600): Promise<AudioAnalysis> {
  const { mono, sampleRate, duration } = await decodeAudio(data);
  // analyse at most the first 3 minutes for tempo; the grid is constant for most beats
  const slice = mono.subarray(0, Math.min(mono.length, Math.floor(sampleRate * 180)));
  const tempo = detectTempo(slice, sampleRate);
  if (!tempo.bpm) return { duration, tempo, changes: [], peaks: waveformPeaks(mono, buckets) };
  // exact tempo + bar 1 over the whole song, and where the beat changes
  const beat = analyseBeat(mono, sampleRate, tempo.bpm);
  return { duration, tempo: { ...tempo, bpm: beat.bpm, offset: beat.offset }, changes: beat.changes, peaks: waveformPeaks(mono, buckets) };
}
