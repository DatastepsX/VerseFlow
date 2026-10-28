import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { headers } from "next/headers";
import { check, db } from "./db";
import { orderSections } from "@/lib/order";
import type {
  AiUsage,
  Alternative,
  AudioTrack,
  BankLine,
  Line,
  LineEvent,
  LineFlow,
  LineKind,
  LineStatus,
  Project,
  ProjectSettings,
  ProjectTree,
  ProjectType,
  ProjectVersion,
  Section,
  FlowPattern,
  SongFlow,
  Take,
} from "@/lib/types";
import { lineFlowFrom, lineStarts, linesIn, nextFlowName, ownWords } from "@/lib/flow/pattern";
import { isExampleText } from "@/lib/flow/example";
import { fixPairs } from "@/lib/flow/rhymelines";
import { songSections, type SungLine } from "@/lib/audio/song-lines";
import { sectionRanges } from "@/lib/audio/song-map";
import type { Extension } from "@/lib/audio/arrange";

const r3 = (t: number) => Math.round(t * 1000) / 1000;

const TAKE_COLS = "id, section_id, lane, take_no, start_at, duration, sample_rate, peaks, chosen, trim_in, trim_out, gain, pan, note, created_at";
const LINE_COLS = "id, project_id, section_id, position, text, status, kind, note, audio_at, flow, marks, updated_at";
const SNAPSHOT_FIELDS = ["text", "status", "kind", "note", "deleted", "flow", "marks"] as const;

export class NotFound extends Error {}

// ---------- undo steps: one per user action ----------

/**
 * Every API request runs in a scope (see http.ts `handle`): the line changes it makes form one undo step.
 * An action that takes several requests (a new flow: its lines, then their lyrics) sends the same
 * `x-undo-step` id (and an `x-undo-label`) with each, so it stays one step.
 */
export const requestScope = new AsyncLocalStorage<{ key: string; steps: Map<string, number> }>();

const ACTION_LABELS: Record<string, string> = {
  approve: "Keep",
  unkeep: "Unkeep",
  swap: "Next option",
  edit: "Edit",
  delete: "Remove line",
  create: "New line",
  flow: "New lyrics",
  restore: "Restore",
  move: "Move line",
  marks: "Marks",
};

async function currentStep(projectId: string, action: string): Promise<number | null> {
  const scope = requestScope.getStore();
  let key: string | undefined;
  let label = ACTION_LABELS[action] ?? "Change";
  try {
    const h = await headers();
    key = h.get("x-undo-step") ?? undefined;
    const l = h.get("x-undo-label");
    if (l) label = decodeURIComponent(l).slice(0, 80);
  } catch {
    // outside a request (scripts): no step
  }
  key = key ?? scope?.key;
  if (!key) return null;
  const cached = scope?.steps.get(`${projectId}|${key}`);
  if (cached) return cached;
  let row = check(await db().from("undo_steps").select("id").eq("project_id", projectId).eq("key", key).maybeSingle()) as { id: number } | null;
  if (!row) {
    // a new action: what could have been redone is gone
    await db().from("undo_steps").delete().eq("project_id", projectId).eq("undone", true);
    await db().from("undo_steps").upsert({ project_id: projectId, key, label }, { onConflict: "project_id,key", ignoreDuplicates: true });
    row = check(await db().from("undo_steps").select("id").eq("project_id", projectId).eq("key", key).single()) as { id: number };
  }
  scope?.steps.set(`${projectId}|${key}`, row.id);
  return row.id;
}

/** a whole-song rebuild: its undo brings back the version saved before it */
async function markRebuild(projectId: string, versionId: string, label: string) {
  const step = await currentStep(projectId, "rebuild");
  if (step) check(await db().from("undo_steps").update({ version_id: versionId, label }).eq("id", step));
}

/** the sections and lines of a version in place of the current ones — the same ids (undo / redo of a rebuild) */
async function replaceWithVersion(projectId: string, versionId: string) {
  const v = await getVersion(versionId);
  check(await db().from("sections").delete().eq("project_id", projectId));
  await insertSnapshot(projectId, v.snapshot, true);
  const timing = (v.snapshot as { timing?: TimingSnapshot }).timing;
  if (timing) await restoreTiming(projectId, timing);
}

interface TimingSnapshot {
  takes: { id: string; start_at: number }[];
  audio: { duration: number | null; changes: AudioTrack["changes"] } | null;
  extensions: Extension[];
}

/** the song's length as it was: where its takes and beat changes sit, and the bars added to it */
async function restoreTiming(projectId: string, t: TimingSnapshot) {
  await Promise.all(t.takes.map(async (x) => check(await db().from("takes").update({ start_at: x.start_at }).eq("id", x.id).eq("project_id", projectId))));
  if (t.audio) check(await db().from("audio_tracks").update({ duration: t.audio.duration, changes: t.audio.changes }).eq("project_id", projectId));
  const p = check(await db().from("projects").select("settings").eq("id", projectId).single()) as { settings: ProjectSettings | null };
  check(await db().from("projects").update({ settings: { ...(p.settings ?? {}), extensions: t.extensions } }).eq("id", projectId));
}

/** what undo / redo can do now (for the buttons) */
async function historyOf(projectId: string): Promise<ProjectTree["history"]> {
  const steps = check(
    await db()
      .from("undo_steps")
      .select("id, label, undone, version_id, line_events(count)")
      .eq("project_id", projectId)
      .order("id", { ascending: false })
      .limit(100),
  ) as { id: number; label: string; undone: boolean; version_id: string | null; line_events: { count: number }[] }[];
  const live = steps.filter((x) => x.version_id || (x.line_events[0]?.count ?? 0) > 0);
  const undo = live.filter((x) => !x.undone);
  const redo = live.filter((x) => x.undone);
  // changes made before steps existed: still undoable one by one
  let legacy = 0;
  if (!undo.length) {
    const ev = check(await db().from("line_events").select("id").eq("project_id", projectId).eq("undone", false).is("step_id", null).limit(50)) as { id: number }[];
    legacy = ev.length;
  }
  return { undo: undo.length + legacy, redo: redo.length, undoLabel: undo[0]?.label ?? (legacy ? "Last change" : null), redoLabel: redo[redo.length - 1]?.label ?? null };
}

// ---------- projects ----------

export async function listProjects() {
  return check(
    await db()
      .from("projects")
      .select("id, title, type, language, updated_at")
      .order("updated_at", { ascending: false }),
  ) as Pick<Project, "id" | "title" | "type" | "language" | "updated_at">[];
}

function defaultSections(type: ProjectType): { name: string; group_size: number }[] {
  switch (type) {
    case "song":
    case "rap":
      return [
        { name: "Part I", group_size: 2 },
        { name: "Hook", group_size: 2 },
        { name: "Part II", group_size: 2 },
      ];
    case "poem":
    case "spoken_word":
      return [{ name: "Stanza 1", group_size: 4 }];
    case "marketing":
      return [
        { name: "Headline", group_size: 1 },
        { name: "Body", group_size: 1 },
      ];
    default:
      return [{ name: "Text", group_size: 1 }];
  }
}

export async function createProject(input: {
  title: string;
  type: ProjectType;
  language: string;
  concept?: string | null;
  settings?: ProjectSettings;
}) {
  const project = check(
    await db()
      .from("projects")
      .insert({
        title: input.title.trim() || "Untitled",
        type: input.type,
        language: input.language,
        concept: input.concept ?? null,
        settings: input.settings ?? {},
      })
      .select()
      .single(),
  ) as Project;
  const sections = defaultSections(input.type).map((s, i) => ({ ...s, project_id: project.id, position: i + 1 }));
  check(await db().from("sections").insert(sections));
  return project;
}

export async function getTree(projectId: string): Promise<ProjectTree> {
  const [p, s, l, a, b, u, au, tk, fl] = await Promise.all([
    db().from("projects").select("*").eq("id", projectId).maybeSingle(),
    db().from("sections").select("*").eq("project_id", projectId).order("position"),
    db().from("lines").select(LINE_COLS).eq("project_id", projectId).eq("deleted", false).order("position"),
    db()
      .from("alternatives")
      .select("id, line_id, text, source, state, instruction, created_at")
      .eq("project_id", projectId)
      .eq("state", "pending")
      .order("created_at"),
    db()
      .from("bank_lines")
      .select("id, section_id, family, family_pos, text, state")
      .eq("project_id", projectId)
      .in("state", ["available", "used"])
      .order("created_at")
      .order("family_pos"),
    db().from("ai_calls").select("input_tokens, output_tokens").eq("project_id", projectId),
    db()
      .from("audio_tracks")
      .select("filename, duration, bpm, beat_offset, beats_per_bar, changes, instrumental_path")
      .eq("project_id", projectId)
      .maybeSingle(),
    db().from("takes").select(TAKE_COLS).eq("project_id", projectId).order("created_at"),
    db().from("flows").select("id, name, pattern, created_at").eq("project_id", projectId).order("created_at"),
  ]);
  const project = check(p) as Project | null;
  if (!project) throw new NotFound("Project not found");
  // song order: anchored sections follow the beat
  const sections = orderSections(check(s) as Section[]);
  const lines = check(l) as Line[];
  const alts = check(a) as Alternative[];
  const bank = check(b) as BankLine[];
  const calls = check(u) as { input_tokens: number; output_tokens: number }[];
  const usage: AiUsage = {
    calls: calls.length,
    input_tokens: calls.reduce((n, c) => n + c.input_tokens, 0),
    output_tokens: calls.reduce((n, c) => n + c.output_tokens, 0),
  };
  const altsByLine = new Map<string, Alternative[]>();
  for (const alt of alts) (altsByLine.get(alt.line_id) ?? altsByLine.set(alt.line_id, []).get(alt.line_id)!).push(alt);
  return {
    project,
    sections: sections.map((sec) => ({
      ...sec,
      lines: lines
        .filter((ln) => ln.section_id === sec.id)
        .map((ln) => ({ ...ln, alternatives: altsByLine.get(ln.id) ?? [] })),
    })),
    bank,
    usage,
    audio: check(au) as AudioTrack | null,
    takes: check(tk) as Take[],
    flows: check(fl) as SongFlow[],
    history: await historyOf(projectId),
  };
}

async function touch(projectId: string) {
  await db().from("projects").update({ updated_at: new Date().toISOString() }).eq("id", projectId);
}

export async function updateProject(
  id: string,
  patch: Partial<Pick<Project, "title" | "type" | "language" | "concept" | "settings">>,
) {
  check(await db().from("projects").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id));
}

