import { getTree } from "@/lib/server/repo";
import { body, handle } from "@/lib/server/http";
import { speakLines, spokenAlready } from "@/lib/server/voice";
import { access } from "@/lib/server/users";

export const maxDuration = 300;

/**
 * The lyrics in the writer's own voice (the guide vocal):
 *  spoken {lineIds} → {ids}    lines already spoken in the voice (free to play)
 *  speak {lineIds}  → {lines}  [{lineId, url, words}] — 1 ElevenLabs call per line not spoken yet
 */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/voice">) {
  return handle(async () => {
    await access((await ctx.params).id, "view");
    const { id } = await ctx.params;
    const b = await body<{ action: string; lineIds?: string[] }>(req);
    const ids = (b.lineIds ?? []).filter((x) => typeof x === "string").slice(0, 200);
    const tree = await getTree(id);
    if (b.action === "spoken") return Response.json({ ids: await spokenAlready(tree, ids) });
    if (b.action === "speak") return Response.json({ lines: await speakLines(tree, ids.slice(0, 60)) });
    return Response.json({ error: "Unknown action" }, { status: 400 });
  });
}
