import { listVersions } from "@/lib/server/repo";
import { handle } from "@/lib/server/http";
import { access } from "@/lib/server/users";

export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[id]/versions">) {
  return handle(async () => {
    await access((await ctx.params).id, "view");
    return Response.json(await listVersions((await ctx.params).id));
  });
}