export async function deleteProject(id: string) {
  // the uploaded beats live in storage under the project's folder: remove them too
  const { data: files } = await db().storage.from(BUCKET).list(id, { limit: 1000 });
  if (files?.length) await db().storage.from(BUCKET).remove(files.map((f) => `${id}/${f.name}`));
  check(await db().from("projects").delete().eq("id", id));
}

export async function duplicateProject(id: string) {
  const tree = await getTree(id);
  const copy = check(
    await db()
      .from("projects")
      .insert({
        title: `${tree.project.title} (copy)`,
        type: tree.project.type,
        language: tree.project.language,
        concept: tree.project.concept,
        settings: tree.project.settings,
      })
      .select()
      .single(),
  ) as Project;
  await insertSnapshot(copy.id, tree, false);
  return copy;
}

// ---------- sections ----------

export async function addSection(projectId: string, input: { name: string; group_size?: number; audio_start?: number | null }) {
  const last = check(
    await db().from("sections").select("position").eq("project_id", projectId).order("position", { ascending: false }).limit(1),
  ) as { position: number }[];
  const row = check(
    await db()
      .from("sections")
      .insert({
        project_id: projectId,
        name: input.name.trim() || "New section",
        group_size: input.group_size ?? 2,
        audio_start: input.audio_start ?? null,
        position: (last[0]?.position ?? 0) + 1,
      })
      .select("id")
      .single(),
  ) as { id: string };
  await touch(projectId);
  return row.id;
}

export async function updateSection(
  id: string,
  patch: Partial<
    Pick<Section, "name" | "group_size" | "story_beat" | "intensity" | "rhyme_scheme" | "notes" | "audio_start" | "bars_per_line" | "pattern">
  >,
) {
  const s = check(await db().from("sections").update(patch).eq("id", id).select("project_id").single()) as { project_id: string };
  await touch(s.project_id);
  return s.project_id;
}

export async function deleteSection(id: string) {
  const s = check(await db().from("sections").delete().eq("id", id).select("project_id").single()) as { project_id: string };
  await touch(s.project_id);
  return s.project_id;
}

export async function moveSection(id: string, dir: -1 | 1) {
  const sec = check(await db().from("sections").select("id, project_id").eq("id", id).single()) as Section;
  const all = orderSections(
    check(await db().from("sections").select("id, position, audio_start").eq("project_id", sec.project_id).order("position")) as Section[],
  );
  const i = all.findIndex((x) => x.id === id);
  const j = i + dir;
  if (j < 0 || j >= all.length) return sec.project_id;
  [all[i], all[j]] = [all[j], all[i]];
  // persist the shown order so positions and song order agree
  await Promise.all(all.map((x, k) => db().from("sections").update({ position: k + 1 }).eq("id", x.id)));
  await touch(sec.project_id);
  return sec.project_id;
}

// ---------- lines + history ----------

type LineSnapshot = Pick<Line, "text" | "status" | "kind" | "note"> & { deleted?: boolean };

function snap(line: Partial<Line> & { deleted?: boolean }): Partial<LineSnapshot> {
  const out: Record<string, unknown> = {};
  for (const k of SNAPSHOT_FIELDS) if (k in line) out[k] = (line as Record<string, unknown>)[k];
  return out as Partial<LineSnapshot>;
}

async function recordEvent(projectId: string, lineId: string, action: string, before: object | null, after: object | null) {
  const step = await currentStep(projectId, action);
  // a new action invalidates anything that could have been redone
  await db().from("line_events").delete().eq("project_id", projectId).eq("undone", true);
  check(await db().from("line_events").insert({ project_id: projectId, line_id: lineId, action, before, after, step_id: step }));
}

async function getLine(id: string) {
  const line = check(await db().from("lines").select(LINE_COLS + ", deleted").eq("id", id).maybeSingle()) as
    | (Line & { deleted: boolean })
    | null;
  if (!line) throw new NotFound("Line not found");
  return line;
}

export async function addLine(
  sectionId: string,
  input: { text?: string; status?: LineStatus; kind?: LineKind; afterLineId?: string | null },
) {
  const section = check(await db().from("sections").select("id, project_id").eq("id", sectionId).single()) as Section;
  const lines = check(
    await db().from("lines").select("id, position").eq("section_id", sectionId).eq("deleted", false).order("position"),
  ) as { id: string; position: number }[];
  let position = (lines[lines.length - 1]?.position ?? 0) + 1;
  if (input.afterLineId === null) {
    position = (lines[0]?.position ?? 1) - 1; // insert at the top
  } else if (input.afterLineId) {
    const i = lines.findIndex((l) => l.id === input.afterLineId);
    if (i >= 0) position = i + 1 < lines.length ? (lines[i].position + lines[i + 1].position) / 2 : lines[i].position + 1;
  }
  const line = check(
    await db()
      .from("lines")
      .insert({
        project_id: section.project_id,
        section_id: sectionId,
        position,
        text: input.text ?? "",
        status: input.status ?? "OPEN",
        kind: input.kind ?? "lyric",
      })
      .select(LINE_COLS)
      .single(),
  ) as Line;
  await recordEvent(section.project_id, line.id, "create", { deleted: true }, snap({ ...line, deleted: false }));
  await touch(section.project_id);
  return line;
}

/** Append many lines at once (e.g. imported lyrics), with one "create" history event per line. */
export async function appendLines(sectionId: string, items: { text: string; status: LineStatus }[]): Promise<Line[]> {
  if (!items.length) return [];
  const section = check(await db().from("sections").select("id, project_id").eq("id", sectionId).single()) as Section;
  const last = check(
    await db().from("lines").select("position").eq("section_id", sectionId).eq("deleted", false).order("position", { ascending: false }).limit(1),
  ) as { position: number }[];
  const base = last[0]?.position ?? 0;
  const rows = check(
    await db()
      .from("lines")
      .insert(
        items.map((it, i) => ({
          project_id: section.project_id,
          section_id: sectionId,
          position: base + i + 1,
          text: it.text,
          status: it.status,
          kind: "lyric",
        })),
      )
      .select(LINE_COLS),
  ) as Line[];
  await db().from("line_events").delete().eq("project_id", section.project_id).eq("undone", true);
  check(
    await db()
      .from("line_events")
      .insert(
        rows
          .sort((a, b) => a.position - b.position)
          .map((line) => ({
            project_id: section.project_id,
            line_id: line.id,
            action: "create",
            before: { deleted: true },
            after: snap({ ...line, deleted: false }),
          })),
      ),
  );
  return rows;
}

/** a line's text (marks are checked against it) */
export async function lineText(id: string) {
  return (await getLine(id)).text;
}

export async function updateLine(
  id: string,
  patch: Partial<Pick<Line, "text" | "status" | "kind" | "note" | "flow" | "marks">>,
  action = "edit",
) {
  const before = await getLine(id);
  const changed = Object.entries(patch).some(([k, v]) => (before as unknown as Record<string, unknown>)[k] !== v);
  if (!changed) return before.project_id;
  check(await db().from("lines").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id));
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  const b: Record<string, unknown> = {};
  for (const k of keys) b[k] = before[k];
  await recordEvent(before.project_id, id, action, b, patch);
  // a decided line no longer needs pending options
  if (patch.status === "APPROVED" || patch.status === "APPROVED_EDITED") {
    await db().from("alternatives").update({ state: "rejected" }).eq("line_id", id).eq("state", "pending");
  }
  await touch(before.project_id);
  return before.project_id;
}

export async function deleteLine(id: string) {
  const before = await getLine(id);
  check(await db().from("lines").update({ deleted: true }).eq("id", id));
  await recordEvent(before.project_id, id, "delete", { deleted: false }, { deleted: true });
  await touch(before.project_id);
  return before.project_id;
}

export async function moveLine(id: string, dir: -1 | 1) {
  const line = await getLine(id);
  const lines = check(
    await db().from("lines").select("id, position").eq("section_id", line.section_id).eq("deleted", false).order("position"),
  ) as { id: string; position: number }[];
  const i = lines.findIndex((l) => l.id === id);
  const j = i + dir;
  if (j >= 0 && j < lines.length) {
    await Promise.all([
      db().from("lines").update({ position: lines[j].position }).eq("id", lines[i].id),
      db().from("lines").update({ position: lines[i].position }).eq("id", lines[j].id),
    ]);
  }
  return line.project_id;
}

export async function listHistory(projectId: string, lineId?: string) {
  let q = db()
    .from("line_events")
    .select("id, line_id, action, before, after, undone, created_at")
    .eq("project_id", projectId)
    .order("id", { ascending: false })
    .limit(150);
  if (lineId) q = q.eq("line_id", lineId);
  return check(await q) as LineEvent[];
}

async function applySnapshot(lineId: string, s: Partial<LineSnapshot> | null) {
  if (!s || Object.keys(s).length === 0) return;
  check(await db().from("lines").update({ ...s, updated_at: new Date().toISOString() }).eq("id", lineId));
}

/** undoes the last step (all its line changes, or the rebuild it was); its label, or null when there's nothing */
export async function undo(projectId: string): Promise<string | null> {
  for (let guard = 0; guard < 100; guard++) {
    const [step] = check(
      await db().from("undo_steps").select("id, label, version_id").eq("project_id", projectId).eq("undone", false).order("id", { ascending: false }).limit(1),
    ) as { id: number; label: string; version_id: string | null }[];
    if (!step) return (await undoLegacy(projectId)) ? "Last change" : null;
    if (step.version_id) {
      // a rebuilt song: back to the version saved before it (the song as it is now is kept for redo)
      const timing = !!(((await getVersion(step.version_id)).snapshot as { timing?: unknown }).timing);
      const redoVersion = await saveVersion(projectId, `Before undoing “${step.label}”`, { timing });
      await replaceWithVersion(projectId, step.version_id);
      check(await db().from("undo_steps").update({ undone: true, redo_version_id: redoVersion }).eq("id", step.id));
      await touch(projectId);
      return step.label;
    }
    const evs = check(
      await db().from("line_events").select("id, line_id, before").eq("step_id", step.id).eq("undone", false).order("id", { ascending: false }),
    ) as LineEvent[];
    // nothing left in it (its lines went with a rebuilt song): skip it
    if (!evs.length) {
      check(await db().from("undo_steps").delete().eq("id", step.id));
      continue;
    }
    for (const ev of evs) await applySnapshot(ev.line_id, ev.before as Partial<LineSnapshot>);
    check(await db().from("line_events").update({ undone: true }).eq("step_id", step.id));
    check(await db().from("undo_steps").update({ undone: true }).eq("id", step.id));
    await touch(projectId);
    return step.label;
  }
  return null;
}

