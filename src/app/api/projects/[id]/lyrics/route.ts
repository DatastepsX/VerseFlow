import { planLyrics, type LyricsPlan } from "@/lib/audio/lyrics";
import { songSections, sungLines } from "@/lib/audio/song-lines";
import { applyLyricsPlan, getTree, rebuildSong, setLineTimes } from "@/lib/server/repo";
import { storedTranscript, transcribeBeat, transcriptionConfigured, vocalTimes } from "@/lib/server/transcribe";
import { body, handle, treeResponse } from "@/lib/server/http";
import type { ProjectTree } from "@/lib/types";
import { access } from "@/lib/server/users";

export const maxDuration = 300;

function plan(tree: ProjectTree, words: Parameters<typeof planLyrics>[0]["words"], autoSections: boolean): LyricsPlan {
  const a = tree.audio!;
  return planLyrics({
    words,
    grid: { bpm: a.bpm, beat_offset: a.beat_offset, beats_per_bar: a.beats_per_bar, duration: a.duration },
    sections: tree.sections.map((s) => ({
      id: s.id,
      name: s.name,
      audio_start: s.audio_start,
      bars_per_line: s.bars_per_line,
      lines: s.lines.map((l) => ({ text: l.text })),
    })),
    projectType: tree.project.type,
    autoSections,
  });
}

/** The song rebuilt from its vocals: sections (rap / chorus / verse…) with lines as they are sung. */
function rebuild(tree: ProjectTree, words: Parameters<typeof planLyrics>[0]["words"]) {
  const a = tree.audio!;
  const bar = a.bpm ? (a.beats_per_bar * 60) / a.bpm : null;
  const lines = sungLines(words, tree.project.language, { bar });
  return songSections(lines, { ...a, duration: a.duration }, tree.project.type).map((s) => ({
    name: s.name,
    kind: s.kind,
    start: s.start,
    lines: s.lines.map((l) => ({ text: l.text, at: Math.round(Math.max(s.start, l.start - 0.05) * 1000) / 1000 })),
  }));
}

/** Whether lyrics reading is set up, and the stored transcript's date (if any). */
export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[id]/lyrics">) {
  return handle(async () => {
    await access((await ctx.params).id, "view");
    const t = await storedTranscript((await ctx.params).id);
    return Response.json({ configured: transcriptionConfigured(), transcript: t ? { created_at: t.created_at, words: t.words.length } : null });
  });
}

/**
 * actions:
 *  transcribe {autoSections}  — 1 ElevenLabs call, stores the words, returns a preview plan
 *  plan {autoSections}        — preview from the stored transcript (free)
 *  apply {autoSections}       — writes the plan into the project (free), returns the tree
 *  rebuildPlan                — preview of the whole song rebuilt from the vocals (free)
 *  rebuild                    — replaces all sections + lines with it (version saved first; free)
 */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/lyrics">) {
  return handle(async () => {
    await access((await ctx.params).id, "edit");
    const { id } = await ctx.params;
    const b = await body<{ action: string; autoSections?: boolean }>(req);
    const tree = await getTree(id);
    if (!tree.audio) return Response.json({ error: "Upload a beat first." }, { status: 400 });
    const auto = b.autoSections ?? true;
    if (b.action === "transcribe") {
      const words = await transcribeBeat(id, tree.project.language);
      return Response.json({ plan: plan(await getTree(id), words, auto), words: words.length });
    }
    const stored = await storedTranscript(id);
    if (!stored) return Response.json({ error: "Read the lyrics first." }, { status: 400 });
    if (b.action === "plan") return Response.json({ plan: plan(tree, stored.words, auto), words: stored.words.length });
    if (b.action === "rebuildPlan") return Response.json({ song: rebuild(tree, stored.words) });
    if (b.action === "rebuild") {
      const group = tree.project.type === "song" || tree.project.type === "rap" ? 2 : 1;
      const song = rebuild(tree, stored.words);
      if (!song.some((x) => x.lines.length))
        return Response.json({ error: "No vocals were found in this song — the sections stay as they are." }, { status: 400 });
      await rebuildSong(id, song, group);
      return treeResponse(id);
    }
    if (b.action === "apply") {
      const p = plan(tree, stored.words, auto);
      const group = tree.project.type === "song" || tree.project.type === "rap" ? 2 : 1;
      await applyLyricsPlan(id, p, group);
      // the taken-over lines follow the vocals exactly from now on
      await setLineTimes(id, vocalTimes(await getTree(id), stored.words));
      return treeResponse(id);
    }
    if (b.action === "sync") {
      // no API call: aligns the written lines with the stored transcript; x-synced = lines found
      const times = vocalTimes(tree, stored.words);
      await setLineTimes(id, times);
      const res = await treeResponse(id);
      res.headers.set("x-synced", String(times.length));
      return res;
    }
    return Response.json({ error: "Unknown action" }, { status: 400 });
  });
}
