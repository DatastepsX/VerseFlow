import { chooseTake, deleteTake, getTree, setLineTimes, shiftTake, takeProject, trimTake, updateLine } from "@/lib/server/repo";
import { alignTake } from "@/lib/server/transcribe";
import { alignmentText, alignTakeLines } from "@/lib/flow/align";
import { body, handle, treeResponse } from "@/lib/server/http";
import type { LineFlow } from "@/lib/types";

export const maxDuration = 120;

/** choose this take for its section + layer; {shift: s} moves it on the beat instead (± 0.5 s at most) */
export async function PATCH(req: Request, ctx: RouteContext<"/api/takes/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{ shift?: unknown; trim?: { from?: unknown; to?: unknown } }>(req);
    if (typeof b.shift === "number" && Number.isFinite(b.shift)) return treeResponse(await shiftTake(id, Math.max(-0.5, Math.min(0.5, b.shift))));
    // cut: {trim: {from, to}} (to null: to the end; {from: 0, to: null}: the whole take again)
    if (b.trim && typeof b.trim.from === "number" && Number.isFinite(b.trim.from))
      return treeResponse(await trimTake(id, b.trim.from, typeof b.trim.to === "number" && Number.isFinite(b.trim.to) ? b.trim.to : null));
    return treeResponse(await chooseTake(id));
  });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/takes/[id]">) {
  return handle(async () => treeResponse(await deleteTake((await ctx.params).id)));
}

/**
 * {action: "align", lineIds}: 1 ElevenLabs call — the take is aligned with these lines' text; each line's flow
 * becomes the take's timing (every sung syllable where it was rapped) and the line starts there. One undo step.
 * x-aligned: "lines synced/lines sent".
 */
export async function POST(req: Request, ctx: RouteContext<"/api/takes/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{ action?: string; lineIds?: unknown }>(req);
    if (b.action !== "align") return Response.json({ error: "Unknown action" }, { status: 400 });
    const projectId = await takeProject(id);
    const tree = await getTree(projectId);
    const ids = Array.isArray(b.lineIds) ? b.lineIds.filter((x): x is string => typeof x === "string").slice(0, 60) : [];
    const all = tree.sections.flatMap((s) => s.lines);
    const lines = ids.map((x) => all.find((l) => l.id === x)).filter((l) => !!l && l.kind === "lyric" && l.text.trim()) as typeof all;
    if (!lines.length) return Response.json({ error: "No written lines in this take's stretch." }, { status: 400 });
    const { alignment, startAt } = await alignTake(projectId, id, alignmentText(lines));
    const bpm = tree.audio?.bpm ?? 90;
    const out = alignTakeLines(lines, alignment, startAt, tree.project.language, 60 / bpm);
    for (const a of out) {
      const line = lines.find((l) => l.id === a.id)!;
      const flow: LineFlow = {
        ...(line.flow ?? {}),
        syllables: a.syllables,
        stress: a.stress.length ? a.stress : (line.flow?.stress ?? []),
        held: a.held,
        words: line.text.trim().slice(0, 200),
        source: "vocals",
        times: a.times.slice(0, 64),
        end: a.end,
      };
      await updateLine(a.id, { flow }, "align");
    }
    await setLineTimes(projectId, out.map((a) => ({ id: a.id, at: a.times[0] })));
    const res = await treeResponse(projectId);
    res.headers.set("x-aligned", `${out.length}/${lines.length}`);
    return res;
  });
}