/** redoes the step undone last; its label, or null */
export async function redo(projectId: string): Promise<string | null> {
  for (let guard = 0; guard < 100; guard++) {
    const [step] = check(
      await db()
        .from("undo_steps")
        .select("id, label, version_id, redo_version_id")
        .eq("project_id", projectId)
        .eq("undone", true)
        .order("id", { ascending: true })
        .limit(1),
    ) as { id: number; label: string; version_id: string | null; redo_version_id: string | null }[];
    if (!step) return (await redoLegacy(projectId)) ? "Last change" : null;
    if (step.version_id) {
      if (!step.redo_version_id) {
        check(await db().from("undo_steps").delete().eq("id", step.id));
        continue;
      }
      await replaceWithVersion(projectId, step.redo_version_id);
      check(await db().from("undo_steps").update({ undone: false }).eq("id", step.id));
      await touch(projectId);
      return step.label;
    }
    const evs = check(
      await db().from("line_events").select("id, line_id, after").eq("step_id", step.id).eq("undone", true).order("id", { ascending: true }),
    ) as LineEvent[];
    if (!evs.length) {
      check(await db().from("undo_steps").delete().eq("id", step.id));
      continue;
    }
    for (const ev of evs) await applySnapshot(ev.line_id, ev.after as Partial<LineSnapshot>);
    check(await db().from("line_events").update({ undone: false }).eq("step_id", step.id));
    check(await db().from("undo_steps").update({ undone: false }).eq("id", step.id));
    await touch(projectId);
    return step.label;
  }
  return null;
}

/** changes from before undo steps existed: one line event at a time */
async function undoLegacy(projectId: string) {
  const ev = check(
    await db()
      .from("line_events")
      .select("id, line_id, before")
      .eq("project_id", projectId)
      .eq("undone", false)
      .is("step_id", null)
      .order("id", { ascending: false })
      .limit(1),
  ) as LineEvent[];
  if (!ev[0]) return false;
  await applySnapshot(ev[0].line_id, ev[0].before as Partial<LineSnapshot>);
  check(await db().from("line_events").update({ undone: true }).eq("id", ev[0].id));
  await touch(projectId);
  return true;
}

async function redoLegacy(projectId: string) {
  const ev = check(
    await db()
      .from("line_events")
      .select("id, line_id, after")
      .eq("project_id", projectId)
      .eq("undone", true)
      .is("step_id", null)
      .order("id", { ascending: true })
      .limit(1),
  ) as LineEvent[];
  if (!ev[0]) return false;
  await applySnapshot(ev[0].line_id, ev[0].after as Partial<LineSnapshot>);
  check(await db().from("line_events").update({ undone: false }).eq("id", ev[0].id));
  await touch(projectId);
  return true;
}

/** Bring back a line's text/status as it was before or after a past event. */
export async function restoreFromEvent(eventId: number, which: "before" | "after") {
  const ev = check(await db().from("line_events").select("line_id, before, after").eq("id", eventId).single()) as LineEvent;
  const s = (which === "before" ? ev.before : ev.after) as Partial<LineSnapshot> | null;
  if (!s) return null;
  const patch: Partial<LineSnapshot> = {};
  if (s.text !== undefined) patch.text = s.text;
  if (s.status !== undefined) patch.status = s.status;
  if (s.deleted !== undefined) {
    const line = await getLine(ev.line_id);
    check(await db().from("lines").update({ deleted: s.deleted }).eq("id", ev.line_id));
    await recordEvent(line.project_id, ev.line_id, "restore", { deleted: line.deleted }, { deleted: s.deleted });
  }
  if (Object.keys(patch).length) return updateLine(ev.line_id, patch, "restore");
  return (await getLine(ev.line_id)).project_id;
}

// ---------- alternatives ----------

export async function addAlternatives(lineId: string, texts: string[], source: "ai" | "user", instruction?: string) {
  const line = await getLine(lineId);
  const rows = texts
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text) => ({ line_id: lineId, project_id: line.project_id, text, source, instruction: instruction ?? null }));
  if (rows.length) check(await db().from("alternatives").insert(rows));
  if (line.status !== "APPROVED" && line.status !== "APPROVED_EDITED" && source === "ai") {
    await updateLine(lineId, { status: "NEEDS_NEW_OPTIONS" }, "request_options");
  }
  await touch(line.project_id);
  return line.project_id;
}

export async function selectAlternative(altId: string, editedText?: string) {
  const alt = check(await db().from("alternatives").select("id, line_id, text").eq("id", altId).single()) as Alternative;
  const text = (editedText ?? alt.text).trim();
  const edited = editedText !== undefined && text !== alt.text.trim();
  const status: LineStatus = edited ? "APPROVED_EDITED" : "APPROVED";
  check(await db().from("alternatives").update({ state: "selected" }).eq("id", altId));
  const parts = text.split("\n").map((t) => t.trim()).filter(Boolean);
  if (parts.length <= 1) return updateLine(alt.line_id, { text, status }, "select_alternative");
  // a couplet/group option: fill the target line and the lines that follow it
  const first = await getLine(alt.line_id);
  const following = check(
    await db()
      .from("lines")
      .select("id, position")
      .eq("section_id", first.section_id)
      .eq("deleted", false)
      .gte("position", first.position)
      .order("position")
      .limit(parts.length),
  ) as { id: string }[];
  let prev = first.id;
  for (let k = 0; k < parts.length; k++) {
    if (following[k]) {
      await updateLine(following[k].id, { text: parts[k], status }, "select_alternative");
      prev = following[k].id;
    } else {
      prev = (await addLine(first.section_id, { text: parts[k], status, afterLineId: prev })).id;
    }
  }
  return first.project_id;
}

export async function rejectAlternative(altId: string) {
  const alt = check(
    await db().from("alternatives").update({ state: "rejected" }).eq("id", altId).select("project_id").single(),
  ) as { project_id: string };
  return alt.project_id;
}

export async function rejectedAlternatives(lineId: string) {
  return check(
    await db().from("alternatives").select("text").eq("line_id", lineId).eq("state", "rejected").order("created_at", { ascending: false }).limit(20),
  ) as { text: string }[];
}

// ---------- versions ----------

export async function listVersions(projectId: string) {
  return check(
    await db().from("project_versions").select("id, label, created_at").eq("project_id", projectId).order("created_at", { ascending: false }),
  ) as ProjectVersion[];
}

export async function saveVersion(projectId: string, label: string, opts: { timing?: boolean } = {}) {
  const tree = await getTree(projectId);
  const snapshot = {
    // a change to the song's length (a part made longer): undo also brings back where the takes and beat changes were
    ...(opts.timing
      ? {
          timing: {
            takes: tree.takes.map((t) => ({ id: t.id, start_at: t.start_at })),
            audio: tree.audio ? { duration: tree.audio.duration, changes: tree.audio.changes } : null,
            extensions: tree.project.settings?.extensions ?? [],
          },
        }
      : {}),
    project: { title: tree.project.title, concept: tree.project.concept, settings: tree.project.settings },
    sections: tree.sections.map(({ lines, ...s }) => ({
      ...s,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      lines: lines.map(({ alternatives: _a, ...l }) => l),
    })),
  };
  const row = check(await db().from("project_versions").insert({ project_id: projectId, label: label.trim() || "Version", snapshot }).select("id").single()) as {
    id: string;
  };
  return row.id;
}

export async function getVersion(versionId: string) {
  return check(await db().from("project_versions").select("*").eq("id", versionId).single()) as ProjectVersion & {
    project_id: string;
    snapshot: { sections: (Section & { lines: Line[] })[] };
  };
}

async function insertSnapshot(projectId: string, tree: { sections: (Section & { lines: Line[] })[] }, keepIds: boolean) {
  for (const s of tree.sections) {
    const sec = check(
      await db()
        .from("sections")
        .insert({
          ...(keepIds ? { id: s.id } : {}),
          project_id: projectId,
          name: s.name,
          position: s.position,
          group_size: s.group_size,
          story_beat: s.story_beat,
          intensity: s.intensity,
          rhyme_scheme: s.rhyme_scheme,
          notes: s.notes,
          audio_start: s.audio_start ?? null,
          bars_per_line: s.bars_per_line ?? 1,
          pattern: s.pattern ?? null,
          artists: s.artists ?? [],
        })
        .select("id")
        .single(),
    ) as { id: string };
    if (s.lines.length) {
      check(
        await db()
          .from("lines")
          .insert(
            s.lines.map((l) => ({
              ...(keepIds ? { id: l.id } : {}),
              project_id: projectId,
              section_id: sec.id,
              position: l.position,
              text: l.text,
              status: l.status,
              kind: l.kind,
              note: l.note,
              audio_at: l.audio_at ?? null,
              flow: l.flow ?? null,
              marks: l.marks ?? null,
            })),
          ),
      );
    }
  }
}

export async function restoreVersion(versionId: string) {
  const v = await getVersion(versionId);
  await saveVersion(v.project_id, `Auto-saved before restoring “${v.label}”`);
  check(await db().from("sections").delete().eq("project_id", v.project_id));
  await insertSnapshot(v.project_id, v.snapshot, false);
  await touch(v.project_id);
  return v.project_id;
}

// ---------- suggestion bank + AI usage ----------

export async function insertBank(
  projectId: string,
  sectionId: string,
  families: { rhyme: string; lines: string[] }[],
) {
  const batch_id = crypto.randomUUID();
  const rows = families.flatMap((f, fi) =>
    f.lines
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text, pos) => ({
        project_id: projectId,
        section_id: sectionId,
        family: `${batch_id.slice(0, 8)}:${fi}:${f.rhyme}`,
        family_pos: pos,
        text,
        batch_id,
      })),
  );
  if (rows.length) check(await db().from("bank_lines").insert(rows));
  return rows.length;
}

export async function setBankState(id: string, state: "used" | "rejected" | "available") {
  const row = check(await db().from("bank_lines").update({ state }).eq("id", id).select("project_id").single()) as {
    project_id: string;
  };
  return row.project_id;
}

export async function clearBank(sectionId: string) {
  check(await db().from("bank_lines").update({ state: "rejected" }).eq("section_id", sectionId).eq("state", "available"));
}

export async function bankTexts(sectionId: string, state: "rejected" | "available", limit = 40) {
  return (
    check(
      await db()
        .from("bank_lines")
        .select("text")
        .eq("section_id", sectionId)
        .eq("state", state)
        .order("created_at", { ascending: false })
        .limit(limit),
    ) as { text: string }[]
  ).map((r) => r.text);
}

export async function recordAiCall(
  projectId: string,
  kind: string,
  model: string,
  usage: { input_tokens?: number | null; output_tokens?: number | null },
) {
  await db()
    .from("ai_calls")
    .insert({
      project_id: projectId,
      kind,
      model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
    });
}

