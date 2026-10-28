"use client";

import type { ProjectTree, Take } from "@/lib/types";
import { toGrid, toGuide } from "./align";
import { encodeWav, peaksOf } from "./wav";

/**
 * Syncing takes, in the browser: a take's audio is fetched, brought on the beat (or made to follow the
 * part's Lead) and saved as a new take of its layer — chosen, with the same cut, volume and pan. The take it
 * came from stays, so it can be chosen again. No AI call.
 */

/** below this, a take doesn't sing what the Lead sings (lib/studio/align: toGuide's match) */
const MIN_MATCH = 0.2;

export type SyncMode = { to: "beat"; grid: 4 | 2; strength: number } | { to: "lead" };

export interface SyncJob {
  take: Take;
  mode: SyncMode;
}

/** the part's Lead take that plays (what a double follows) */
export function leadOf(tree: ProjectTree, sectionId: string | null) {
  return tree.takes.find((t) => t.section_id === sectionId && t.lane === "Lead" && t.chosen) ?? null;
}

/** what a part's takes would be synced to: the Lead onto the beat, the others onto the Lead (or the beat) */
export function partJobs(tree: ProjectTree, sectionId: string, strength = 0.75): SyncJob[] {
  const lead = leadOf(tree, sectionId);
  // the Lead first: the others follow it as it comes out
  return tree.takes
    .filter((t) => t.section_id === sectionId && t.chosen && t.lane !== "Flow")
    .sort((a, b) => (a.lane === "Lead" ? 0 : 1) - (b.lane === "Lead" ? 0 : 1))
    .map((t) => ({ take: t, mode: t.lane === "Lead" || !lead ? { to: "beat", grid: 4, strength } : { to: "lead" } }) as SyncJob);
}

async function decode(url: string): Promise<{ x: Float32Array; sr: number }> {
  const data = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Couldn't load a take (${r.status})`);
    return r.arrayBuffer();
  });
  const Ctx = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const buf = await new Ctx(1, 1, 44100).decodeAudioData(data);
  return { x: buf.getChannelData(0), sr: buf.sampleRate };
}

/** resampled when two takes come at different rates (a USB microphone and the phone's) */
function at(x: Float32Array, from: number, to: number) {
  if (from === to) return x;
  const r = from / to;
  const y = new Float32Array(Math.floor(x.length / r));
  for (let i = 0; i < y.length; i++) {
    const p = i * r;
    const k = Math.floor(p);
    y[i] = (x[k] ?? 0) + ((x[k + 1] ?? 0) - (x[k] ?? 0)) * (p - k);
  }
  return y;
}

async function post<T>(url: string, body: unknown, method = "POST"): Promise<{ data: T; res: Response }> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return { data, res };
}

export const noteOf = (mode: SyncMode, lead: Take | null) =>
  mode.to === "lead" ? `follows Lead ${lead?.take_no ?? ""}`.trim() : `on the beat · 1/${mode.grid === 4 ? 16 : 8}${mode.strength < 1 ? ` · ${Math.round(mode.strength * 100)}%` : ""}`;

/**
 * Runs the jobs one after the other; each makes a new take. Returns the song as it is after the last one,
 * and what moved (for the message).
 */
export async function syncTakes(tree: ProjectTree, jobs: SyncJob[], progress: (text: string) => void): Promise<{ tree: ProjectTree; done: string[] }> {
  const pid = tree.project.id;
  const bpm = tree.audio?.bpm;
  const done: string[] = [];
  let latest = tree;
  for (const [n, job] of jobs.entries()) {
    const t = job.take;
    // the Lead as it is now (synced a moment ago, when the part is synced together)
    const lead = leadOf(latest, t.section_id);
    const label = `${t.lane} ${t.take_no}`;
    progress(`${label} · ${n + 1}/${jobs.length} · loading`);
    const ids = [t.id, ...(job.mode.to === "lead" && lead ? [lead.id] : [])];
    const data = (await fetch(`/api/projects/${pid}/takes?ids=${ids.join(",")}`).then((r) => r.json())) as { urls?: Record<string, string> };
    const urls = data.urls ?? {};
    if (!urls[t.id]) throw new Error(`${label}: its recording wasn't found.`);
    const take = await decode(urls[t.id]);
    progress(`${label} · ${n + 1}/${jobs.length} · in time`);
    let result;
    let mode = job.mode;
    let why = "";
    if (mode.to === "lead") {
      if (!lead || !urls[lead.id]) throw new Error(`${label}: this part has no Lead take to follow.`);
      const g = await decode(urls[lead.id]);
      result = toGuide(take.x, at(g.x, g.sr, take.sr), take.sr, lead.start_at - t.start_at);
      // not the Lead's words (ad-libs, an answer): following it would bend it out of shape — onto the beat instead
      if ((result.match ?? 0) < MIN_MATCH) {
        mode = { to: "beat", grid: 4, strength: 0.75 };
        why = " (it doesn't sing the Lead's words, so it went onto the beat)";
      }
    }
    if (mode.to === "beat") {
      if (!bpm) throw new Error("The song's tempo isn't known: set it in More → The beat.");
      const step = 60 / bpm / mode.grid;
      result = toGrid(take.x, take.sr, t.start_at, { origin: tree.audio?.beat_offset ?? 0, step }, mode.strength);
    }
    if (!result) continue;
    progress(`${label} · ${n + 1}/${jobs.length} · saving`);
    const wav = encodeWav([result.samples], take.sr, 24);
    const { data: up } = await post<{ path: string; signedUrl: string }>(`/api/projects/${pid}/takes`, { action: "uploadUrl" });
    const fd = new FormData();
    fd.append("cacheControl", "3600");
    fd.append("", new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }), "take.wav");
    const put = await fetch(up.signedUrl, { method: "PUT", body: fd, headers: { "x-upsert": "false" } });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);
    const saved = await post<ProjectTree>(`/api/projects/${pid}/takes`, {
      action: "save",
      path: up.path,
      section_id: t.section_id,
      lane: t.lane,
      start_at: t.start_at,
      duration: result.samples.length / take.sr,
      sample_rate: take.sr,
      peaks: peaksOf(result.samples, 160),
      note: noteOf(mode, lead),
    });
    latest = saved.data;
    const id = saved.res.headers.get("x-take-id");
    // the same cut, volume and pan as the take it came from
    if (id && (t.trim_in > 0 || t.trim_out !== null)) latest = (await post<ProjectTree>(`/api/takes/${id}`, { trim: { from: t.trim_in, to: t.trim_out } }, "PATCH")).data;
    if (id && ((t.gain ?? 1) !== 1 || (t.pan ?? 0) !== 0)) latest = (await post<ProjectTree>(`/api/takes/${id}`, { gain: t.gain ?? 1, pan: t.pan ?? 0 }, "PATCH")).data;
    done.push(`${t.lane}: ${result.count ? `moved ${Math.round(result.moved * 1000)} ms on average` : "already in time"}${why}`);
  }
  return { tree: latest, done };
}
