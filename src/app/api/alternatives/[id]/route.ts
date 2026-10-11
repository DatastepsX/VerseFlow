import { rejectAlternative, selectAlternative } from "@/lib/server/repo";
import { body, handle, treeResponse } from "@/lib/server/http";

/** actions: select (optionally with edited text), reject */
export async function POST(req: Request, ctx: RouteContext<"/api/alternatives/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{ action: string; text?: string }>(req);
    if (b.action === "select") return treeResponse(await selectAlternative(id, b.text));
    if (b.action === "reject") return treeResponse(await rejectAlternative(id));
    return Response.json({ error: "Unknown action" }, { status: 400 });
  });
}