// ---------- audio (beat) ----------

const BUCKET = "beats";

export async function audioUploadUrl(projectId: string, filename: string) {
  const ext = (filename.match(/\.([a-z0-9]{2,4})$/i)?.[1] ?? "mp3").toLowerCase();
  const path = `${projectId}/${crypto.randomUUID()}.${ext}`;
  const { data, error } = await db().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(error?.message ?? "Could not create upload URL");
  return { path, signedUrl: data.signedUrl };
}

export async function saveAudio(
  projectId: string,
  t: {
    path: string;
    filename: string;
    duration: number | null;
    bpm: number | null;
    beat_offset: number;
    changes: AudioTrack["changes"];
  },
) {
  if (!t.path.startsWith(`${projectId}/`)) throw new Error("Invalid audio path");
  const old = check(await db().from("audio_tracks").select("path, instrumental_path, vocals_path").eq("project_id", projectId).maybeSingle()) as {
    path: string;
    instrumental_path: string | null;
    vocals_path: string | null;
  } | null;
  // a new song: its old stems go
  const stems = old && old.path !== t.path ? [old.instrumental_path, old.vocals_path].filter((x): x is string => !!x) : [];
  if (stems.length) await db().storage.from(BUCKET).remove(stems);
  check(
    await db()
      .from("audio_tracks")
      .upsert({
        ...(old && old.path !== t.path ? { instrumental_path: null, vocals_path: null } : {}),
        project_id: projectId,
        path: t.path,
        filename: t.filename,
        duration: t.duration,
        bpm: t.bpm,
        beat_offset: t.beat_offset,
        changes: t.changes,
      }),
  );
  if (old && old.path !== t.path) await db().storage.from(BUCKET).remove([old.path]);
}

export async function updateAudio(projectId: string, patch: Partial<Pick<AudioTrack, "bpm" | "beat_offset" | "beats_per_bar" | "changes">>) {
  check(await db().from("audio_tracks").update(patch).eq("project_id", projectId));
}

export async function deleteAudio(projectId: string) {
  const old = check(await db().from("audio_tracks").select("path, instrumental_path, vocals_path").eq("project_id", projectId).maybeSingle()) as {
    path: string;
    instrumental_path: string | null;
    vocals_path: string | null;
  } | null;
  if (!old) return;
  await db().storage.from(BUCKET).remove([old.path, old.instrumental_path, old.vocals_path].filter((x): x is string => !!x));
  check(await db().from("audio_tracks").delete().eq("project_id", projectId));
  check(await db().from("sections").update({ audio_start: null }).eq("project_id", projectId));
}

/** Short-lived URLs the browser can stream the song from — and the song without its vocals, when made. */
export async function audioPlaybackUrl(projectId: string) {
  const row = check(await db().from("audio_tracks").select("path, instrumental_path").eq("project_id", projectId).maybeSingle()) as {
    path: string;
    instrumental_path: string | null;
  } | null;
  if (!row) return { url: null, instrumentalUrl: null };
  const sign = async (path: string) => {
    const { data, error } = await db().storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 6);
    if (error || !data) throw new Error(error?.message ?? "Could not create playback URL");
    return data.signedUrl;
  };
  return { url: await sign(row.path), instrumentalUrl: row.instrumental_path ? await sign(row.instrumental_path) : null };
}

// ---------- lyrics from the beat ----------

/**
 * Apply a lyrics plan: create detected sections, then fill empty / missing
 * lines through addLine / updateLine so every change is in the history.
 * Lines that already have text are never touched.
 */
/**
 * Line timing on the beat (playback metadata, not lyrics: no history event,
 * like the section anchors). at = null → estimated again.
 */
export async function setLineTimes(projectId: string, times: { id: string; at: number | null }[]) {
  await Promise.all(
    times.map(async (x) =>
      check(
        await db()
          .from("lines")
          .update({ audio_at: x.at === null ? null : Math.max(0, Math.round(x.at * 1000) / 1000) })
          .eq("id", x.id)
          .eq("project_id", projectId),
      ),
    ),
  );
  await touch(projectId);
}

export async function applyLyricsPlan(
  projectId: string,
  plan: import("@/lib/audio/lyrics").LyricsPlan,
  groupSize: number,
) {
  for (const id of plan.removeSectionIds) await deleteSection(id);
  for (const ps of plan.sections) {
    const sectionId = ps.id ?? (await addSection(projectId, { name: ps.name, group_size: groupSize, audio_start: ps.start }));
    const current = check(
      await db().from("lines").select("id, text").eq("section_id", sectionId).eq("deleted", false).order("position"),
    ) as { id: string; text: string }[];
    for (const l of ps.lines) {
      const target = current[l.index];
      if (l.action === "fill" && target && !target.text.trim())
        await updateLine(target.id, { text: l.text, status: "SUGGESTED" }, "transcribe");
    }
    await appendLines(
      sectionId,
      ps.lines.filter((l) => l.action === "add").map((l) => ({ text: l.text, status: l.text ? "SUGGESTED" : "OPEN" })),
    );
  }
  await touch(projectId);
}

// ---------- section drafts (fill / replace from the pattern) ----------

/**
 * Write a section draft: each slot's first option becomes the line (status
 * SUGGESTED), the other options become pending alternatives to cycle through.
 * Text that is replaced is kept as a rejected alternative so it isn't
 * suggested again. Missing lines up to the highest slot are created in order.
 */
export async function applyDraft(sectionId: string, slots: { index: number; options: string[] }[]) {
  if (!slots.length) return;
  const section = check(await db().from("sections").select("id, project_id").eq("id", sectionId).single()) as Section;
  const current = check(
    await db().from("lines").select("id, text, kind").eq("section_id", sectionId).eq("deleted", false).order("position"),
  ) as { id: string; text: string; kind: string }[];
  const lyric = current.filter((l) => l.kind === "lyric");
  const bySlot = new Map(slots.map((x) => [x.index, x.options]));
  const maxIdx = Math.max(...slots.map((x) => x.index));
  // create the missing lines first (empty ones where no slot text exists keep the bar positions)
  const missing = Array.from({ length: Math.max(0, maxIdx + 1 - lyric.length) }, (_, k) => lyric.length + k);
  const created = await appendLines(
    sectionId,
    missing.map((k) => ({ text: bySlot.get(k)?.[0] ?? "", status: bySlot.has(k) ? ("SUGGESTED" as LineStatus) : ("OPEN" as LineStatus) })),
  );
  const ids = [...lyric.map((l) => l.id), ...created.map((l) => l.id)];
  const altRows: Record<string, unknown>[] = [];
  for (const [k, options] of bySlot) {
    const id = ids[k];
    if (!id) continue;
    const existing = lyric[k];
    if (existing) {
      // old pending options are dropped, the old text is remembered as rejected
      await db().from("alternatives").update({ state: "rejected" }).eq("line_id", id).eq("state", "pending");
      if (existing.text.trim())
        altRows.push({ line_id: id, project_id: section.project_id, text: existing.text, source: "user", state: "rejected" });
      await updateLine(id, { text: options[0], status: "SUGGESTED" }, "draft");
    }
    for (const text of options.slice(1)) altRows.push({ line_id: id, project_id: section.project_id, text, source: "ai", state: "pending" });
  }
  if (altRows.length) check(await db().from("alternatives").insert(altRows));
  await touch(section.project_id);
}

/** Free "next option": the line takes the alternative's text, the old text becomes that alternative. */
export async function swapAlternative(altId: string) {
  const alt = check(await db().from("alternatives").select("id, line_id, text").eq("id", altId).single()) as Alternative;
  const line = await getLine(alt.line_id);
  // the swapped-out text goes to the back of the queue, so repeated ↻ cycles through all options
  check(await db().from("alternatives").update({ text: line.text, created_at: new Date().toISOString() }).eq("id", altId));
  return updateLine(alt.line_id, { text: alt.text, status: "SUGGESTED" }, "swap");
}

/**
 * Replaces the whole song with sections + lines rebuilt from the vocals
 * (a version is saved first, so it can be restored). Lines keep their sung
 * start (audio_at) so playback follows them exactly.
 */
export async function rebuildSong(
  projectId: string,
  sections: { name: string; start: number; lines: { text: string; at: number }[] }[],
  groupSize: number,
) {
  await markRebuild(projectId, await saveVersion(projectId, "Before rebuilding from the vocals"), "Song rebuilt from the vocals");
  const old = check(await db().from("sections").select("id").eq("project_id", projectId)) as { id: string }[];
  for (const s of old) await deleteSection(s.id);
  for (const s of sections) {
    const id = await addSection(projectId, { name: s.name, group_size: groupSize, audio_start: s.start });
    const rows = await appendLines(
      id,
      s.lines.map((l) => ({ text: l.text, status: "SUGGESTED" as LineStatus })),
    );
    await setLineTimes(
      projectId,
      rows.map((r, i) => ({ id: r.id, at: s.lines[i].at })),
    );
  }
  await touch(projectId);
}

/** "New section from here": this line and the ones after it move into a new section right after this one. */
export async function splitSection(lineId: string, name: string, start: number | null) {
  const line = await getLine(lineId);
  const section = check(await db().from("sections").select("*").eq("id", line.section_id).single()) as Section;
  const lines = check(
    await db().from("lines").select("id").eq("section_id", section.id).eq("deleted", false).order("position"),
  ) as { id: string }[];
  const k = lines.findIndex((l) => l.id === lineId);
  if (k <= 0) throw new Error("This is already the first line of the section.");
  // make room right after the section (for sections without a beat anchor)
  const after = check(
    await db().from("sections").select("id, position").eq("project_id", section.project_id).gt("position", section.position),
  ) as { id: string; position: number }[];
  for (const s of after) check(await db().from("sections").update({ position: s.position + 1 }).eq("id", s.id));
  const row = check(
    await db()
      .from("sections")
      .insert({
        project_id: section.project_id,
        name: name.trim() || "New section",
        group_size: section.group_size,
        bars_per_line: section.bars_per_line,
        artists: section.artists ?? [],
        audio_start: section.audio_start !== null ? start : null,
        position: section.position + 1,
      })
      .select("id")
      .single(),
  ) as { id: string };
  const moving = lines.slice(k).map((l) => l.id);
  check(await db().from("lines").update({ section_id: row.id }).in("id", moving));
  await touch(section.project_id);
  return section.project_id;
}

/**
 * Bars added to the song at `e.at` (a part made longer, a part pasted): everything from there on moves later —
 * parts, lines and their flows, takes, beat changes, the length — and the extension is kept in the settings, to
 * be applied to the uploaded song when it loads. Rebuild-style: its undo is the version saved (with timing) before.
 * `keep`: a part that stays where it is (the one made longer).
 */
