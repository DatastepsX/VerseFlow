import { addAlternatives, clearAlternatives, deleteLine, getTree, lineText, moveLine, setBankState, setLineTimes, splitSection, updateLine } from "@/lib/server/repo";
import { generateOptions } from "@/lib/server/ai";
import { body, handle, pick, treeResponse } from "@/lib/server/http";
import type { Line, LineFlow } from "@/lib/types";
import { cleanMarks } from "@/lib/marks";

export const maxDuration = 120;

export async function PATCH(req: Request, ctx: RouteContext<"/api/lines/[id]">) {
  return handle(async () => {
    const b = await body(req);
    const action = typeof b.action === "string" ? b.action : "edit";
    const id = (await ctx.params).id;
    const patch: Partial<Pick<Line, "text" | "status" | "kind" | "note" | "flow" | "marks">> = pick<Line>(b, ["text", "status", "kind", "note"]);
    // the line's rhythm, edited on the flow grid (undoable like a text edit)
    const flow = b.flow === null ? null : b.flow !== undefined ? cleanFlow(b.flow) : undefined;
    if (b.flow !== undefined && flow === undefined) return Response.json({ error: "Invalid flow" }, { status: 400 });
    if (flow !== undefined) patch.flow = flow;
    // notes for recording on the words (made on the line's text as it is)
    if (b.marks !== undefined) {
      const marks = cleanMarks(b.marks, typeof b.text === "string" ? b.text : await lineText(id));
      if (marks === undefined) return Response.json({ error: "Invalid marks" }, { status: 400 });
      patch.marks = marks;
    }
    const projectId = await updateLine(id, patch, action);
    // the line starts where its first syllable is sung
    if (flow?.times?.length) await setLineTimes(projectId, [{ id, at: flow.times[0] }]);
    if (typeof b.bankId === "string") await setBankState(b.bankId, "used");
    return treeResponse(projectId);
  });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/lines/[id]">) {
  return handle(async () => treeResponse(await deleteLine((await ctx.params).id)));
}

/** Line actions: move, addAlternative (manual), generate (AI) */
export async function POST(req: Request, ctx: RouteContext<"/api/lines/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{
      action: string;
      dir?: -1 | 1;
      text?: string;
      projectId?: string;
      scope?: "line" | "group";
      count?: number;
      instruction?: string;
      rhymeStrength?: "exact" | "loose" | "none";
      name?: string;
      start?: number | null;
    }>(req);
    switch (b.action) {
      case "clearAlternatives":
        return treeResponse(await clearAlternatives(id));
      case "splitSection":
        // this line and the ones after it become a new section (e.g. where the rap starts)
        return treeResponse(
          await splitSection(id, (b.name ?? "New section").slice(0, 60), typeof b.start === "number" && Number.isFinite(b.start) ? b.start : null),
        );
      case "move":
        return treeResponse(await moveLine(id, b.dir === -1 ? -1 : 1));
      case "addAlternative":
        return treeResponse(await addAlternatives(id, [b.text ?? ""], "user"));
      case "generate": {
        if (!b.projectId) return Response.json({ error: "projectId required" }, { status: 400 });
        const tree = await getTree(b.projectId);
        const count = Math.min(6, Math.max(1, b.count ?? 3));
        const { targetIds, options } = await generateOptions({
          tree,
          lineId: id,
          scope: b.scope ?? "line",
          count,
          instruction: b.instruction?.slice(0, 500),
          rhymeStrength: b.rhymeStrength,
        });
        // options for a couplet are stored on its first line as multi-line text
        return treeResponse(
          await addAlternatives(targetIds[0], options.map((o) => o.join("\n")), "ai", b.instruction),
        );
      }
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  });
}

function cleanFlow(v: unknown): LineFlow | undefined {
  if (!v || typeof v !== "object") return undefined;
  const f = v as Record<string, unknown>;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  const nums = (x: unknown, max: number) => (Array.isArray(x) ? x.filter(num).slice(0, max) : []) as number[];
  if (!num(f.syllables)) return undefined;
  const times = nums(f.times, 64);
  return {
    syllables: Math.max(0, Math.min(64, Math.round(f.syllables as number))),
    stress: nums(f.stress, 64).map(Math.round),
    held: !!f.held,
    words: typeof f.words === "string" ? f.words.slice(0, 200) : "",
    source: f.source === "vocals" ? "vocals" : "flow",
    times,
    end: num(f.end) ? (f.end as number) : undefined,
    pair: f.pair === 1 || f.pair === 2 || f.pair === 0 ? (f.pair as 0 | 1 | 2) : undefined,
    ...(Array.isArray(f.pauses) && f.pauses.length ? { pauses: nums(f.pauses, 32).map(Math.round) } : {}),
  };
}
