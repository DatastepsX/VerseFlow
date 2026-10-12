import { saveTake, takeUploadUrl, takeUrls } from "@/lib/server/repo";
import { body, handle, treeResponse } from "@/lib/server/http";

/** ?ids=a,b → { urls: {id: signedUrl} } to play / mix takes */
export async function GET(req: Request, ctx: RouteContext<"/api/projects/[id]/takes">) {
  return handle(async () => {
    const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").filter(Boolean);
    return Response.json({ urls: await takeUrls((await ctx.params).id, ids) });
  });
}

/**
 * actions:
 *  uploadUrl → {path, signedUrl}: the browser PUTs the take's WAV straight to storage
 *  save {path, section_id, lane, start_at, duration, sample_rate, peaks} → tree (x-take-id)
 */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/takes">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{
      action: string;
      path?: string;
      section_id?: string;
      lane?: string;
      start_at?: number;
      duration?: number;
      sample_rate?: number;
      peaks?: number[];
    }>(req);
    if (b.action === "uploadUrl") return Response.json(await takeUploadUrl(id));
    if (b.action === "save") {
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      if (!b.path || !b.section_id || num(b.start_at) === null || !num(b.duration) || !num(b.sample_rate))
        return Response.json({ error: "path, section_id, start_at, duration and sample_rate required" }, { status: 400 });
      const takeId = await saveTake(id, {
        path: b.path,
        section_id: b.section_id,
        lane: (b.lane ?? "Lead").trim().slice(0, 30) || "Lead",
        start_at: num(b.start_at)!,
        duration: num(b.duration)!,
        sample_rate: Math.round(num(b.sample_rate)!),
        peaks: Array.isArray(b.peaks) ? b.peaks.slice(0, 400).map((x) => Math.max(0, Math.min(1, Number(x) || 0))) : [],
      });
      const res = await treeResponse(id);
      res.headers.set("x-take-id", takeId);
      return res;
    }
    return Response.json({ error: "Unknown action" }, { status: 400 });
  });
}