async function insertBars(tree: ProjectTree, e: Extension, keep?: string) {
  const { at, len } = e;
  const a = tree.audio!;
  const projectId = tree.project.id;
  const later = (t: number | null | undefined) => t !== null && t !== undefined && t >= at - 0.01;
  await Promise.all([
    ...tree.sections
      .filter((x) => x.id !== keep && later(x.audio_start))
      .map(async (x) => check(await db().from("sections").update({ audio_start: r3(x.audio_start! + len) }).eq("id", x.id))),
    ...tree.sections
      .flatMap((x) => x.lines)
      .filter((l) => later(l.audio_at) || (l.flow?.times ?? []).some(later))
      .map(async (l) =>
        check(
          await db()
            .from("lines")
            .update({
              audio_at: later(l.audio_at) ? r3(l.audio_at! + len) : l.audio_at,
              flow: l.flow ? { ...l.flow, times: l.flow.times?.map((t) => (later(t) ? r3(t + len) : t)), end: later(l.flow.end) ? r3(l.flow.end! + len) : l.flow.end } : l.flow,
            })
            .eq("id", l.id),
        ),
      ),
    // takes after that point, and takes of a later part that start in its count-in
    ...tree.takes
      .filter((t) => t.start_at >= at - 0.05 || tree.sections.some((x) => x.id === t.section_id && x.id !== keep && later(x.audio_start)))
      .map(async (t) => check(await db().from("takes").update({ start_at: r3(t.start_at + len) }).eq("id", t.id))),
  ]);
  check(
    await db()
      .from("audio_tracks")
      .update({ duration: r3((a.duration ?? 0) + len), changes: (a.changes ?? []).map((c) => (c.t >= at - 0.01 ? { ...c, t: r3(c.t + len) } : c)) })
      .eq("project_id", projectId),
  );
  const settings = tree.project.settings ?? {};
  check(await db().from("projects").update({ settings: { ...settings, extensions: [...(settings.extensions ?? []), e] } }).eq("id", projectId));
}

/**
 * A part copied in after another one (`afterId`): its bars of the beat go in where that part ends (with the
 * original vocals when they are on in the copied part, else the music alone), a new part with its name and copies
 * of its lines — text, flow, marks — sits there, and everything after moves later. One undo step.
 */
export async function pasteSection(sourceId: string, afterId: string) {
  const s = check(await db().from("sections").select("project_id").eq("id", sourceId).single()) as { project_id: string };
  const projectId = s.project_id;
  const tree = await getTree(projectId);
  const a = tree.audio;
  if (!a?.bpm || !a.duration) throw new Error("The beat needs its tempo to paste a part.");
  const bar = (a.beats_per_bar * 60) / a.bpm;
  const onGrid = (t: number) => r3(Math.max(0, Math.min(a.duration!, a.beat_offset + Math.round((t - a.beat_offset) / bar) * bar)));
  const ranges = sectionRanges(tree.sections, a);
  const src = tree.sections.find((x) => x.id === sourceId)!;
  const target = tree.sections.find((x) => x.id === afterId);
  const sr = ranges.get(sourceId);
  const tr = ranges.get(afterId);
  if (!target || !sr || !tr) throw new Error("Both parts need their place on the beat.");
  const from = onGrid(sr.start);
  const to = onGrid(sr.end);
  const at = onGrid(tr.end);
  const len = r3(to - from);
  if (len < bar / 2) throw new Error("This part is too short to copy.");
  const off = tree.project.settings?.vocalsOff ?? "all";
  const vocals = !!a.instrumental_path && off !== "all" && !off.includes(sourceId);
  await markRebuild(projectId, await saveVersion(projectId, `Before pasting ${src.name}`, { timing: true }), `${src.name} pasted after ${target.name}`);
  await insertBars(tree, { at, from, to, len, ...(vocals ? { vocals: true } : {}) });
  // the new part right after the target (in order and on the beat)
  const after = tree.sections.filter((x) => x.position > target.position);
  await Promise.all(after.map(async (x) => check(await db().from("sections").update({ position: x.position + 1 }).eq("id", x.id))));
  const row = check(
    await db()
      .from("sections")
      .insert({
        project_id: projectId,
        name: src.name,
        position: target.position + 1,
        group_size: src.group_size,
        story_beat: src.story_beat,
        intensity: src.intensity,
        rhyme_scheme: src.rhyme_scheme,
        notes: src.notes,
        audio_start: at,
        bars_per_line: src.bars_per_line ?? 1,
        pattern: src.pattern ?? null,
        artists: src.artists ?? [],
      })
      .select("id")
      .single(),
  ) as { id: string };
  // its lines: copies, their times moved from the copied part to here (the copied part's times before anything moved)
  const move = (t: number) => r3(t - from + at);
  const lines = src.lines;
  if (lines.length)
    check(
      await db()
        .from("lines")
        .insert(
          lines.map((l) => ({
            project_id: projectId,
            section_id: row.id,
            position: l.position,
            text: l.text,
            status: l.status,
            kind: l.kind,
            note: l.note,
            audio_at: l.audio_at === null ? null : move(l.audio_at),
            flow: l.flow ? { ...l.flow, times: l.flow.times?.map(move), end: l.flow.end !== undefined ? move(l.flow.end) : undefined } : null,
            marks: l.marks ?? null,
          })),
        ),
    );
  // the original vocals: as in the copied part
  if (Array.isArray(off) && off.includes(sourceId))
    check(await db().from("projects").update({ settings: { ...(await getTree(projectId)).project.settings, vocalsOff: [...off, row.id] } }).eq("id", projectId));
  await touch(projectId);
  return projectId;
}

/**
 * A part made longer by `bars` bars: its last bars of the beat come again where it ends (the uploaded file stays
 * as it is — `settings.extensions` says where bars were added), everything after it moves later, and the new bars
 * get empty lines at the part's own line spacing, to write. One undo step (the version saved before, with timing).
 */
export async function extendSection(sectionId: string, bars: number) {
  const s = check(await db().from("sections").select("project_id").eq("id", sectionId).single()) as { project_id: string };
  const projectId = s.project_id;
  const tree = await getTree(projectId);
  const a = tree.audio;
  if (!a?.bpm || !a.duration) throw new Error("The beat needs its tempo to make a part longer.");
  const bar = (a.beats_per_bar * 60) / a.bpm;
  const section = tree.sections.find((x) => x.id === sectionId)!;
  const range = sectionRanges(tree.sections, a).get(sectionId);
  if (!range) throw new Error("This part has no place on the beat yet.");
  // where the part ends, on the bar grid
  const at = r3(Math.min(a.duration, a.beat_offset + Math.round((range.end - a.beat_offset) / bar) * bar));
  const len = r3(bars * bar);
  const from = r3(Math.max(range.start, at - len));
  if (at - from < bar / 2) throw new Error("This part is too short to repeat.");
  await markRebuild(projectId, await saveVersion(projectId, `Before making ${section.name} longer`, { timing: true }), `${section.name} · ${bars} bars longer`);
  await insertBars(tree, { at, from, len }, sectionId);
  // empty lines for the new bars, at the part's own line spacing (a line per bar when it has no timing)
  const starts = section.lines.filter((l) => l.kind === "lyric" && l.audio_at !== null).map((l) => l.audio_at!).sort((x, y) => x - y);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]).filter((g) => g > 0.3 * bar && g < 4.5 * bar).sort((x, y) => x - y);
  const spacing = gaps.length ? gaps[Math.floor(gaps.length / 2)] : bar * (section.bars_per_line || 1);
  const n = Math.max(1, Math.round(len / spacing));
  const rows = await appendLines(sectionId, Array.from({ length: n }, () => ({ text: "", status: "OPEN" as LineStatus })));
  await setLineTimes(projectId, rows.map((r, k) => ({ id: r.id, at: at + (k * len) / n })));
  return projectId;
}

/** Moves every line of the section to the end of the section before it and removes the section. */
export async function mergeIntoPrevious(sectionId: string) {
  const s = check(await db().from("sections").select("project_id").eq("id", sectionId).single()) as { project_id: string };
  const tree = await getTree(s.project_id);
  const i = tree.sections.findIndex((x) => x.id === sectionId);
  if (i <= 0) throw new Error("There is no section before this one.");
  const prev = tree.sections[i - 1];
  // one undo step: the parts as they were come back
  await markRebuild(s.project_id, await saveVersion(s.project_id, "Before merging parts"), `Merge ${prev.name} + ${tree.sections[i].name}`);
  // the original vocals: the merged part keeps the setting of the part before
  const off = tree.project.settings?.vocalsOff;
  if (Array.isArray(off) && off.includes(sectionId))
    check(await db().from("projects").update({ settings: { ...tree.project.settings, vocalsOff: off.filter((x) => x !== sectionId) } }).eq("id", s.project_id));
  const base = Math.max(0, ...prev.lines.map((l) => l.position));
  const moving = tree.sections[i].lines;
  await Promise.all(moving.map(async (l, k) => check(await db().from("lines").update({ section_id: prev.id, position: base + k + 1 }).eq("id", l.id))));
  await deleteSection(sectionId);
  return s.project_id;
}

/**
 * Pasted text → sections + lines (marked as drafts, so the review / polish tools apply).
 * replace = the project's empty default sections make way for the imported ones.
 */
export async function importSections(
  projectId: string,
  sections: { name: string; lines: string[]; groupSize?: number }[],
  groupSize: number,
  replace: boolean,
) {
  if (replace) {
    const tree = await getTree(projectId);
    const empty = tree.sections.filter((s) => !s.lines.some((l) => l.text.trim())).map((s) => s.id);
    if (empty.length) check(await db().from("sections").delete().in("id", empty));
  }
  // a few bulk writes, not one round trip per section / line (long texts stay fast)
  const last = check(
    await db().from("sections").select("position").eq("project_id", projectId).order("position", { ascending: false }).limit(1),
  ) as { position: number }[];
  const base = last[0]?.position ?? 0;
  const secRows = check(
    await db()
      .from("sections")
      .insert(sections.map((s, i) => ({ project_id: projectId, name: s.name, group_size: s.groupSize ?? groupSize, position: base + i + 1 })))
      .select("id, position"),
  ) as { id: string; position: number }[];
  const idAt = new Map(secRows.map((r) => [r.position, r.id]));
  const lineRows = sections.flatMap((s, i) =>
    s.lines.map((text, k) => ({
      project_id: projectId,
      section_id: idAt.get(base + i + 1)!,
      position: k + 1,
      text,
      status: "SUGGESTED" as LineStatus,
      kind: "lyric",
    })),
  );
  if (lineRows.length) {
    const rows = check(await db().from("lines").insert(lineRows).select(LINE_COLS)) as Line[];
    await db().from("line_events").delete().eq("project_id", projectId).eq("undone", true);
    check(
      await db()
        .from("line_events")
        .insert(rows.map((line) => ({ project_id: projectId, line_id: line.id, action: "create", before: { deleted: true }, after: snap({ ...line, deleted: false }) }))),
    );
  }
  await touch(projectId);
}

