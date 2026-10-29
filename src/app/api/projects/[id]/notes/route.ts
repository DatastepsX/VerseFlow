import { addNote, deleteNote, noteAudioUrl, noteUploadUrl } from "@/lib/server/repo";
import { body, handle, treeResponse } from "@/lib/server/http";

/**
 * Notes on lines (comments, voice messages):
 *  GET ?audio=<noteId> → {url}                        a voice message to play
 *  POST {action: "uploadUrl", kind} → {path, signedUrl} the browser PUTs the voice message
 *  POST {lineId, text, audioPath?, audioSeconds?, author} → tree
 *  DELETE ?id=<noteId> → tree
 */
export async function GET(req: Request, ctx: RouteContext<"/api/projects/[id]/notes">) {
  return handle(async () => {
    const { id } = await ctx.params;
    return Response.json({ url: await noteAudioUrl(id, new URL(req.url).searchParams.get("audio") ?? "") });
  });
}

export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/notes">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{ action?: string; kind?: unknown; lineId?: unknown; text?: unknown; audioPath?: unknown; audioSeconds?: unknown; author?: unknown }>(req);
    if (b.action === "uploadUrl") return Response.json(await noteUploadUrl(id, b.kind === "mp4" ? "mp4" : b.kind === "wav" ? "wav" : "webm"));
    await addNote(id, {
      lineId: typeof b.lineId === "string" ? b.lineId : "",
      authorId: null,
      authorName: typeof b.author === "string" && b.author.trim() ? b.author.trim() : "Someone",
      text: typeof b.text === "string" ? b.text : "",
      audioPath: typeof b.audioPath === "string" ? b.audioPath : null,
      audioSeconds: typeof b.audioSeconds === "number" && Number.isFinite(b.audioSeconds) ? Math.round(b.audioSeconds * 10) / 10 : null,
    });
    return treeResponse(id);
  });
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/projects/[id]/notes">) {
  return handle(async () => {
    const { id } = await ctx.params;
    await deleteNote(id, new URL(req.url).searchParams.get("id") ?? "", null);
    return treeResponse(id);
  });
}
