"use client";

import { analyzeAudio } from "@/lib/audio/analyze-file";

export const MAX_BEAT_BYTES = 50 * 1024 * 1024;

/**
 * Analyses a song/beat in the browser (tempo, bar 1, beat changes), uploads
 * it straight to storage and returns the body for the `save` action of
 * /api/projects/[id]/audio (the caller posts it, so it gets the tree back).
 */
export async function uploadBeat(projectId: string, file: File, onStatus: (s: string) => void) {
  if (file.size > MAX_BEAT_BYTES) throw new Error("The file is larger than 50 MB.");
  onStatus("Analysing tempo…");
  const analysis = await analyzeAudio(file);
  onStatus("Uploading…");
  const up = (await fetch(`/api/projects/${projectId}/audio`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "uploadUrl", filename: file.name }),
  }).then((r) => r.json())) as { path: string; signedUrl: string; error?: string };
  if (!up.signedUrl) throw new Error(up.error ?? "Upload not possible");
  const fd = new FormData();
  fd.append("cacheControl", "3600");
  fd.append("", file);
  const put = await fetch(up.signedUrl, { method: "PUT", body: fd, headers: { "x-upsert": "false" } });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  return {
    action: "save",
    path: up.path,
    filename: file.name,
    duration: analysis.duration,
    bpm: analysis.tempo.bpm || null,
    beat_offset: analysis.tempo.offset,
    changes: analysis.changes,
  };
}