/** Improved versions of the writer's lines: stored as options (↻), the text itself stays. */
export async function applyPolish(sectionId: string, slots: { index: number; options: string[] }[]) {
  if (!slots.length) return;
  const section = check(await db().from("sections").select("id, project_id").eq("id", sectionId).single()) as Section;
  const lyric = (
    check(await db().from("lines").select("id, kind").eq("section_id", sectionId).eq("deleted", false).order("position")) as {
      id: string;
      kind: string;
    }[]
  ).filter((l) => l.kind === "lyric");
  const rows = slots.flatMap((x) =>
    lyric[x.index] ? x.options.map((text) => ({ line_id: lyric[x.index].id, project_id: section.project_id, text, source: "ai", state: "pending" })) : [],
  );
  if (rows.length) check(await db().from("alternatives").insert(rows));
  await touch(section.project_id);
}

// ---------- performers ----------

async function projectSettings(projectId: string) {
  const p = check(await db().from("projects").select("settings").eq("id", projectId).single()) as { settings: ProjectSettings | null };
  return p.settings ?? {};
}

export async function addArtist(projectId: string, name: string, color: string) {
  const settings = await projectSettings(projectId);
  const artist = { id: crypto.randomUUID().slice(0, 8), name: name.trim().slice(0, 40) || "Artist", color };
  await updateProject(projectId, { settings: { ...settings, artists: [...(settings.artists ?? []), artist] } });
  return artist;
}

export async function updateArtist(projectId: string, id: string, patch: { name?: string; notes?: string; color?: string }) {
  const settings = await projectSettings(projectId);
  const artists = (settings.artists ?? []).map((a) =>
    a.id === id
      ? {
          ...a,
          ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 40) } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes.trim().slice(0, 200) || undefined } : {}),
          ...(patch.color ? { color: patch.color } : {}),
        }
      : a,
  );
  await updateProject(projectId, { settings: { ...settings, artists } });
}

/** removes the performer and takes them off every section */
export async function removeArtist(projectId: string, id: string) {
  const settings = await projectSettings(projectId);
  await updateProject(projectId, { settings: { ...settings, artists: (settings.artists ?? []).filter((a) => a.id !== id) } });
  const secs = check(await db().from("sections").select("id, artists").eq("project_id", projectId)) as { id: string; artists: string[] }[];
  for (const s of secs)
    if (s.artists?.includes(id)) check(await db().from("sections").update({ artists: s.artists.filter((x) => x !== id) }).eq("id", s.id));
}

// ---------- recorded takes ----------

export async function takeUploadUrl(projectId: string) {
  // top level of the project's folder: removed with the project
  const path = `${projectId}/take-${crypto.randomUUID()}.wav`;
  const { data, error } = await db().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(error?.message ?? "Could not create upload URL");
  return { path, signedUrl: data.signedUrl };
}

/** a new take becomes the chosen one of its section + layer (the latest is usually the keeper) */
export async function saveTake(
  projectId: string,
  t: { path: string; section_id: string | null; lane: string; start_at: number; duration: number; sample_rate: number; peaks: number[]; note?: string | null },
) {
  if (!t.path.startsWith(`${projectId}/take-`)) throw new Error("Invalid take path");
  // a take without a section (the whole-song flow take) is grouped by its layer alone
  let prevQ = db().from("takes").select("take_no").eq("project_id", projectId).eq("lane", t.lane);
  let unchoose = db().from("takes").update({ chosen: false }).eq("project_id", projectId).eq("lane", t.lane);
  if (t.section_id) {
    prevQ = prevQ.eq("section_id", t.section_id);
    unchoose = unchoose.eq("section_id", t.section_id);
  } else {
    prevQ = prevQ.is("section_id", null);
    unchoose = unchoose.is("section_id", null);
  }
  const prev = check(await prevQ) as { take_no: number }[];
  check(await unchoose);
  const row = check(
    await db()
      .from("takes")
      .insert({ ...t, project_id: projectId, take_no: Math.max(0, ...prev.map((x) => x.take_no)) + 1, chosen: true })
      .select("id")
      .single(),
  ) as { id: string };
  await touch(projectId);
  return row.id;
}

async function getTake(id: string) {
  const t = check(await db().from("takes").select("id, project_id, section_id, lane, path, chosen").eq("id", id).maybeSingle()) as {
    id: string;
    project_id: string;
    section_id: string | null;
    lane: string;
    path: string;
    chosen: boolean;
  } | null;
  if (!t) throw new NotFound("Take not found");
  return t;
}

export async function takeProject(id: string) {
  const t = check(await db().from("takes").select("project_id").eq("id", id).maybeSingle()) as { project_id: string } | null;
  if (!t) throw new NotFound("Take not found");
  return t.project_id;
}

export async function chooseTake(id: string) {
  const t = await getTake(id);
  let q = db().from("takes").update({ chosen: false }).eq("project_id", t.project_id).eq("lane", t.lane);
  q = t.section_id ? q.eq("section_id", t.section_id) : q.is("section_id", null);
  check(await q);
  check(await db().from("takes").update({ chosen: true }).eq("id", id));
  return t.project_id;
}

/** a take in the mix: its volume (1: as recorded; 0–4: a quiet take made louder) and its pan (−1 left … 1 right) */
export async function setTakeMix(id: string, mix: { gain?: number; pan?: number }) {
  const t = await getTake(id);
  const patch: { gain?: number; pan?: number } = {};
  if (mix.gain !== undefined) patch.gain = Math.round(Math.max(0, Math.min(4, mix.gain)) * 100) / 100;
  if (mix.pan !== undefined) patch.pan = Math.round(Math.max(-1, Math.min(1, mix.pan)) * 100) / 100;
  check(await db().from("takes").update(patch).eq("id", id));
  await touch(t.project_id);
  return t.project_id;
}

/** a take cut: only its part from `from` to `to` (seconds of the recording) plays; the recording stays whole */
export async function trimTake(id: string, from: number, to: number | null) {
  const t = check(await db().from("takes").select("project_id, duration").eq("id", id).maybeSingle()) as { project_id: string; duration: number } | null;
  if (!t) throw new NotFound("Take not found");
  const a = Math.max(0, Math.min(from, t.duration - 0.2));
  const b = to === null || to >= t.duration - 0.01 ? null : Math.max(a + 0.2, Math.min(to, t.duration));
  check(await db().from("takes").update({ trim_in: Math.round(a * 1000) / 1000, trim_out: b === null ? null : Math.round(b * 1000) / 1000 }).eq("id", id));
  await touch(t.project_id);
  return t.project_id;
}

/** a take moved on the beat (seconds, + later / − earlier): to fix its timing by ear */
export async function shiftTake(id: string, by: number) {
  const t = await getTake(id);
  const row = check(await db().from("takes").select("start_at").eq("id", id).single()) as { start_at: number };
  check(await db().from("takes").update({ start_at: Math.max(0, Math.round((row.start_at + by) * 100000) / 100000) }).eq("id", id));
  await touch(t.project_id);
  return t.project_id;
}

/** deletes the take and its file; when it was the chosen one, the latest remaining take is chosen */
export async function deleteTake(id: string) {
  const t = await getTake(id);
  check(await db().from("takes").delete().eq("id", id));
  await db().storage.from(BUCKET).remove([t.path]);
  if (t.chosen) {
    let q = db().from("takes").select("id").eq("project_id", t.project_id).eq("lane", t.lane);
    q = t.section_id ? q.eq("section_id", t.section_id) : q.is("section_id", null);
    const rest = check(await q.order("created_at", { ascending: false }).limit(1)) as { id: string }[];
    if (rest[0]) check(await db().from("takes").update({ chosen: true }).eq("id", rest[0].id));
  }
  return t.project_id;
}

/** short-lived download URLs for takes of the project */
export async function takeUrls(projectId: string, ids: string[]) {
  const rows = check(await db().from("takes").select("id, path").eq("project_id", projectId).in("id", ids.slice(0, 200))) as {
    id: string;
    path: string;
  }[];
  const out: Record<string, string> = {};
  if (!rows.length) return out;
  const { data } = await db().storage.from(BUCKET).createSignedUrls(rows.map((r) => r.path), 60 * 60);
  rows.forEach((r, i) => {
    const u = data?.[i]?.signedUrl;
    if (u) out[r.id] = u;
  });
  return out;
}

/** the sound (effect preset) of a layer, and / or the song's key for autotune */
export async function setSound(projectId: string, s: { lane?: string; preset?: string; key?: ProjectSettings["songKey"] }) {
  const settings = await projectSettings(projectId);
  const fx = { ...(settings.fx ?? {}) };
  if (s.lane && s.preset) {
    const lane = s.lane.trim().slice(0, 30);
    if (s.preset === "raw") delete fx[lane];
    else fx[lane] = s.preset;
  }
  await updateProject(projectId, { settings: { ...settings, fx, ...(s.key !== undefined ? { songKey: s.key } : {}) } });
}

export async function setLanes(projectId: string, lanes: string[]) {
  const settings = await projectSettings(projectId);
  const clean = [...new Set(lanes.map((l) => l.trim().slice(0, 30)).filter(Boolean))].slice(0, 12);
  await updateProject(projectId, { settings: { ...settings, lanes: clean.length ? clean : undefined } });
}

/**
 * Lines rewritten for a new section pattern. Drafts take the first version
 * (their old text stays as an option under ↻, the other versions too);
 * approved lines are never changed — they get the versions as options.
 * Older pending options are dropped: they were written for the old pattern.
 */
