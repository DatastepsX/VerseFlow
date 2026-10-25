import "server-only";
import { cleanWords, type TimedWord } from "@/lib/audio/lyrics";
import { sectionRanges } from "@/lib/audio/song-map";
import { alignLines } from "@/lib/audio/timeline";
import type { ProjectTree } from "@/lib/types";
import { check, db } from "./db";
import { AiUnavailable } from "./ai";
import { unzip } from "./unzip";
import type { Alignment } from "@/lib/flow/align";

const MODEL = "scribe_v2";

export function transcriptionConfigured() {
  return !!process.env.ELEVENLABS_API_KEY;
}

interface ScribeWord {
  text: string;
  start?: number | null;
  end?: number | null;
  type?: string;
}

/**
 * One ElevenLabs Scribe call: the service downloads the beat itself from a
 * short-lived signed storage URL, so the file never passes through Vercel.
 * The timed words are stored, so re-applying them later costs nothing.
 */
export async function transcribeBeat(projectId: string, language: string): Promise<TimedWord[]> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new AiUnavailable("Lyrics reading is not configured yet (ELEVENLABS_API_KEY missing).");
  const track = check(await db().from("audio_tracks").select("path").eq("project_id", projectId).maybeSingle()) as {
    path: string;
  } | null;
  if (!track) throw new Error("Upload a beat first.");
  const { data: signed, error } = await db().storage.from("beats").createSignedUrl(track.path, 15 * 60);
  if (error || !signed) throw new Error(error?.message ?? "Could not share the beat with the transcriber");

  const form = new FormData();
  form.append("model_id", MODEL);
  form.append("source_url", signed.signedUrl);
  form.append("timestamps_granularity", "word");
  form.append("tag_audio_events", "false");
  if (language) form.append("language_code", language);
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as {
    words?: ScribeWord[];
    language_code?: string;
    audio_duration_secs?: number | null;
    detail?: unknown;
  };
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? res.statusText);
    throw new Error(`Transcription failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const words = cleanWords(body.words ?? []);
  check(
    await db()
      .from("transcripts")
      .upsert({ project_id: projectId, audio_path: track.path, language: body.language_code ?? language, words }),
  );
  await db()
    .from("ai_calls")
    .insert({ project_id: projectId, kind: "transcribe", model: MODEL, audio_seconds: body.audio_duration_secs ?? 0 });
  return words;
}

/** The stored transcript, if it belongs to the current beat. */
export async function storedTranscript(projectId: string) {
  const [t, a] = await Promise.all([
    db().from("transcripts").select("audio_path, words, created_at").eq("project_id", projectId).maybeSingle(),
    db().from("audio_tracks").select("path").eq("project_id", projectId).maybeSingle(),
  ]);
  const row = check(t) as { audio_path: string; words: TimedWord[]; created_at: string } | null;
  const track = check(a) as { path: string } | null;
  if (!row || !track || row.audio_path !== track.path) return null;
  return { words: row.words, created_at: row.created_at };
}

/**
 * Finds every written line in the stored transcript and saves where it starts
 * (no API call). Lines that aren't sung keep their time (tapped or estimated).
 * Returns how many lines were synced.
 */
export function vocalTimes(tree: ProjectTree, words: TimedWord[]) {
  const ranges = sectionRanges(tree.sections, tree.audio);
  const times: { id: string; at: number }[] = [];
  for (const s of tree.sections) {
    const r = ranges.get(s.id);
    if (!r) continue;
    const lyric = s.lines.filter((l) => l.kind === "lyric");
    const inRange = words.filter((w) => w.start >= r.start - 1.5 && w.start < r.end + 0.5);
    const at = alignLines(
      lyric.map((l) => l.text),
      inRange,
    );
    lyric.forEach((l, k) => {
      const t = at[k];
      if (t !== null && t >= r.start - 1.5 && t < r.end) times.push({ id: l.id, at: Math.max(r.start, t) });
    });
  }
  return times;
}

/**
 * One ElevenLabs Scribe call on a recorded take (the writer's flow): the
 * words sung, with timing (seconds from the start of the take). "Na-na"
 * parts come back as filler or nothing. Not stored — the flow lines keep
 * what matters.
 */
export async function transcribeTake(projectId: string, takeId: string, language: string): Promise<TimedWord[]> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new AiUnavailable("Word recognition is not configured yet (ELEVENLABS_API_KEY missing).");
  const take = check(await db().from("takes").select("path").eq("id", takeId).eq("project_id", projectId).maybeSingle()) as {
    path: string;
  } | null;
  if (!take) throw new Error("Take not found");
  const { data: signed, error } = await db().storage.from("beats").createSignedUrl(take.path, 15 * 60);
  if (error || !signed) throw new Error(error?.message ?? "Could not share the recording with the transcriber");
  const form = new FormData();
  form.append("model_id", MODEL);
  form.append("source_url", signed.signedUrl);
  form.append("timestamps_granularity", "word");
  form.append("tag_audio_events", "false");
  if (language) form.append("language_code", language);
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: form });
  const body = (await res.json().catch(() => ({}))) as { words?: ScribeWord[]; audio_duration_secs?: number | null; detail?: unknown };
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? res.statusText);
    throw new Error(`Word recognition failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  await db()
    .from("ai_calls")
    .insert({ project_id: projectId, kind: "transcribe_flow", model: MODEL, audio_seconds: body.audio_duration_secs ?? 0 });
  return cleanWords(body.words ?? []);
}

