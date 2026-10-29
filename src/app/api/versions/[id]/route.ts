import { getVersion, restoreVersion } from "@/lib/server/repo";
import { handle, treeResponse } from "@/lib/server/http";
import { accessVia } from "@/lib/server/users";

export async function GET(_req: Request, ctx: RouteContext<"/api/versions/[id]">) {
  return handle(async () => {
    await accessVia("project_versions", (await ctx.params).id, "view");
    return Response.json(await getVersion((await ctx.params).id));
  });
}

/** Restore the project to this saved version (current state is auto-saved first) */
export async function POST(_req: Request, ctx: RouteContext<"/api/versions/[id]">) {
  return handle(async () => {
    await accessVia("project_versions", (await ctx.params).id, "edit");
    return treeResponse(await restoreVersion((await ctx.params).id));
  });
}