export async function applyRefit(sectionId: string, slots: { index: number; options: string[] }[]) {
  if (!slots.length) return;
  const section = check(await db().from("sections").select("id, project_id").eq("id", sectionId).single()) as Section;
  const lyric = (
    check(await db().from("lines").select("id, kind, text, status").eq("section_id", sectionId).eq("deleted", false).order("position")) as {
      id: string;
      kind: string;
      text: string;
      status: LineStatus;
    }[]
  ).filter((l) => l.kind === "lyric");
  const rows: Record<string, unknown>[] = [];
  for (const x of slots) {
    const l = lyric[x.index];
    if (!l || !x.options.length) continue;
    await db().from("alternatives").update({ state: "rejected" }).eq("line_id", l.id).eq("state", "pending");
    const locked = l.status === "APPROVED" || l.status === "APPROVED_EDITED";
    const fresh = x.options.filter((o) => o.trim() && o.trim() !== l.text.trim());
    if (locked || !fresh.length) {
      for (const text of fresh) rows.push({ line_id: l.id, project_id: section.project_id, text, source: "ai", state: "pending", instruction: "new pattern" });
      continue;
    }
    await updateLine(l.id, { text: fresh[0], status: "SUGGESTED" }, "refit");
    rows.push({ line_id: l.id, project_id: section.project_id, text: l.text, source: "user", state: "pending", instruction: "before the new pattern" });
    for (const text of fresh.slice(1)) rows.push({ line_id: l.id, project_id: section.project_id, text, source: "ai", state: "pending", instruction: "new pattern" });
  }
  if (rows.length) check(await db().from("alternatives").insert(rows));
  await touch(section.project_id);
}

/** removes every pending option of a line (they stay in its history as rejected) */
export async function clearAlternatives(lineId: string) {
  const line = await getLine(lineId);
  check(await db().from("alternatives").update({ state: "rejected" }).eq("line_id", lineId).eq("state", "pending"));
  await touch(line.project_id);
  return line.project_id;
}

// ---------- phone remote ⇄ studio ----------

export async function postRemoteCommand(projectId: string, cmd: unknown) {
  check(await db().from("studio_commands").insert({ project_id: projectId, cmd }));
  // keep the queue short: commands older than an hour are useless
  await db()
    .from("studio_commands")
    .delete()
    .eq("project_id", projectId)
    .lt("created_at", new Date(Date.now() - 3600_000).toISOString());
}

/** commands after `after` (id); after < 0 → only the latest id (to start listening from now) */
export async function remoteCommandsAfter(projectId: string, after: number) {
  if (after < 0) {
    // starting: from now on — plus what was asked in the last seconds (the page was still opening), as `recent`
    const last = check(
      await db().from("studio_commands").select("id, cmd, created_at").eq("project_id", projectId).order("id", { ascending: false }).limit(5),
    ) as { id: number; cmd: unknown; created_at: string }[];
    const recent = last.filter((r) => Date.now() - new Date(r.created_at).getTime() < 8000).reverse().map(({ id, cmd }) => ({ id, cmd }));
    return { last: last[0]?.id ?? 0, cmds: [] as { id: number; cmd: unknown }[], recent };
  }
  const rows = check(
    await db().from("studio_commands").select("id, cmd").eq("project_id", projectId).gt("id", after).order("id").limit(50),
  ) as { id: number; cmd: unknown }[];
  return { last: rows.length ? rows[rows.length - 1].id : after, cmds: rows };
}

export async function putRemoteState(projectId: string, state: unknown) {
  check(await db().from("studio_state").upsert({ project_id: projectId, state, updated_at: new Date().toISOString() }));
}

export async function getRemoteState(projectId: string) {
  const row = check(await db().from("studio_state").select("state, updated_at").eq("project_id", projectId).maybeSingle()) as {
    state: unknown;
    updated_at: string;
  } | null;
  return row ? { state: row.state, at: new Date(row.updated_at).getTime() } : null;
}

// ---------- flow: the song from the writer's sung flow ----------

/** a sung line of a flow (or of the song's vocals) with its rhythm and the words sung there */
export interface FlowLineInput {
  start: number;
  sungAt: number;
  end?: number;
  syllables: number;
  stress: number[];
  held: boolean;
  words: string;
  times?: number[];
  pair?: 0 | 1 | 2;
  /** the earlier text sung here (a part given a new flow) */
  draft?: string;
}

/** the rows of sung lines (and empty placeholder lines) for one section */
function flowRows(
  projectId: string,
  sectionId: string,
  lines: (FlowLineInput | { start: number; placeholder: true })[],
  source: "flow" | "vocals",
  step: number,
  firstPosition = 1,
) {
  const from = lines[0]?.start ?? 0;
  return lines.map((l, k) =>
    "placeholder" in l
      ? // a line to write later (no vocals here yet): no text, no rhythm until a flow is recorded for it
        { project_id: projectId, section_id: sectionId, position: firstPosition + k, text: "", status: "OPEN" as LineStatus, kind: "lyric", audio_at: l.start, flow: null }
      : {
          project_id: projectId,
          section_id: sectionId,
          position: firstPosition + k,
          // vocals from the song: the recorded words are the lyrics
          text: source === "vocals" ? (l.words ?? "").slice(0, 200) : "",
          status: (source === "vocals" && l.words?.trim() ? "SUGGESTED" : "OPEN") as LineStatus,
          kind: "lyric",
          audio_at: Math.round(Math.max(from, Math.min(l.sungAt, l.start + step)) * 1000) / 1000,
          flow: {
            syllables: l.syllables,
            stress: l.stress.slice(0, 24),
            held: !!l.held,
            words: (l.words ?? "").slice(0, 200),
            source,
            times: l.times ?? [],
            end: l.end,
            pair: l.pair,
            ...(l.draft ? { draft: l.draft.slice(0, 200) } : {}),
          } satisfies LineFlow,
        },
  );
}

/** inserts rows built by flowRows, with their "create" events (undo / history) */
async function insertFlowRows(projectId: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const inserted = check(await db().from("lines").insert(rows).select(LINE_COLS)) as Line[];
  const step = await currentStep(projectId, "create");
  await db().from("line_events").delete().eq("project_id", projectId).eq("undone", true);
  check(
    await db()
      .from("line_events")
      .insert(
        inserted.map((line) => ({ project_id: projectId, line_id: line.id, action: "create", before: { deleted: true }, after: snap({ ...line, deleted: false }), step_id: step })),
      ),
  );
}

const medianStep = (starts: number[]) => {
  const steps = starts
    .slice(1)
    .map((t, i) => t - starts[i])
    .sort((a, b) => a - b);
  return steps.length ? steps[Math.floor(steps.length / 2)] : 2;
};

/**
 * The whole song from a flow (or from the song's vocals): a version is saved
 * first, then sections + lines rebuilt. `parts` = the parts without vocals,
 * each a section of empty placeholder lines to write later.
 */
export async function buildFlowSong(
  projectId: string,
  lines: FlowLineInput[],
  source: "flow" | "vocals" = "flow",
  parts: { start: number; slots: number[] }[] = [],
) {
  const tree = await getTree(projectId);
  // the song before: a version (to restore by hand) and what undo brings back
  const label = source === "vocals" ? "Lyrics read from the song" : "New flow for the song";
  await markRebuild(projectId, await saveVersion(projectId, source === "vocals" ? "Before reading the vocals" : "Before the new flow"), label);
  if (tree.sections.length) check(await db().from("sections").delete().in("id", tree.sections.map((s) => s.id)));
  const sung = [...lines].sort((a, b) => a.start - b.start);
  const step = medianStep(sung.map((l) => l.start));
  type Item = FlowLineInput | { start: number; placeholder: true };
  const items: Item[] = [...sung, ...parts.flatMap((p) => p.slots.map((t) => ({ start: t, placeholder: true as const })))].sort((a, b) => a.start - b.start);
  // sections: a gap of more than ~2 lines without singing starts a new one (never inside a couplet), and so does every empty part
  const groups: Item[][] = [];
  for (const [i, l] of items.entries()) {
    const prev = items[i - 1];
    const empty = "placeholder" in l;
    const newPart = !prev || empty !== "placeholder" in prev || (!empty && l.start - prev.start > step * 2.6 && l.pair !== 2);
    if (newPart) groups.push([]);
    groups[groups.length - 1].push(l);
  }
  let named: { name: string; start: number; items: Item[] }[] = groups.map((g, i) => ({ name: `Part ${i + 1}`, start: g[0].start, items: g }));
  // the song's own vocals: parts as the song has them — the repeated lines are the chorus / hook, a beat
  // change splits a verse (pre-chorus), ad-libs at the start are the intro. Only names to start from:
  // parts can be renamed, split and merged.
  if (source === "vocals" && tree.audio && sung.length) {
    const asSung: SungLine[] = sung.map((l, i) => ({
      text: l.words ?? "",
      start: l.sungAt ?? l.start,
      end: l.end ?? sung[i + 1]?.start ?? l.start + step,
      syllables: l.syllables,
      pair: l.pair,
    }));
    const vocal = songSections(asSung, { ...tree.audio, duration: tree.audio.duration }, tree.project.type)
      .filter((x) => x.lines.length)
      .map((x) => ({ name: x.name, start: x.start, items: fixPairs(x.lines.map((l) => sung[asSung.indexOf(l)])) as Item[] }));
    const firstSung = sung[0].start;
    const lastSung = sung[sung.length - 1].start;
    const empty = groups
      .filter((g) => "placeholder" in g[0])
      .map((g) => ({ name: g[0].start < firstSung ? "Intro" : g[0].start > lastSung ? "Outro" : "Break", start: g[0].start, items: g }));
    named = [...vocal, ...empty].sort((a, b) => a.start - b.start);
  }
  const secRows = check(
    await db()
      .from("sections")
      .insert(named.map((g, i) => ({ project_id: projectId, name: g.name, group_size: 2, position: i + 1, audio_start: Math.round(g.start * 1000) / 1000 })))
      .select("id, position"),
  ) as { id: string; position: number }[];
  const idAt = new Map(secRows.map((r) => [r.position, r.id]));
  await insertFlowRows(
    projectId,
    named.flatMap((g, i) => flowRows(projectId, idAt.get(i + 1)!, g.items, source, step)),
  );
  await touch(projectId);
}

/**
 * One part from a flow recorded just for it (a part without vocals, or a
 * part to redo): its lines are replaced by the sung ones; the rest of the
 * song stays.
 */
export async function buildFlowPart(projectId: string, sectionId: string, lines: FlowLineInput[]) {
  const section = check(await db().from("sections").select("id, project_id").eq("id", sectionId).eq("project_id", projectId).single()) as Section;
  const old = check(
    await db().from("lines").select("id, text, audio_at, position").eq("section_id", section.id).eq("deleted", false).order("position"),
  ) as { id: string; text: string; audio_at: number | null; position: number }[];
  if (old.some((l) => l.text.trim())) await saveVersion(projectId, "Before the new flow for a part");
  for (const l of old) await deleteLine(l.id);
  const sung = [...lines].sort((a, b) => a.start - b.start);
  // the lyrics the part had: new line i rewrites old line i (spread evenly when there are more or fewer lines now)
  const written = old.filter((l) => l.text.trim());
  if (written.length) sung.forEach((l, i) => (l.draft = written[Math.min(written.length - 1, Math.floor((i * written.length) / sung.length))].text));
  const last = check(await db().from("lines").select("position").eq("section_id", section.id).order("position", { ascending: false }).limit(1)) as {
    position: number;
  }[];
  await insertFlowRows(projectId, flowRows(projectId, section.id, sung, "flow", medianStep(sung.map((l) => l.start)), (last[0]?.position ?? 0) + 1));
  await touch(projectId);
}

