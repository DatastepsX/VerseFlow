import { flowSuggest } from "@/lib/server/ai";
import { applyFlowOptions, buildFlowSong, getTree } from "@/lib/server/repo";
import { storedTranscript, transcribeBeat, transcribeTake } from "@/lib/server/transcribe";
import { body, handle, treeResponse } from "@/lib/server/http";

export const maxDuration = 300;

/**
 * The song from the writer's flow:
 *  transcribe {takeId}  → {words}  1 ElevenLabs call: the words sung in the flow take
 *  vocals               → {words}  the song's own vocals: 1 ElevenLabs call on the uploaded track (stored, reused)
 *  build {lines, source} → tree    one line per sung bar with its rhythm (no AI); source "vocals" = the words are the text
 *  suggest {lineIds}    → tree     1 AI call: 3 options per line (first = the line's text)
 */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/flow">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{
      action: string;
      takeId?: string;
      lines?: { start: number; sungAt: number; end?: number; syllables: number; stress: number[]; held: boolean; words: string; times?: number[] }[];
      lineIds?: string[];
      source?: string;
    }>(req);
    if (b.action === "vocals") {
      const tree = await getTree(id);
      const stored = await storedTranscript(id);
      return Response.json({ words: stored?.words.length ? stored.words : await transcribeBeat(id, tree.project.language) });
    }
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
          times: (Array.isArray(l.times) ? l.times : []).filter(ok).slice(0, 60),
          end: ok(l.end) ? l.end : undefined,
        }));
      if (!lines.length) return Response.json({ error: b.source === "vocals" ? "No vocals were found in the song." : "No singing was found in the recording." }, { status: 400 });
      await buildFlowSong(id, lines, b.source === "vocals" ? "vocals" : "flow");
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
