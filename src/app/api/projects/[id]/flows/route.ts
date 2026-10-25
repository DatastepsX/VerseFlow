import { applyFlow, createFlow, getTree, updateFlow } from "@/lib/server/repo";
import { body, handle } from "@/lib/server/http";
import type { FlowPattern, PatternLine } from "@/lib/types";

/**
 * The song's flows (patterns of 2 or 4 lines):
 *  create {pattern}                                → {flow, tree}
 *  update {flowId, pattern}                        → {tree}
 *  apply {flowId, sectionId, fromLineId?, withText} → {tree, write}  the part (or the stretch from a line) follows
 *                                                    the flow; write = its new lines without text (to be written, AI)
 */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/flows">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{ action: string; pattern?: unknown; flowId?: string; sectionId?: string; fromLineId?: string | null; withText?: boolean }>(req);
    if (b.action === "create" || b.action === "update") {
      const pattern = cleanPattern(b.pattern);
      if (!pattern) return Response.json({ error: "Invalid flow" }, { status: 400 });
      if (b.action === "create") {
        const flow = await createFlow(id, pattern);
        return Response.json({ flow, tree: await getTree(id) });
      }
      if (!b.flowId) return Response.json({ error: "flowId required" }, { status: 400 });
      await updateFlow(id, b.flowId, pattern);
      return Response.json({ tree: await getTree(id) });
    }
    if (b.action === "apply") {
      if (!b.flowId || !b.sectionId) return Response.json({ error: "flowId and sectionId required" }, { status: 400 });
      const write = await applyFlow(id, b.flowId, b.sectionId, typeof b.fromLineId === "string" ? b.fromLineId : null, b.withText !== false);
      return Response.json({ tree: await getTree(id), write });
    }
    return Response.json({ error: "Unknown action" }, { status: 400 });
  });
}

function cleanPattern(v: unknown): FlowPattern | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  const ints = (x: unknown) => (Array.isArray(x) ? x.filter(num).map((n) => Math.round(n as number)).slice(0, 64) : []);
  const lines = (Array.isArray(p.lines) ? p.lines : []).slice(0, 4).map((x): PatternLine | null => {
    if (!x || typeof x !== "object") return null;
    const l = x as Record<string, unknown>;
    if (!num(l.syllables) || (l.syllables as number) < 1) return null;
    return {
      text: typeof l.text === "string" ? l.text.slice(0, 200) : "",
      written: !!l.written,
      syllables: Math.min(64, Math.round(l.syllables as number)),
      stress: ints(l.stress),
      long: ints(l.long),
      pauses: ints(l.pauses),
      offsets: (Array.isArray(l.offsets) ? l.offsets.filter(num) : []).slice(0, 64) as number[],
      ...(l.sung ? { sung: true } : {}),
      ...(l.commaPauses ? { commaPauses: true } : {}),
      // sung with its own spacing: the bar it is timed from
      ...(num(l.at) && (l.at as number) >= 0 && (l.at as number) < 64 ? { at: Math.round(l.at as number) } : {}),
    };
  });
  if (lines.some((l) => !l) || (lines.length !== 2 && lines.length !== 4) || !num(p.bar) || (p.bar as number) <= 0) return null;
  return {
    lines: lines as PatternLine[],
    scheme: p.scheme === "ABAB" ? "ABAB" : "AABB",
    bar: p.bar as number,
    source: p.source === "sing" || p.source === "tap" || p.source === "both" ? p.source : "write",
  };
}
