import "server-only";
import { check, db } from "./db";
import type {
  AiUsage,
  Alternative,
  AudioTrack,
  BankLine,
  Line,
  LineEvent,
  LineKind,
  LineStatus,
  Project,
  ProjectSettings,
  ProjectTree,
  ProjectType,
  ProjectVersion,
  Section,
} from "@/lib/types";

const LINE_COLS = "id, project_id, section_id, position, text, status, kind, note, updated_at";
const SNAPSHOT_FIELDS = ["text", "status", "kind", "note", "deleted"] as const;

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
  const [p, s, l, a, b, u, au] = await Promise.all([
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
      .select("filename, duration, bpm, beat_offset, beats_per_bar")
      .eq("project_id", projectId)
      .maybeSingle(),
  ]);
  const project = check(p) as Project | null;
  if (!project) throw new NotFound("Project not found");
  const sections = check(s) as Section[];
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
  check(
    await db()
      .from("sections")
      .insert({
        project_id: projectId,
        name: input.name.trim() || "New section",
        group_size: input.group_size ?? 2,
        audio_start: input.audio_start ?? null,
        position: (last[0]?.position ?? 0) + 1,
      }),
  );
  await touch(projectId);
}

export async function updateSection(
  id: string,
  patch: Partial<
    Pick<Section, "name" | "group_size" | "story_beat" | "intensity" | "rhyme_scheme" | "notes" | "audio_start" | "bars_per_line">
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
  const sec = check(await db().from("sections").select("id, project_id, position").eq("id", id).single()) as Section;
  const all = check(
    await db().from("sections").select("id, position").eq("project_id", sec.project_id).order("position"),
  ) as Section[];
  const i = all.findIndex((x) => x.id === id);
  const j = i + dir;
  if (j < 0 || j >= all.length) return sec.project_id;
  await Promise.all([
    db().from("sections").update({ position: all[j].position }).eq("id", all[i].id),
    db().from("sections").update({ position: all[i].position }).eq("id", all[j].id),
  ]);
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

export async function updateLine(
  id: string,
  patch: Partial<Pick<Line, "text" | "status" | "kind" | "note">>,
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
  t: { path: string; filename: string; duration: number | null; bpm: number | null; beat_offset: number },
) {
  if (!t.path.startsWith(`${projectId}/`)) throw new Error("Invalid audio path");
  const old = check(await db().from("audio_tracks").select("path").eq("project_id", projectId).maybeSingle()) as {
    path: string;
  } | null;
  check(
    await db()
      .from("audio_tracks")
      .upsert({ project_id: projectId, path: t.path, filename: t.filename, duration: t.duration, bpm: t.bpm, beat_offset: t.beat_offset }),
  );
  if (old && old.path !== t.path) await db().storage.from(BUCKET).remove([old.path]);
}

export async function updateAudio(projectId: string, patch: Partial<Pick<AudioTrack, "bpm" | "beat_offset" | "beats_per_bar">>) {
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
