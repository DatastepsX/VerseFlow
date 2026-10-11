import { fillBank, fitLine } from "@/lib/server/ai";
import { addLine, clearBank, deleteSection, getTree, insertBank, moveSection, setBankState, updateSection } from "@/lib/server/repo";
import { rhymePartners } from "@/lib/scheme";
import { db } from "@/lib/server/db";
import { body, handle, pick, treeResponse } from "@/lib/server/http";
import type { LineKind, LineStatus, Section } from "@/lib/types";

export const maxDuration = 120;

export async function PATCH(req: Request, ctx: RouteContext<"/api/sections/[id]">) {
  return handle(async () => {
    const b = await body(req);
    const projectId = await updateSection(
      (await ctx.params).id,
      pick<Section>(b, ["name", "group_size", "story_beat", "intensity", "rhyme_scheme", "notes", "audio_start", "bars_per_line"]),
    );
    return treeResponse(projectId);
  });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/sections/[id]">) {
  return handle(async () => treeResponse(await deleteSection((await ctx.params).id)));
}

/** Section actions: addLine, move */
export async function POST(req: Request, ctx: RouteContext<"/api/sections/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{
      action: string;
      text?: string;
      status?: LineStatus;
      kind?: LineKind;
      afterLineId?: string | null;
      dir?: -1 | 1;
      bankId?: string;
      targets?: string[];
      instruction?: string;
      replace?: boolean;
      reference?: string;
    }>(req);
    if (b.action === "addLine") {
      const line = await addLine(id, { text: b.text, status: b.status, kind: b.kind, afterLineId: b.afterLineId });
      if (b.bankId) await setBankState(b.bankId, "used");
      const res = await treeResponse(line.project_id);
      res.headers.set("x-line-id", line.id);
      return res;
    }
    if (b.action === "fitText") {
      // 1 AI call: rewrite the writer's line to the length/flow of the line before; stored in the bank
      if (!b.text?.trim() || !b.reference?.trim()) return Response.json({ error: "text and reference required" }, { status: 400 });
      const s = await sectionProject(id);
      const lines = await fitLine({ tree: await getTree(s), sectionId: id, text: b.text.slice(0, 300), reference: b.reference.slice(0, 300) });
      await insertBank(s, id, [{ rhyme: "fit", lines }]);
      return treeResponse(s);
    }
    if (b.action === "fillBank") {
      // one AI call that stocks this section with rhyme families of candidate bars
      const s = await sectionProject(id);
      const tree = await getTree(s);
      const section = tree.sections.find((x) => x.id === id)!;
      const texts = section.lines.map((l) => (l.kind === "lyric" && l.status !== "DECLINED" ? l.text : ""));
      const next = rhymePartners([...texts, ""], section.group_size, section.rhyme_scheme)[texts.length];
      const auto = next.partner !== null && texts[next.partner]?.trim() ? [texts[next.partner]] : [];
      const targets = [...auto, ...(b.targets ?? [])];
      const families = await fillBank({
        tree,
        sectionId: id,
        targets,
        newFamilies: targets.length ? 4 : 5,
        linesPerFamily: 6,
        instruction: b.instruction?.slice(0, 500),
      });
      if (b.replace) await clearBank(id);
      await insertBank(s, id, families);
      return treeResponse(s);
    }
    if (b.action === "move") return treeResponse(await moveSection(id, b.dir === -1 ? -1 : 1));
    return Response.json({ error: "Unknown action" }, { status: 400 });
  });
}

async function sectionProject(sectionId: string) {
  const { data, error } = await db().from("sections").select("project_id").eq("id", sectionId).single();
  if (error || !data) throw new Error("Section not found");
  return data.project_id as string;
}
