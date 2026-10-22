import { flowSuggest } from "@/lib/server/ai";
import { applyFlowOptions, buildFlowSong, getTree } from "@/lib/server/repo";
import { transcribeTake } from "@/lib/server/transcribe";
import { body, handle, treeResponse } from "@/lib/server/http";

export const maxDuration = 300;

/**
 * The song from the writer's flow:
 *  transcribe {takeId}  → {words}  1 ElevenLabs call: the words sung in the flow take
 *  build {lines}        → tree     one line per sung bar with its rhythm (no AI)
 *  suggest {lineIds}    → tree     1 AI call: 3 options per line (first = the line's text)
 */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/flow">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{
      action: string;
      takeId?: string;
      lines?: { start: number; sungAt: number; syllables: number; stress: number[]; held: boolean; words: string }[];
      lineIds?: string[];
    }>(req);
    if (b.action === "transcribe") {
      if (!b.takeId) return Response.json({ error: "takeId required" }, { status: 400 });
      const tree = await getTree(id);
      return Response.json({ words: await transcribeTake(id, b.takeId, tree.project.language) });
    }
    if (b.action === "build") {
      const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v);
      const lines = (b.lines ?? [])
        .filter((l) => l && ok(l.start) && ok(l.syllables))
        .slice(0, 400)
        .map((l) => ({
          start: l.start,
          sungAt: ok(l.sungAt) ? l.sungAt : l.start,
          syllables: Math.max(1, Math.min(40, Math.round(l.syllables))),
          stress: (Array.isArray(l.stress) ? l.stress : []).filter(ok).map(Math.round),
          held: !!l.held,
          words: typeof l.words === "string" ? l.words : "",
        }));
      if (!lines.length) return Response.json({ error: "No singing was found in the recording." }, { status: 400 });
      await buildFlowSong(id, lines);
      return treeResponse(id);
    }
    if (b.action === "suggest") {
      const ids = (b.lineIds ?? []).filter((x) => typeof x === "string").slice(0, 16);
      await applyFlowOptions(id, await flowSuggest(await getTree(id), ids));
      return treeResponse(id);
    }
    return Response.json({ error: "Unknown action" }, { status: 400 });
  });
}
