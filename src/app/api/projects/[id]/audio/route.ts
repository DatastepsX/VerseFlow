import { audioPlaybackUrl, audioUploadUrl, deleteAudio, saveAudio, updateAudio } from "@/lib/server/repo";
import { body, handle, treeResponse } from "@/lib/server/http";

/** Signed URL to stream the project's beat */
export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[id]/audio">) {
  return handle(async () => Response.json({ url: await audioPlaybackUrl((await ctx.params).id) }));
}

/**
 * actions:
 *  uploadUrl {filename}            → {path, signedUrl}; the browser PUTs the file straight to storage
 *  save {path, filename, duration, bpm, beat_offset} → tree (after upload + in-browser analysis)
 *  update {bpm?, beat_offset?, beats_per_bar?}       → tree
 */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/audio">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{
      action: string;
      filename?: string;
      path?: string;
      duration?: number | null;
      bpm?: number | null;
      beat_offset?: number;
      beats_per_bar?: number;
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
        });
        return treeResponse(id);
      case "update": {
        const patch: Record<string, number | null> = {};
        if ("bpm" in b) patch.bpm = num(b.bpm);
        if ("beat_offset" in b) patch.beat_offset = num(b.beat_offset) ?? 0;
        if ("beats_per_bar" in b) patch.beats_per_bar = Math.min(12, Math.max(1, Math.round(num(b.beats_per_bar) ?? 4)));
        await updateAudio(id, patch);
        return treeResponse(id);
      }
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/projects/[id]/audio">) {
  return handle(async () => {
    const { id } = await ctx.params;
    await deleteAudio(id);
    return treeResponse(id);
  });
}
