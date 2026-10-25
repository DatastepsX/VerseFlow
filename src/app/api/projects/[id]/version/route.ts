import { projectVersion } from "@/lib/server/repo";
import { handle } from "@/lib/server/http";

/** a stamp of everything in the song (lyrics, parts, takes, flows, options, undo): another device changed it when it changes */
export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[id]/version">) {
  return handle(async () => Response.json({ v: await projectVersion((await ctx.params).id) }, { headers: { "cache-control": "no-store" } }));
}
