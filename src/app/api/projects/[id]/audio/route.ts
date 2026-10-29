import { alignStarts } from "@/lib/audio/structure";
import { audioPlaybackUrl, audioUploadUrl, deleteAudio, getTree, saveAudio, updateAudio, updateSection } from "@/lib/server/repo";
import type { AudioTrack } from "@/lib/types";
import { body, handle, treeResponse } from "@/lib/server/http";
import { separateVocals } from "@/lib/server/transcribe";
import { access } from "@/lib/server/users";

// removing the vocals waits for ElevenLabs (up to a minute or two for a song)
export const maxDuration = 300;

/** Signed URL to stream the project's beat */
export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[id]/audio">) {
  return handle(async () => {
    await access((await ctx.params).id, "view");
    return Response.json(await audioPlaybackUrl((await ctx.params).id));
  });
}

/**
 * actions:
 *  uploadUrl {filename}            → {path, signedUrl}; the browser PUTs the file straight to storage
 *  save {path, filename, duration, bpm, beat_offset} → tree (after upload + in-browser analysis)
 *  update {bpm?, beat_offset?, beats_per_bar?, changes?} → tree
 *  alignSections                    → tree: every section start moves to the nearest beat change / bar start
 *  separate                         → tree: the song without its vocals (1 ElevenLabs call)
 */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/audio">) {
  return handle(async () => {
    await access((await ctx.params).id, "edit");
    const { id } = await ctx.params;
    const b = await body<{
      action: string;
      filename?: string;
      path?: string;
      duration?: number | null;
      bpm?: number | null;
      beat_offset?: number;
      beats_per_bar?: number;
      changes?: unknown;
    }>(req);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    switch (b.action) {
      case "uploadUrl":
        return Response.json(await audioUploadUrl(id, b.filename ?? "beat.mp3"));
      case "save":
        if (!b.path) return Response.json({ error: "path required" }, { status: 400 });
        await saveAudio(id, {
          path: b.path,
          filename: (b.filename ?? "beat").slice(0, 200),
          duration: num(b.duration),
          bpm: num(b.bpm),
          beat_offset: num(b.beat_offset) ?? 0,
          changes: cleanChanges(b.changes),
        });
        return treeResponse(id);
      case "update": {
        const patch: Partial<Pick<AudioTrack, "bpm" | "beat_offset" | "beats_per_bar" | "changes">> = {};
        if ("bpm" in b) patch.bpm = num(b.bpm);
        if ("beat_offset" in b) patch.beat_offset = num(b.beat_offset) ?? 0;
        if ("beats_per_bar" in b) patch.beats_per_bar = Math.min(12, Math.max(1, Math.round(num(b.beats_per_bar) ?? 4)));
        if ("changes" in b) patch.changes = cleanChanges(b.changes);
        await updateAudio(id, patch);
        return treeResponse(id);
      }
      case "separate":
        await separateVocals(id);
        return treeResponse(id);
      case "alignSections": {
        const tree = await getTree(id);
        if (!tree.audio?.bpm) return Response.json({ error: "Set the tempo first." }, { status: 400 });
        const anchored = tree.sections.filter((s) => s.audio_start !== null);
        const next = alignStarts(
          anchored.map((s) => s.audio_start!),
          tree.audio,
        );
        let moved = 0;
        for (const [i, s] of anchored.entries())
          if (Math.abs(next[i] - s.audio_start!) > 0.005) {
            await updateSection(s.id, { audio_start: next[i] });
            moved++;
          }
        const res = await treeResponse(id);
        res.headers.set("x-moved", String(moved));
        return res;
      }
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/projects/[id]/audio">) {
  return handle(async () => {
    await access((await ctx.params).id, "edit");
    const { id } = await ctx.params;
    await deleteAudio(id);
    return treeResponse(id);
  });
}

function cleanChanges(v: unknown): AudioTrack["changes"] {
  if (!Array.isArray(v)) return null;
  return v
    .filter((c) => c && Number.isFinite(c.t) && Number.isFinite(c.s))
    .slice(0, 300)
    .map((c) => ({ t: Math.round(c.t * 1000) / 1000, s: Math.round(Math.min(1, Math.max(0, c.s)) * 100) / 100 }));
}
