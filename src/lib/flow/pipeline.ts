"use client";

import type { TimedWord } from "@/lib/audio/lyrics";
import type { Recording } from "@/lib/studio/engine";
import { encodeWav, peaksOf, resample } from "@/lib/studio/wav";
import type { ProjectTree } from "@/lib/types";
import { flowLines } from "./lines";
import { detectSyllables } from "./syllables";

/** lines suggested per AI call (couplets stay together); the calls run in parallel */
export const FLOW_CHUNK = 8;

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export type FlowStep = "rhythm" | "upload" | "words" | "song" | "suggest";

/**
 * After the flow was recorded: rhythm (on the phone) → upload (16 kHz, small)
 * → words (1 recognition call) → one line per sung bar → 3 suggestions per
 * line (1 AI call per ~8 lines, in parallel). Returns the song.
 */
export async function processFlow(
  pid: string,
  tree: ProjectTree,
  rec: Recording,
  onStep: (step: FlowStep, progress?: { done: number; total: number }) => void,
  onTree: (t: ProjectTree) => void,
): Promise<{ tree: ProjectTree; takeId: string; wordsFailed: string | null }> {
  const audio = tree.audio!;
  onStep("rhythm");
  await new Promise((r) => setTimeout(r, 30)); // let the step show before the analysis runs
  const syllables = detectSyllables(rec.samples, rec.sampleRate);
  if (syllables.length < 4) throw new Error("No singing was heard in the recording — check the microphone and try again.");

  onStep("upload");
  const small = resample(rec.samples, rec.sampleRate, 16000);
  const wav = encodeWav([small], 16000, 16);
  const up = await post<{ path: string; signedUrl: string }>(`/api/projects/${pid}/takes`, { action: "uploadUrl" });
  const fd = new FormData();
  fd.append("cacheControl", "3600");
  fd.append("", new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }), "flow.wav");
  const put = await fetch(up.signedUrl, { method: "PUT", body: fd, headers: { "x-upsert": "false" } });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  const saved = await fetch(`/api/projects/${pid}/takes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "save",
      path: up.path,
      section_id: null,
      lane: "Flow",
      start_at: Math.round(rec.startAt * 100000) / 100000,
      duration: small.length / 16000,
      sample_rate: 16000,
      peaks: peaksOf(small, 200),
    }),
  });
  if (!saved.ok) throw new Error("Saving the recording failed");
  const takeId = saved.headers.get("x-take-id") ?? "";

  onStep("words");
  let words: TimedWord[] = [];
  let wordsFailed: string | null = null;
  try {
    const r = await post<{ words: TimedWord[] }>(`/api/projects/${pid}/flow`, { action: "transcribe", takeId });
    // word times are from the start of the recording → song time
    words = r.words.map((w) => ({ ...w, start: w.start + rec.startAt, end: w.end + rec.startAt }));
  } catch (e) {
    // the rhythm alone still makes a song: carry on without words
    wordsFailed = e instanceof Error ? e.message : "Word recognition failed";
  }

  onStep("song");
  const lines = flowLines(syllables, words, audio, { offset: rec.startAt, lang: tree.project.language, duration: audio.duration ?? rec.startAt + rec.samples.length / rec.sampleRate });
  let t = await post<ProjectTree>(`/api/projects/${pid}/flow`, { action: "build", lines });
  onTree(t);

  // 3 suggestions per line: chunks of whole couplets per section, all at once
  const chunks: string[][] = [];
  for (const s of t.sections) {
    const ids = s.lines.filter((l) => l.kind === "lyric").map((l) => l.id);
    for (let i = 0; i < ids.length; i += FLOW_CHUNK) chunks.push(ids.slice(i, i + FLOW_CHUNK));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  let done = 0;
  onStep("suggest", { done, total });
  const results = await Promise.allSettled(
    chunks.map(async (ids) => {
      const r = await post<ProjectTree>(`/api/projects/${pid}/flow`, { action: "suggest", lineIds: ids });
      done += ids.length;
      onStep("suggest", { done, total });
      onTree(r);
      return r;
    }),
  );
  // the newest state (responses can arrive out of order)
  t = (await fetch(`/api/projects/${pid}`).then((r) => r.json())) as ProjectTree;
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed === results.length && results.length) {
    const why = (results[0] as PromiseRejectedResult).reason;
    throw new Error(why instanceof Error ? why.message : "Writing the suggestions failed");
  }
  return { tree: t, takeId, wordsFailed };
}
