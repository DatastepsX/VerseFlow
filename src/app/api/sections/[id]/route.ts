import { draftPlan, draftSection, fillBank, fitLine } from "@/lib/server/ai";
import { addLine, appendLines, applyDraft, applyPolish, applyRefit, clearBank, deleteSection, extendSection, getTree, insertBank, mergeIntoPrevious, moveSection, setBankState, updateLine, updateSection } from "@/lib/server/repo";
import { rhymePartners } from "@/lib/scheme";
import { db } from "@/lib/server/db";
import { body, handle, pick, treeResponse } from "@/lib/server/http";
import type { LineKind, LineStatus, Section } from "@/lib/types";

export const maxDuration = 300;

export async function PATCH(req: Request, ctx: RouteContext<"/api/sections/[id]">) {
  return handle(async () => {
    const b = await body<Record<string, unknown>>(req);
    const patch = pick<Section>(b, ["name", "group_size", "story_beat", "intensity", "rhyme_scheme", "notes", "audio_start", "bars_per_line", "pattern"]);
    if (Array.isArray(b.artists)) patch.artists = b.artists.filter((x): x is string => typeof x === "string").slice(0, 12);
    const projectId = await updateSection((await ctx.params).id, patch);
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
      lines?: { text: string; status?: LineStatus; bankId?: string }[];
      mode?: "fill" | "replace" | "polish" | "refit";
      indices?: number[];
      bars?: number;
    }>(req);
    if (b.action === "addLine") {
      const line = await addLine(id, { text: b.text, status: b.status, kind: b.kind, afterLineId: b.afterLineId });
      if (b.bankId) await setBankState(b.bankId, "used");
      const res = await treeResponse(line.project_id);
      res.headers.set("x-line-id", line.id);
      return res;
    }
    if (b.action === "draftPlan") {
      // no AI call: creates the section's missing bars (fill) and returns the chunks (x-parts) the client then
      // drafts in parallel — one call each — so a 40-bar section takes about as long as 8 bars
      const s = await sectionProject(id);
      const mode = b.mode === "replace" || b.mode === "polish" || b.mode === "refit" ? b.mode : "fill";
      const plan = draftPlan(await getTree(s), id, mode);
      if (plan.n > plan.lyricCount)
        await appendLines(id, Array.from({ length: plan.n - plan.lyricCount }, () => ({ text: "", status: "OPEN" as LineStatus })));
      const res = await treeResponse(s);
      res.headers.set("x-parts", JSON.stringify(plan.chunks));
      return res;
    }
    if (b.action === "fill" || b.action === "replace" || b.action === "polish" || b.action === "refit") {
      // one AI call for a chunk of ~8 bars (b.indices, else the first chunk): open bars (fill) or the bars marked ✕
      // (replace), from the section's pattern. x-remaining = open bars not written by this call.
      const s = await sectionProject(id);
      const only = Array.isArray(b.indices) ? b.indices.filter((k) => Number.isInteger(k)).slice(0, 16) : undefined;
      const { slots, remaining } = await draftSection(await getTree(s), id, b.action, b.instruction?.slice(0, 500), only);
      if (b.action === "polish") await applyPolish(id, slots);
      else if (b.action === "refit") await applyRefit(id, slots);
      else await applyDraft(id, slots);
      const res = await treeResponse(s);
      res.headers.set("x-remaining", String(slots.length ? remaining : 0));
      return res;
    }
    if (b.action === "keepAll") {
      // ✓ every remaining draft bar of the section
      const s = await sectionProject(id);
      const tree = await getTree(s);
      const sec = tree.sections.find((x) => x.id === id)!;
      for (const l of sec.lines) if (l.status === "SUGGESTED" && l.text.trim()) await updateLine(l.id, { status: "APPROVED" }, "approve");
      return treeResponse(s);
    }
    if (b.action === "addLines") {
      // several lines at once (e.g. a whole couplet from the bank), appended in order
      const items = (b.lines ?? []).filter((l) => l.text?.trim()).slice(0, 200);
      await appendLines(id, items.map((l) => ({ text: l.text.trim(), status: l.status ?? "APPROVED" })));
      for (const l of items) if (l.bankId) await setBankState(l.bankId, "used");
      return treeResponse(await sectionProject(id));
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
      const next = rhymePartners([...texts, ""], section.group_size, section.rhyme_scheme, tree.project.language)[texts.length];
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
    if (b.action === "mergePrevious") return treeResponse(await mergeIntoPrevious(id));
    // the part made longer: its last bars of the beat again, empty lines to write (free)
    if (b.action === "extend") return treeResponse(await extendSection(id, [2, 4, 8, 16].includes(Number(b.bars)) ? Number(b.bars) : 4));
    if (b.action === "clearBank") {
      // removes the section's unused suggestions (free)
      const s = await sectionProject(id);
      await clearBank(id);
      return treeResponse(s);
    }
    return Response.json({ error: "Unknown action" }, { status: 400 });
  });
}

async function sectionProject(sectionId: string) {
  const { data, error } = await db().from("sections").select("project_id").eq("id", sectionId).single();
  if (error || !data) throw new Error("Section not found");
  return data.project_id as string;
}
