import { listVersions } from "@/lib/server/repo";
import { handle } from "@/lib/server/http";

export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[id]/versions">) {
  return handle(async () => Response.json(await listVersions((await ctx.params).id)));
}