// ---------- song flows: patterns of 2 or 4 lines a part follows ----------

export async function createFlow(projectId: string, pattern: FlowPattern) {
  const taken = (check(await db().from("flows").select("name").eq("project_id", projectId)) as { name: string }[]).map((f) => f.name);
  const row = check(await db().from("flows").insert({ project_id: projectId, name: nextFlowName(taken), pattern }).select("id, name, pattern, created_at").single()) as SongFlow;
  await touch(projectId);
  return row;
}

export async function updateFlow(projectId: string, flowId: string, pattern: FlowPattern) {
  check(await db().from("flows").update({ pattern }).eq("id", flowId).eq("project_id", projectId));
  await touch(projectId);
}

/**
 * A part — or, from a line on, the stretch of it that follows one flow —
 * gets the flow: its lines are laid out again, one per bar (or per pattern
 * line length), each following its pattern line. The lines' earlier texts
 * become drafts to rewrite; where the flow is used first and its words were
 * written, they become the lyrics (kept). A version is saved first.
 * Returns the ids of the new lines without text (to be written).
 */
export async function applyFlow(projectId: string, flowId: string, sectionId: string, fromLineId: string | null, withText: boolean) {
  const tree = await getTree(projectId);
  const flow = tree.flows.find((f) => f.id === flowId);
  const sIdx = tree.sections.findIndex((s) => s.id === sectionId);
  const section = tree.sections[sIdx];
  if (!flow || !section) throw new NotFound("Flow or part not found");
  const audio = tree.audio;
  if (!audio?.bpm) throw new Error("The beat needs a tempo for flows.");
  const bar = ((audio.beats_per_bar ?? 4) * 60) / audio.bpm;
  const origin = audio.beat_offset ?? 0;
  const barLine = (t: number) => origin + Math.max(0, Math.round((t - origin) / bar)) * bar;
  const lyric = section.lines.filter((l) => l.kind === "lyric");
  const nextStart = tree.sections.slice(sIdx + 1).find((x) => x.audio_start !== null)?.audio_start ?? audio.duration ?? null;
  const partStart = section.audio_start ?? lyric[0]?.audio_at ?? origin;
  const partEnd = nextStart ?? partStart + 8 * bar;
  // the stretch: the whole part, or from a line to where the flow it follows changes
  const from = fromLineId ? lyric.findIndex((l) => l.id === fromLineId) : 0;
  if (from < 0) throw new NotFound("Line not found");
  let to = lyric.length;
  if (fromLineId) {
    const current = lyric[from].flow?.flowId;
    const change = lyric.findIndex((l, k) => k > from && l.flow?.flowId !== current);
    if (current && change > 0) to = change;
  }
  const start = barLine(fromLineId ? (lyric[from].audio_at ?? partStart) : partStart);
  const end = to < lyric.length ? barLine(lyric[to].audio_at ?? partEnd) : partEnd;
  const old = lyric.slice(from, to);
  // where each line starts: as far apart as the pattern's lines (sung: as sung), the pattern repeating
  const n = linesIn(flow.pattern, bar, end - start);
  const starts = lineStarts(flow.pattern, bar, n);
  if (old.some((l) => l.text.trim())) await saveVersion(projectId, `Before ${flow.name} in ${section.name}`);
  for (const l of old) await deleteLine(l.id);
  // where the flow is used for the first time, the written words are the lyrics
  const firstUse = withText && !tree.sections.some((s) => s.lines.some((l) => l.flow?.flowId === flowId && !old.includes(l)));
  // (example words that only showed a rhythm are no lyrics to rewrite)
  const lang = tree.project.language;
  const written = old.filter((l) => l.text.trim() && !isExampleText(l.text, lang));
  const rows = Array.from({ length: n }, (_, i) => {
    const pl = flow.pattern.lines[i % flow.pattern.lines.length];
    const lf = lineFlowFrom(flow.pattern, i, start + starts[i], bar, flowId);
    // the writer's own words only — example words (or "pa pam") just set the rhythm: those lines get written
    const own = firstUse && i < flow.pattern.lines.length && ownWords(pl, lang, flow.pattern.source);
    // the earlier lyrics, in order, to rewrite to the new flow
    const draft = written.length ? written[Math.min(written.length - 1, Math.floor((i * written.length) / n))].text : undefined;
    return {
      project_id: projectId,
      section_id: section.id,
      position: 0,
      text: own ? pl.text.trim() : "",
      status: (own ? "APPROVED" : "OPEN") as LineStatus,
      kind: "lyric",
      audio_at: lf.times?.[0] ?? start + starts[i],
      flow: { ...lf, ...(!own && draft ? { draft } : {}) },
    };
  });
  // positions: the stretch's place in the part (the lines after it move down)
  const before = lyric.slice(0, from);
  const after = lyric.slice(to);
  const base = (before[before.length - 1]?.position ?? 0) + 1;
  rows.forEach((r, i) => (r.position = base + i));
  for (const [k, l] of after.entries()) check(await db().from("lines").update({ position: base + n + k }).eq("id", l.id));
  await insertFlowRows(projectId, rows);
  await touch(projectId);
  const fresh = check(await db().from("lines").select("id, text, flow").eq("section_id", section.id).eq("deleted", false)) as {
    id: string;
    text: string;
    flow: LineFlow | null;
  }[];
  return fresh.filter((l) => l.flow?.flowId === flowId && !l.text.trim()).map((l) => l.id);
}

/**
 * Suggestions for lines (first = the line's text unless the writer approved
 * it; the others under ↻). Older pending options are dropped.
 */
export async function applyFlowOptions(projectId: string, items: { id: string; options: string[] }[]) {
  const ids = items.map((x) => x.id);
  if (!ids.length) return;
  const current = check(await db().from("lines").select("id, text, status, flow").eq("project_id", projectId).in("id", ids)) as {
    id: string;
    text: string;
    status: LineStatus;
    flow: LineFlow | null;
  }[];
  const byId = new Map(current.map((l) => [l.id, l]));
  check(await db().from("alternatives").update({ state: "rejected" }).in("line_id", ids).eq("state", "pending"));
  const alts: Record<string, unknown>[] = [];
  for (const x of items) {
    const l = byId.get(x.id);
    if (!l || !x.options.length) continue;
    // kept lines, and lines from the song's vocals, keep their text: the options become alternatives
    const locked = l.status === "APPROVED" || l.status === "APPROVED_EDITED" || (l.flow?.source === "vocals" && !!l.text.trim());
    const opts = x.options.filter((o) => o.trim() && o.trim() !== l.text.trim());
    // the recorded line stays one of the options when another one is showing
    const original = l.flow?.source === "vocals" ? l.flow.words.trim() : "";
    if (original && original !== l.text.trim() && !opts.includes(original)) opts.unshift(original);
    if (!locked && opts.length) await updateLine(l.id, { text: opts[0], status: "SUGGESTED" }, "flow");
    for (const text of locked ? opts : opts.slice(1)) alts.push({ line_id: l.id, project_id: projectId, text, source: "ai", state: "pending" });
  }
  if (alts.length) check(await db().from("alternatives").insert(alts));
  await touch(projectId);
}

// ---------- your settings (the profile: the same in every song, on every device) ----------

/** the writer's settings: recording, timing per kind of device, appearance… */
export async function getProfile(): Promise<Record<string, unknown>> {
  const row = check(await db().from("user_settings").select("prefs").eq("id", "me").maybeSingle()) as { prefs: Record<string, unknown> } | null;
  return row?.prefs ?? {};
}

/** changes some settings (null removes one) */
export async function updateProfile(patch: Record<string, unknown>) {
  const prefs = { ...(await getProfile()) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete prefs[k];
    else prefs[k] = v;
  }
  check(await db().from("user_settings").upsert({ id: "me", prefs, updated_at: new Date().toISOString() }));
  return prefs;
}

/** a stamp of the song's content (project_version in the database): it changes with any change to it */
export async function projectVersion(projectId: string): Promise<string> {
  const { data, error } = await db().rpc("project_version", { pid: projectId });
  if (error) throw new Error(error.message);
  return String(data ?? "");
}

// ---------- where the phone is (the Mac as main device follows it, anywhere in the app) ----------

export interface RemoteNav {
  /** the page: "/", "/song/…", "/settings" */
  path: string;
  /** in a song: its tab and part */
  view?: string | null;
  part?: string | null;
  /** when (ms) */
  at: number;
}

export async function getRemoteNav(): Promise<RemoteNav | null> {
  const row = check(await db().from("user_settings").select("prefs").eq("id", "nav").maybeSingle()) as { prefs: RemoteNav } | null;
  return row?.prefs?.path ? row.prefs : null;
}

/** what a device saw while recording a take (the microphone, the sound, what was recorded): the last 20 */
export async function addRecordingDiag(entry: Record<string, unknown>) {
  const row = check(await db().from("user_settings").select("prefs").eq("id", "diag").maybeSingle()) as { prefs: { list?: unknown[] } } | null;
  const list = [...(row?.prefs?.list ?? []), { ...entry, at: new Date().toISOString() }].slice(-20);
  check(await db().from("user_settings").upsert({ id: "diag", prefs: { list }, updated_at: new Date().toISOString() }));
}

/** the Mac, when it is the main device: is it there, and can it play sound (a browser needs one click first) */
export interface RemoteHost {
  sound: "on" | "locked";
  path: string;
  at: number;
}

export async function getRemoteHost(): Promise<RemoteHost | null> {
  const row = check(await db().from("user_settings").select("prefs").eq("id", "host").maybeSingle()) as { prefs: RemoteHost } | null;
  return row?.prefs?.sound ? row.prefs : null;
}

export async function putRemoteHost(h: Omit<RemoteHost, "at">) {
  const value: RemoteHost = { ...h, at: Date.now() };
  check(await db().from("user_settings").upsert({ id: "host", prefs: value, updated_at: new Date().toISOString() }));
  return value;
}

export async function putRemoteNav(nav: Omit<RemoteNav, "at">) {
  const value: RemoteNav = { ...nav, at: Date.now() };
  check(await db().from("user_settings").upsert({ id: "nav", prefs: value, updated_at: new Date().toISOString() }));
  return value;
}
