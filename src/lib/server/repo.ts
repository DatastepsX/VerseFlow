import "server-only";
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
  Take,
} from "@/lib/types";

const TAKE_COLS = "id, section_id, lane, take_no, start_at, duration, sample_rate, peaks, chosen, created_at";
const LINE_COLS = "id, project_id, section_id, position, text, status, kind, note, audio_at, flow, updated_at";
const SNAPSHOT_FIELDS = ["text", "status", "kind", "note", "deleted", "flow"] as const;

export class NotFound extends Error {}

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
  const [p, s, l, a, b, u, au, tk] = await Promise.all([
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
      .select("filename, duration, bpm, beat_offset, beats_per_bar, changes")
      .eq("project_id", projectId)
      .maybeSingle(),
    db().from("takes").select(TAKE_COLS).eq("project_id", projectId).order("created_at"),
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
  // a new action invalidates anything that could have been redone
  await db().from("line_events").delete().eq("project_id", projectId).eq("undone", true);
  check(await db().from("line_events").insert({ project_id: projectId, line_id: lineId, action, before, after }));
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

export async function updateLine(
  id: string,
  patch: Partial<Pick<Line, "text" | "status" | "kind" | "note" | "flow">>,
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

export async function undo(projectId: string) {
  const ev = check(
    await db()
      .from("line_events")
      .select("id, line_id, before")
      .eq("project_id", projectId)
      .eq("undone", false)
      .order("id", { ascending: false })
      .limit(1),
  ) as LineEvent[];
  if (!ev[0]) return false;
  await applySnapshot(ev[0].line_id, ev[0].before as Partial<LineSnapshot>);
  check(await db().from("line_events").update({ undone: true }).eq("id", ev[0].id));
  await touch(projectId);
  return true;
}

export async function redo(projectId: string) {
  const ev = check(
    await db()
      .from("line_events")
      .select("id, line_id, after")
      .eq("project_id", projectId)
      .eq("undone", true)
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

export async function saveVersion(projectId: string, label: string) {
  const tree = await getTree(projectId);
  const snapshot = {
    project: { title: tree.project.title, concept: tree.project.concept, settings: tree.project.settings },
    sections: tree.sections.map(({ lines, ...s }) => ({
      ...s,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      lines: lines.map(({ alternatives: _a, ...l }) => l),
    })),
  };
  check(await db().from("project_versions").insert({ project_id: projectId, label: label.trim() || "Version", snapshot }));
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
              project_id: projectId,
              section_id: sec.id,
              position: l.position,
              text: l.text,
              status: l.status,
              kind: l.kind,
              note: l.note,
              audio_at: l.audio_at ?? null,
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
  const old = check(await db().from("audio_tracks").select("path").eq("project_id", projectId).maybeSingle()) as {
    path: string;
  } | null;
  check(
    await db()
      .from("audio_tracks")
      .upsert({
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
  const old = check(await db().from("audio_tracks").select("path").eq("project_id", projectId).maybeSingle()) as {
    path: string;
  } | null;
  if (!old) return;
  await db().storage.from(BUCKET).remove([old.path]);
  check(await db().from("audio_tracks").delete().eq("project_id", projectId));
  check(await db().from("sections").update({ audio_start: null }).eq("project_id", projectId));
}

/** Short-lived URL the browser can stream the beat from. */
export async function audioPlaybackUrl(projectId: string) {
  const row = check(await db().from("audio_tracks").select("path").eq("project_id", projectId).maybeSingle()) as {
    path: string;
  } | null;
  if (!row) return null;
  const { data, error } = await db().storage.from(BUCKET).createSignedUrl(row.path, 60 * 60 * 6);
  if (error || !data) throw new Error(error?.message ?? "Could not create playback URL");
  return data.signedUrl;
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
  await saveVersion(projectId, "Before rebuilding from the vocals");
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

/** Moves every line of the section to the end of the section before it and removes the section. */
export async function mergeIntoPrevious(sectionId: string) {
  const s = check(await db().from("sections").select("project_id").eq("id", sectionId).single()) as { project_id: string };
  const tree = await getTree(s.project_id);
  const i = tree.sections.findIndex((x) => x.id === sectionId);
  if (i <= 0) throw new Error("There is no section before this one.");
  const prev = tree.sections[i - 1];
  const base = Math.max(0, ...prev.lines.map((l) => l.position));
  const moving = tree.sections[i].lines;
  for (const [k, l] of moving.entries())
    check(await db().from("lines").update({ section_id: prev.id, position: base + k + 1 }).eq("id", l.id));
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
  t: { path: string; section_id: string | null; lane: string; start_at: number; duration: number; sample_rate: number; peaks: number[] },
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

export async function chooseTake(id: string) {
  const t = await getTake(id);
  let q = db().from("takes").update({ chosen: false }).eq("project_id", t.project_id).eq("lane", t.lane);
  q = t.section_id ? q.eq("section_id", t.section_id) : q.is("section_id", null);
  check(await q);
  check(await db().from("takes").update({ chosen: true }).eq("id", id));
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
    const last = check(
      await db().from("studio_commands").select("id").eq("project_id", projectId).order("id", { ascending: false }).limit(1),
    ) as { id: number }[];
    return { last: last[0]?.id ?? 0, cmds: [] as { id: number; cmd: unknown }[] };
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
          } satisfies LineFlow,
        },
  );
}

/** inserts rows built by flowRows, with their "create" events (undo / history) */
async function insertFlowRows(projectId: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const inserted = check(await db().from("lines").insert(rows).select(LINE_COLS)) as Line[];
  await db().from("line_events").delete().eq("project_id", projectId).eq("undone", true);
  check(
    await db()
      .from("line_events")
      .insert(inserted.map((line) => ({ project_id: projectId, line_id: line.id, action: "create", before: { deleted: true }, after: snap({ ...line, deleted: false }) }))),
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
  if (tree.sections.some((s) => s.lines.some((l) => l.text.trim())))
    await saveVersion(projectId, source === "vocals" ? "Before reading the vocals" : "Before the new flow");
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
  const secRows = check(
    await db()
      .from("sections")
      .insert(groups.map((g, i) => ({ project_id: projectId, name: `Part ${i + 1}`, group_size: 2, position: i + 1, audio_start: g[0].start })))
      .select("id, position"),
  ) as { id: string; position: number }[];
  const idAt = new Map(secRows.map((r) => [r.position, r.id]));
  await insertFlowRows(
    projectId,
    groups.flatMap((g, i) => flowRows(projectId, idAt.get(i + 1)!, g, source, step)),
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
  const old = check(await db().from("lines").select("id, text").eq("section_id", section.id).eq("deleted", false)) as { id: string; text: string }[];
  if (old.some((l) => l.text.trim())) await saveVersion(projectId, "Before the new flow for a part");
  for (const l of old) await deleteLine(l.id);
  const sung = [...lines].sort((a, b) => a.start - b.start);
  const last = check(await db().from("lines").select("position").eq("section_id", section.id).order("position", { ascending: false }).limit(1)) as {
    position: number;
  }[];
  await insertFlowRows(projectId, flowRows(projectId, section.id, sung, "flow", medianStep(sung.map((l) => l.start)), (last[0]?.position ?? 0) + 1));
  await touch(projectId);
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
