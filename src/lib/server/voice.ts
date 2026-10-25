import "server-only";
import { createHash } from "node:crypto";
import type { ProjectTree } from "@/lib/types";
import { wordsFromAlignment, type Alignment, type SpokenWord } from "@/lib/voice/guide";
import { AiUnavailable } from "./ai";
import { check, db } from "./db";

/**
 * The writer's own voice (ElevenLabs Instant Voice Clone) speaking the
 * lyrics, for the guide vocal laid on their flow. One voice for the app
 * until user accounts exist. Spoken lines are cached by voice + model +
 * text, so a line is paid for once.
 */

const BUCKET = "beats";
const API = process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io/v1";
const TTS_MODEL = process.env.TTS_MODEL || "eleven_multilingual_v2";

export interface VoiceRow {
  id: string;
  name: string;
  voice_id: string;
  sample_paths: string[];
  created_at: string;
}

function key() {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new AiUnavailable("Voices are not configured yet (ELEVENLABS_API_KEY missing).");
  return k;
}

/** ElevenLabs errors in words the writer can act on */
async function failure(res: Response, what: string) {
  const body = (await res.json().catch(() => ({}))) as { detail?: { status?: string; message?: string } | string };
  const d = body.detail;
  const status = typeof d === "object" ? (d?.status ?? "") : "";
  const message = typeof d === "string" ? d : (d?.message ?? res.statusText);
  if (status === "missing_permissions" || /permission/i.test(message))
    return new Error(`${what}: the ElevenLabs API key needs the “Text to Speech” and “Voices” permissions (ElevenLabs → Developers → API keys).`);
  if (/instant_voice_cloning|can_not_use|subscription|plan/i.test(status + message))
    return new Error(`${what}: voice cloning needs a paid ElevenLabs plan (Starter or higher).`);
  if (res.status === 429 || /quota|credits/i.test(status + message)) return new Error(`${what}: the ElevenLabs credits are used up for now.`);
  return new Error(`${what} failed (${res.status}): ${message.slice(0, 300)}`);
}

export async function getVoice(): Promise<VoiceRow | null> {
  const rows = check(await db().from("voices").select("*").order("created_at", { ascending: false }).limit(1)) as VoiceRow[];
  return rows[0] ?? null;
}

export async function voiceUploadUrl(ext = "wav") {
  const path = `voices/sample-${crypto.randomUUID()}.${/^[a-z0-9]{2,4}$/.test(ext) ? ext : "wav"}`;
  const { data, error } = await db().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(error?.message ?? "Could not create upload URL");
  return { path, signedUrl: data.signedUrl };
}

/** 1 call: the samples (recorded or uploaded, in storage) → the writer's voice; replaces an older one */
export async function cloneVoice(paths: string[], name: string) {
  const k = key();
  const form = new FormData();
  form.append("name", name.slice(0, 80) || "My voice");
  form.append("description", "VerseFlow guide voice (the writer's own voice)");
  form.append("remove_background_noise", "true");
  for (const [i, p] of paths.entries()) {
    if (!p.startsWith("voices/")) throw new Error("Unknown sample");
    const { data, error } = await db().storage.from(BUCKET).download(p);
    if (error || !data) throw new Error(error?.message ?? "Could not read the recording");
    form.append("files", new Blob([await data.arrayBuffer()], { type: data.type || "audio/wav" }), p.split("/").pop() || `sample-${i}.wav`);
  }
  const res = await fetch(`${API}/voices/add`, { method: "POST", headers: { "xi-api-key": k }, body: form });
  if (!res.ok) throw await failure(res, "Creating your voice");
  const { voice_id } = (await res.json()) as { voice_id: string };
  const old = await getVoice();
  check(await db().from("voices").insert({ name, voice_id, sample_paths: paths }));
  await db().from("ai_calls").insert({ project_id: null, kind: "voice_clone", model: "ivc" });
  if (old) await removeVoice(old);
  return getVoice();
}

async function removeVoice(v: VoiceRow) {
  await fetch(`${API}/voices/${v.voice_id}`, { method: "DELETE", headers: { "xi-api-key": key() } }).catch(() => {});
  if (v.sample_paths.length) await db().storage.from(BUCKET).remove(v.sample_paths);
  check(await db().from("voices").delete().eq("id", v.id));
}

export async function deleteVoice() {
  const v = await getVoice();
  if (v) await removeVoice(v);
}

const cacheKey = (voiceId: string, text: string) => createHash("sha256").update(`${voiceId}|${TTS_MODEL}|${text}`).digest("hex").slice(0, 40);

export interface SpokenLine {
  lineId: string;
  url: string;
  words: SpokenWord[];
}

/** lyric lines in song order, with their neighbours (the speech flows on from them) */
function lyricLines(tree: ProjectTree) {
  return tree.sections.flatMap((s) => s.lines.filter((l) => l.kind === "lyric" && l.text.trim()));
}

/** which of the lines are already spoken in the voice (free to play) */
export async function spokenAlready(tree: ProjectTree, lineIds: string[]) {
  const v = await getVoice();
  if (!v) return [];
  const want = lyricLines(tree).filter((l) => lineIds.includes(l.id));
  const keys = new Map(want.map((l) => [cacheKey(v.voice_id, l.text.trim()), l.id]));
  if (!keys.size) return [];
  const rows = check(await db().from("tts_cache").select("key").in("key", [...keys.keys()])) as { key: string }[];
  return rows.map((r) => keys.get(r.key)!);
}

