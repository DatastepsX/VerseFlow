import { createShare, finishShare, listShares, revokeShare, shareUploadUrl, type ShareFile } from "@/lib/server/repo";
import { body, handle } from "@/lib/server/http";
import { access } from "@/lib/server/users";

/**
 * Share links (the stems and the mix to download, no account needed):
 *  GET → {shares}
 *  POST {action: "start", title, note?, days} → {token}
 *  POST {action: "uploadUrl", token, index, kind: "wav" | "mp3"} → {path, signedUrl}  the browser PUTs the file
 *  POST {action: "finish", token, files: [{name, path, bytes}]} → {ok}
 *  DELETE ?token= → the link stops working, its files are deleted
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[id]/shares">) {
  return handle(async () => {
    await access((await ctx.params).id, "edit");
    return Response.json({ shares: await listShares((await ctx.params).id) });
  });
}

export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/shares">) {
  return handle(async () => {
    await access((await ctx.params).id, "edit");
    const { id } = await ctx.params;
    const b = await body<{ action?: string; title?: unknown; note?: unknown; days?: unknown; token?: unknown; index?: unknown; kind?: unknown; files?: unknown }>(req);
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    if (b.action === "start") return Response.json({ token: await createShare(id, str(b.title), str(b.note), typeof b.days === "number" ? b.days : 30) });
    if (b.action === "uploadUrl")
      return Response.json(await shareUploadUrl(id, str(b.token), typeof b.index === "number" ? b.index : 0, b.kind === "mp3" ? "mp3" : "wav"));
    if (b.action === "finish") {
      const files = (Array.isArray(b.files) ? b.files : []).filter(
        (f): f is ShareFile => !!f && typeof f.name === "string" && typeof f.path === "string" && typeof f.bytes === "number",
      );
      await finishShare(id, str(b.token), files);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Unknown action" }, { status: 400 });
  });
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/projects/[id]/shares">) {
  return handle(async () => {
    await access((await ctx.params).id, "edit");
    await revokeShare((await ctx.params).id, new URL(req.url).searchParams.get("token") ?? "");
    return Response.json({ ok: true });
  });
}
