import { restoreFromEvent } from "@/lib/server/repo";
import { body, handle, treeResponse } from "@/lib/server/http";
import { access, projectOfEvent } from "@/lib/server/users";

/** Restore a line to how it was before/after a history event */
export async function POST(req: Request, ctx: RouteContext<"/api/events/[id]">) {
  return handle(async () => {
    await access(await projectOfEvent(Number((await ctx.params).id)), "edit");
    const b = await body<{ which?: "before" | "after" }>(req);
    const projectId = await restoreFromEvent(Number((await ctx.params).id), b.which ?? "before");
    if (!projectId) return Response.json({ error: "Nothing to restore" }, { status: 400 });
    return treeResponse(projectId);
  });
}
