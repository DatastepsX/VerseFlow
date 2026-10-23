"use client";

import type { TimedWord } from "@/lib/audio/lyrics";
import type { Recording } from "@/lib/studio/engine";
import { encodeWav, peaksOf, resample } from "@/lib/studio/wav";
import type { Line, ProjectTree } from "@/lib/types";
import { flowLines } from "./lines";
import { detectSyllables } from "./syllables";
import { emptyParts, vocalLines } from "./vocals";

/** lines suggested per AI call (couplets stay together); the calls run in parallel */
export const FLOW_CHUNK = 8;

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** ~FLOW_CHUNK lines per AI call, never splitting a couplet (both lines are written together, rhyming) */
export function chunkLines(lines: Pick<Line, "id" | "flow">[]): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  lines.forEach((l, k) => {
    cur.push(l.id);
    if (cur.length >= FLOW_CHUNK && !(l.flow?.pair === 1 && lines[k + 1]?.flow?.pair === 2)) {
      chunks.push(cur);
      cur = [];
    }
  });
  if (cur.length) chunks.push(cur);
  return chunks;
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
  /** a flow recorded for one part only: its lines are replaced, the rest of the song stays */
  part?: { sectionId: string; start: number; end: number },
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
      section_id: part?.sectionId ?? null,
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
  let lines = flowLines(syllables, words, audio, { offset: rec.startAt, lang: tree.project.language, duration: audio.duration ?? rec.startAt + rec.samples.length / rec.sampleRate });
  if (part) {
    // the part's own lines: sung inside it (the count-in bar before it is only for getting in)
    lines = lines.filter((l) => l.sungAt >= part.start - 0.4 && l.sungAt < part.end);
    if (!lines.length) throw new Error("No singing was heard in this part — try again.");
    const t = await post<ProjectTree>(`/api/projects/${pid}/flow`, { action: "buildPart", sectionId: part.sectionId, lines });
    onTree(t);
    return { tree: await suggestAll(pid, t, onStep, onTree, (l, s) => s.id === part.sectionId), takeId, wordsFailed };
  }
  const t = await post<ProjectTree>(`/api/projects/${pid}/flow`, { action: "build", lines });
  onTree(t);
  return { tree: await suggestAll(pid, t, onStep, onTree), takeId, wordsFailed };
}

/**
 * A song with vocals on it: the words are read from the track itself (1
 * recognition call, stored), every sung bar becomes a line with the recorded
 * words as its text and their rhythm as its pattern, then 3 alternatives per
 * line that fit that rhythm.
 */
export async function processVocals(
  pid: string,
  tree: ProjectTree,
  onStep: (step: FlowStep, progress?: { done: number; total: number }) => void,
  onTree: (t: ProjectTree) => void,
): Promise<ProjectTree> {
  const audio = tree.audio!;
  onStep("words");
  const { words } = await post<{ words: TimedWord[] }>(`/api/projects/${pid}/flow`, { action: "vocals" });
  onStep("song");
  const duration = audio.duration ?? (words.at(-1)?.end ?? 0) + 2;
  const lines = vocalLines(words, audio, { lang: tree.project.language, duration });
  if (!lines.length) throw new Error("No vocals were found in this song — record your flow instead.");
  // the parts without vocals: empty lines, written later (record a flow for the part, or ✨)
  const parts = emptyParts(lines, audio, duration);
  const t = await post<ProjectTree>(`/api/projects/${pid}/flow`, { action: "build", lines, source: "vocals", parts });
  onTree(t);
  return suggestAll(pid, t, onStep, onTree, (l) => !!l.flow);
}

/** 3 suggestions per line: chunks of whole couplets per section, all at once */
async function suggestAll(
  pid: string,
  t: ProjectTree,
  onStep: (step: FlowStep, progress?: { done: number; total: number }) => void,
  onTree: (t: ProjectTree) => void,
  which: (l: Line, s: ProjectTree["sections"][number]) => boolean = () => true,
) {
  const chunks = t.sections.flatMap((s) => chunkLines(s.lines.filter((l) => l.kind === "lyric" && which(l, s))));
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
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed === results.length && results.length) {
    const why = (results[0] as PromiseRejectedResult).reason;
    throw new Error(why instanceof Error ? why.message : "Writing the suggestions failed");
  }
  // the newest state (responses can arrive out of order)
  return (await fetch(`/api/projects/${pid}`).then((r) => r.json())) as ProjectTree;
}