/**
 * A take of written lyrics, aligned (1 ElevenLabs forced-alignment call): the
 * recording + the text → when each character and word is sung, relative to
 * the take's start.
 */
export async function alignTake(projectId: string, takeId: string, text: string): Promise<{ alignment: Alignment; startAt: number }> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new AiUnavailable("Word alignment is not configured yet (ELEVENLABS_API_KEY missing).");
  const take = check(await db().from("takes").select("path, start_at, duration").eq("id", takeId).eq("project_id", projectId).maybeSingle()) as {
    path: string;
    start_at: number;
    duration: number;
  } | null;
  if (!take) throw new Error("Take not found");
  const { data: audio, error } = await db().storage.from("beats").download(take.path);
  if (error || !audio) throw new Error(error?.message ?? "Could not read the recording");
  const form = new FormData();
  form.append("file", audio, take.path.split("/").pop() || "take.wav");
  form.append("text", text);
  const res = await fetch(`${process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io/v1"}/forced-alignment`, {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as Alignment & { detail?: unknown };
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? res.statusText);
    throw new Error(`Word alignment failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  await db().from("ai_calls").insert({ project_id: projectId, kind: "align", model: "forced_alignment", audio_seconds: take.duration });
  return { alignment: body, startAt: take.start_at };
}

/**
 * The song split in two (1 ElevenLabs stem-separation call): its vocals and
 * the music without them. Both are stored next to the song, which stays as
 * uploaded; playing, recording and flows can then use the music alone.
 */
export async function separateVocals(projectId: string) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new AiUnavailable("Vocal removal is not configured yet (ELEVENLABS_API_KEY missing).");
  const track = check(await db().from("audio_tracks").select("path, filename, duration").eq("project_id", projectId).maybeSingle()) as {
    path: string;
    filename: string;
    duration: number | null;
  } | null;
  if (!track) throw new Error("Upload a song first.");
  const { data: file, error } = await db().storage.from("beats").download(track.path);
  if (error || !file) throw new Error(error?.message ?? "Could not read the song");
  const form = new FormData();
  form.append("file", file, track.filename || "song.mp3");
  form.append("stem_variation_id", "two_stems_v1");
  const res = await fetch(`${process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io/v1"}/music/stem-separation?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
    const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? res.statusText);
    throw new Error(`Vocal removal failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const stems = unzip(Buffer.from(await res.arrayBuffer())).filter((f) => /\.(mp3|wav|m4a|ogg|opus|flac)$/i.test(f.name));
  const vocals = stems.find((f) => /vocal/i.test(f.name) && !/no[_\s-]?vocal|instrumental|accompan/i.test(f.name));
  const music = stems.filter((f) => f !== vocals);
  if (!vocals || !music.length) throw new Error(`Unexpected stems: ${stems.map((f) => f.name).join(", ") || "none"}`);
  // one instrumental: the non-vocal stem (two stems), or the first of several
  const instrumental = music.find((f) => /instrumental|accompan|no[_\s-]?vocal|music/i.test(f.name)) ?? music[0];
  const stamp = Date.now();
  const ext = (f: { name: string }) => f.name.split(".").pop()!.toLowerCase();
  const put = async (name: string, f: { name: string; data: Buffer }) => {
    const path = `${projectId}/${name}-${stamp}.${ext(f)}`;
    const up = await db().storage.from("beats").upload(path, f.data, { contentType: ext(f) === "mp3" ? "audio/mpeg" : `audio/${ext(f)}` });
    if (up.error) throw new Error(up.error.message);
    return path;
  };
  const instrumental_path = await put("instrumental", instrumental);
  const vocals_path = await put("vocals", vocals);
  const old = check(await db().from("audio_tracks").select("instrumental_path, vocals_path").eq("project_id", projectId).single()) as {
    instrumental_path: string | null;
    vocals_path: string | null;
  };
  check(await db().from("audio_tracks").update({ instrumental_path, vocals_path }).eq("project_id", projectId));
  const stale = [old.instrumental_path, old.vocals_path].filter((x): x is string => !!x);
  if (stale.length) await db().storage.from("beats").remove(stale);
  await db().from("ai_calls").insert({ project_id: projectId, kind: "stems", model: "two_stems_v1", audio_seconds: track.duration ?? 0 });
}