/** the lines in the writer's voice: cached ones free, the others 1 call each (3 at a time) */
export async function speakLines(tree: ProjectTree, lineIds: string[]): Promise<SpokenLine[]> {
  const v = await getVoice();
  if (!v) throw new Error("Create your voice first.");
  const k = key();
  const all = lyricLines(tree);
  const want = all.filter((l) => lineIds.includes(l.id));
  const keyOf = new Map(want.map((l) => [l.id, cacheKey(v.voice_id, l.text.trim())]));
  const cached = new Map(
    (
      (keyOf.size
        ? check(await db().from("tts_cache").select("key, path, words").in("key", [...keyOf.values()]))
        : []) as { key: string; path: string; words: SpokenWord[] }[]
    ).map((r) => [r.key, r]),
  );
  const out: SpokenLine[] = [];
  const queue = [...want];
  const worker = async () => {
    for (let l = queue.shift(); l; l = queue.shift()) {
      const ck = keyOf.get(l.id)!;
      let row = cached.get(ck);
      if (!row) {
        const i = all.indexOf(l);
        const text = l.text.trim();
        const res = await fetch(`${API}/text-to-speech/${v.voice_id}/with-timestamps?output_format=mp3_44100_128`, {
          method: "POST",
          headers: { "xi-api-key": k, "content-type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: TTS_MODEL,
            previous_text: all[i - 1]?.text.trim() || undefined,
            next_text: all[i + 1]?.text.trim() || undefined,
            voice_settings: { stability: 0.4, similarity_boost: 0.9, style: 0.3, use_speaker_boost: true },
          }),
        });
        if (!res.ok) throw await failure(res, "Speaking the line");
        const r = (await res.json()) as { audio_base64: string; alignment: Alignment | null };
        const words = r.alignment ? wordsFromAlignment(r.alignment) : [];
        const path = `tts/${ck}.mp3`;
        const up = await db().storage.from(BUCKET).upload(path, Buffer.from(r.audio_base64, "base64"), { contentType: "audio/mpeg", upsert: true });
        if (up.error) throw new Error(up.error.message);
        const duration = words.length ? words[words.length - 1].end : 0;
        check(await db().from("tts_cache").upsert({ key: ck, voice_id: v.voice_id, text, path, words, duration }));
        await db().from("ai_calls").insert({ project_id: tree.project.id, kind: "tts", model: TTS_MODEL, characters: text.length });
        row = { key: ck, path, words };
      }
      const { data, error } = await db().storage.from(BUCKET).createSignedUrl(row.path, 60 * 60);
      if (error || !data) throw new Error(error?.message ?? "Could not share the audio");
      out.push({ lineId: l.id, url: data.signedUrl, words: row.words });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

/**
 * Which ElevenLabs account the app's key belongs to: plan, credits, what the
 * plan allows, the next invoice — and what VerseFlow itself used since the
 * credits last reset. Only these fields; the key never leaves the server.
 */
export async function elevenAccount() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return { connected: false as const };
  const get = async (path: string) => {
    const res = await fetch(`${API}${path}`, { headers: { "xi-api-key": key } });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  };
  const [u, sub] = await Promise.all([get("/user"), get("/user/subscription")]);
  if (!u && !sub) return { connected: true as const, error: "ElevenLabs didn't answer (the key may not be allowed to read the account)" };
  const s = (sub ?? (u?.subscription as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  const invoice = (s.next_invoice ?? null) as Record<string, unknown> | null;
  const resets = num(s.next_character_count_reset_unix);
  // VerseFlow's own use since the credits last reset (about a month before the next reset)
  const since = new Date(resets ? (resets - 30 * 24 * 3600) * 1000 : Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const calls = check(
    await db().from("ai_calls").select("kind, audio_seconds, characters").in("kind", ["transcribe", "transcribe_flow", "align", "tts", "stems", "voice_clone"]).gte("created_at", since),
  ) as { kind: string; audio_seconds: number | null; characters: number | null }[];
  const sum = (kinds: string[], f: (c: (typeof calls)[number]) => number) => calls.filter((c) => kinds.includes(c.kind)).reduce((n, c) => n + f(c), 0);
  return {
    connected: true as const,
    name: str(u?.first_name),
    email: str(u?.email),
    userId: str(u?.user_id) ? `…${(u!.user_id as string).slice(-6)}` : null,
    plan: str(s.tier),
    status: str(s.status),
    billing: str(s.billing_period),
    used: num(s.character_count),
    limit: num(s.character_limit),
    resets,
    voiceCloning: bool(s.can_use_instant_voice_cloning),
    voices: { used: num(s.voice_slots_used), limit: num(s.voice_limit) },
    nextInvoice: invoice ? { cents: num(invoice.amount_due_cents), at: num(invoice.next_payment_attempt_unix), currency: str(s.currency) } : null,
    app: {
      since,
      songsRead: calls.filter((c) => c.kind === "transcribe").length,
      minutesHeard: Math.round(sum(["transcribe", "transcribe_flow", "align"], (c) => c.audio_seconds ?? 0) / 60),
      linesSpoken: calls.filter((c) => c.kind === "tts").length,
      charactersSpoken: sum(["tts"], (c) => c.characters ?? 0),
      vocalsRemoved: calls.filter((c) => c.kind === "stems").length,
      takesSynced: calls.filter((c) => c.kind === "align").length,
      voicesMade: calls.filter((c) => c.kind === "voice_clone").length,
    },
  };
}
