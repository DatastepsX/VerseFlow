import { setBankState } from "@/lib/server/repo";
import { body, handle, treeResponse } from "@/lib/server/http";
import { accessVia } from "@/lib/server/users";

/** Bank line actions: reject (never suggest again), restore */
export async function POST(req: Request, ctx: RouteContext<"/api/bank/[id]">) {
  return handle(async () => {
    await accessVia("bank_lines", (await ctx.params).id, "edit");
    const b = await body<{ action: string }>(req);
    if (b.action !== "reject" && b.action !== "restore") return Response.json({ error: "Unknown action" }, { status: 400 });
    return treeResponse(await setBankState((await ctx.params).id, b.action === "reject" ? "rejected" : "available"));
  });
}
