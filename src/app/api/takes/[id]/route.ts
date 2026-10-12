import { chooseTake, deleteTake } from "@/lib/server/repo";
import { handle, treeResponse } from "@/lib/server/http";

/** choose this take for its section + layer */
export async function PATCH(_req: Request, ctx: RouteContext<"/api/takes/[id]">) {
  return handle(async () => treeResponse(await chooseTake((await ctx.params).id)));
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/takes/[id]">) {
  return handle(async () => treeResponse(await deleteTake((await ctx.params).id)));
}
