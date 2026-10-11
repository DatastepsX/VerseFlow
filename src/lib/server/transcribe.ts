import "server-only";
import { cleanWords, type TimedWord } from "@/lib/audio/lyrics";
import { sectionRanges } from "@/lib/audio/song-map";
import { alignLines } from "@/lib/audio/timeline";
import type { ProjectTree } from "@/lib/types";
import { check, db } from "./db";
import { AiUnavailable } from "./ai";

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
