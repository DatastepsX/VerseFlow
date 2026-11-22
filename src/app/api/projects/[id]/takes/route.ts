import { linkTake, linkPiece, saveTake, takeUploadUrl, takeUrls } from "@/lib/server/repo";
import { body, handle, treeResponse } from "@/lib/server/http";
import { access } from "@/lib/server/users";

/** ?ids=a,b → { urls: {id: signedUrl} } to play / mix takes */
export async function GET(req: Request, ctx: RouteContext<"/api/projects/[id]/takes">) {
  return handle(async () => {
    await access((await ctx.params).id, "view");
    const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").filter(Boolean);
    return Response.json({ urls: await takeUrls((await ctx.params).id, ids) });
  });
}

/**
 * actions:
 *  uploadUrl → {path, signedUrl}: the browser PUTs the take's WAV straight to storage
 *  save {path, section_id, lane, start_at, duration, sample_rate, peaks, note?} → tree (x-take-id)
 */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/takes">) {
  return handle(async () => {
    const uid = await access((await ctx.params).id, "edit");
    const { id } = await ctx.params;
    const b = await body<{
      of?: unknown;
      action: string;
      path?: string;
      section_id?: string;
      lane?: string;
      start_at?: number;
      duration?: number;
      sample_rate?: number;
      peaks?: number[];
      note?: string;
      piece?: string;
      trim_in?: number;
      base_trim_out?: number;
    }>(req);
    if (b.action === "uploadUrl") return Response.json(await takeUploadUrl(id));
    if (b.action === "save") {
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      if (!b.path || num(b.start_at) === null || !num(b.duration) || !num(b.sample_rate))
        return Response.json({ error: "path, start_at, duration and sample_rate required" }, { status: 400 });
      const takeId = await saveTake(id, {
        path: b.path,
        section_id: b.section_id ?? null,
        lane: (b.lane ?? "Lead").trim().slice(0, 30) || "Lead",
        start_at: num(b.start_at)!,
        duration: num(b.duration)!,
        sample_rate: Math.round(num(b.sample_rate)!),
        peaks: Array.isArray(b.peaks) ? b.peaks.slice(0, 400).map((x) => Math.max(0, Math.min(1, Number(x) || 0))) : [],
        note: typeof b.note === "string" ? b.note.slice(0, 80) : null,
        created_by: uid,
        ...(num(b.trim_in) !== null && num(b.trim_in)! > 0 ? { trim_in: Math.round(num(b.trim_in)! * 1000) / 1000 } : {}),
      }, typeof b.piece === "string");
      // a piece recorded on a take: played with it (the take before stops where the piece takes over)
      if (typeof b.piece === "string" && /^[0-9a-f-]{36}$/.test(b.piece)) await linkPiece(id, takeId, b.piece, num(b.base_trim_out));
      // a version of another take (continued in pieces, synced): kept together with it
      if (typeof b.of === "string" && /^[0-9a-f-]{36}$/.test(b.of)) await linkTake(id, takeId, b.of);
      const res = await treeResponse(id);
      res.headers.set("x-take-id", takeId);
      return res;
    }
    return Response.json({ error: "Unknown action" }, { status: 400 });
  });
}
