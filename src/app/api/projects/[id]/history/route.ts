import { listHistory } from "@/lib/server/repo";
import { handle } from "@/lib/server/http";

export async function GET(req: Request, ctx: RouteContext<"/api/projects/[id]/history">) {
  return handle(async () => {
    const lineId = new URL(req.url).searchParams.get("line") ?? undefined;
    return Response.json(await listHistory((await ctx.params).id, lineId));
  });
}
