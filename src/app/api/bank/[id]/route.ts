import { setBankState } from "@/lib/server/repo";
import { body, handle, treeResponse } from "@/lib/server/http";

/** Bank line actions: reject (never suggest again), restore */
export async function POST(req: Request, ctx: RouteContext<"/api/bank/[id]">) {
  return handle(async () => {
    const b = await body<{ action: string }>(req);
    if (b.action !== "reject" && b.action !== "restore") return Response.json({ error: "Unknown action" }, { status: 400 });
    return treeResponse(await setBankState((await ctx.params).id, b.action === "reject" ? "rejected" : "available"));
  });
}
