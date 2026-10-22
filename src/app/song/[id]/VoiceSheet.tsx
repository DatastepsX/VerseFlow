"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { fmtTime } from "@/lib/audio/song-map";
import { BEAT_ACCEPT, MAX_BEAT_BYTES } from "@/lib/client/beat";
import type { StudioEngine } from "@/lib/studio/engine";
import { encodeWav } from "@/lib/studio/wav";

export interface VoiceInfo {
  name: string;
  created_at: string;
}

/** about a minute to read or rap: varied sounds, so the copy of the voice is complete */
const SAMPLE: Record<string, string> = {
  it: "Cammino per le strade quando scende la sera, le luci della città si accendono piano. Ho scritto mille righe su un foglio stropicciato, ma la notte mi ricorda chi sono davvero. Quando il beat parte, il cuore va più veloce: ogni parola pesa, ogni rima è un passo avanti. Non mi fermo adesso, non torno indietro, questa è la mia voce e la porto con me.",
  en: "I walk these streets when the evening comes, the city lights are slowly turning on. I wrote a thousand lines on a crumpled page, but the night reminds me who I really am. When the beat drops, my heart beats faster: every word has weight, every rhyme is a step ahead. I'm not stopping now, I'm not turning back, this is my voice and I carry it with me.",
  es: "Camino por las calles cuando cae la tarde, las luces de la ciudad se encienden despacio. Escribí mil versos en un papel arrugado, pero la noche me recuerda quién soy de verdad. Cuando entra el ritmo, el corazón va más rápido: cada palabra pesa, cada rima es un paso adelante. No me detengo ahora, no vuelvo atrás, esta es mi voz y la llevo conmigo.",
  de: "Ich laufe durch die Straßen, wenn der Abend kommt, die Lichter der Stadt gehen langsam an. Ich habe tausend Zeilen auf ein zerknittertes Blatt geschrieben, doch die Nacht erinnert mich daran, wer ich wirklich bin. Wenn der Beat einsetzt, schlägt mein Herz schneller: Jedes Wort hat Gewicht, jeder Reim ist ein Schritt nach vorn. Ich halte jetzt nicht an, ich kehre nicht um, das ist meine Stimme und ich trage sie mit mir.",
  fr: "Je marche dans les rues quand le soir tombe, les lumières de la ville s'allument doucement. J'ai écrit mille lignes sur une feuille froissée, mais la nuit me rappelle qui je suis vraiment. Quand le beat démarre, mon cœur bat plus vite : chaque mot pèse, chaque rime est un pas en avant. Je ne m'arrête pas maintenant, je ne reviens pas en arrière, c'est ma voix et je la garde avec moi.",
};

const MIN_SECONDS = 30;
const MAX_SECONDS = 180;

async function upload(blob: Blob, ext: string): Promise<string> {
  const res = await fetch("/api/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "uploadUrl", ext }) });
  const up = (await res.json()) as { path: string; signedUrl: string; error?: string };
  if (!res.ok) throw new Error(up.error ?? "Upload failed");
  const fd = new FormData();
  fd.append("cacheControl", "3600");
  fd.append("", blob, `sample.${ext}`);
  const put = await fetch(up.signedUrl, { method: "PUT", body: fd, headers: { "x-upsert": "false" } });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  return up.path;
}

/**
 * Your voice, once: record about a minute (no beat, quiet room) or upload
 * recordings of your voice alone → ElevenLabs makes a copy of it (1 call)
 * that speaks your lyrics on your flow.
 */
export function VoiceSheet({
  engine,
  lang,
  current,
  onClose,
  onDone,
}: {
  engine: RefObject<StudioEngine | null>;
  lang: string;
  current: VoiceInfo | null;
  onClose: () => void;
  onDone: (v: VoiceInfo | null) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "recording" | "ready" | "busy">("idle");
  const [secs, setSecs] = useState(0);
  const [level, setLevel] = useState(0);
  const [take, setTake] = useState<{ blob: Blob; ext: string; seconds: number; label: string }[]>([]);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const stopRef = useRef<(() => Promise<void>) | null>(null);
  const preview = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (phase !== "recording") return;
    const id = setInterval(() => {
      const e = engine.current;
      if (!e) return;
      const t = e.position();
      setSecs(t);
      setLevel(e.level());
      if (t >= MAX_SECONDS) void stopRef.current?.();
    }, 80);
    return () => clearInterval(id);
  }, [phase, engine]);

  const start = async () => {
    const e = engine.current;
    if (!e) return;
    setError(null);
    try {
      await e.arm(undefined, { voiceProcessing: false });
    } catch (err) {
      setError(err instanceof Error ? `Microphone: ${err.message}` : "The microphone is not available.");
      return;
    }
    e.play(0, { beat: null });
    e.startRecording();
    setSecs(0);
    setPhase("recording");
  };
  const stop = async () => {
    const e = engine.current;
    if (!e) return;
    const r = await e.stopRecording(0, 0, 0);
    e.disarm();
    if (!r || r.samples.length < r.sampleRate * 3) {
      setError("Nothing was recorded.");
      setPhase(take.length ? "ready" : "idle");
      return;
    }
    const wav = encodeWav([r.samples], r.sampleRate, 16);
    const seconds = r.samples.length / r.sampleRate;
    setTake([{ blob: new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }), ext: "wav", seconds, label: `Recording · ${fmtTime(seconds)}` }]);
    setPhase("ready");
  };
  useEffect(() => {
    stopRef.current = stop;
  });

  const total = take.reduce((n, t) => n + t.seconds, 0);
  const create = async () => {
    setPhase("busy");
    setError(null);
    try {
      const paths: string[] = [];
      for (const [i, t] of take.entries()) {
        setStatus(`Uploading ${i + 1}/${take.length}…`);
        paths.push(await upload(t.blob, t.ext));
      }
      setStatus("Creating your voice…");
      const res = await fetch("/api/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "clone", paths, consent }) });
      const data = (await res.json()) as { voice?: VoiceInfo | null; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Creating your voice failed");
      onDone(data.voice ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Creating your voice failed");
      setPhase("ready");
    } finally {
      setStatus(null);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={() => phase !== "recording" && phase !== "busy" && onClose()}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92dvh] w-full max-w-lg space-y-4 overflow-auto rounded-t-3xl bg-panel px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3"
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
        <h2 className="text-xl font-bold">{current ? "Your voice" : "Create your voice"}</h2>
        <p className="text-sm text-muted">
          Record about a minute of your voice — no beat, in a quiet room, phone 20 cm from your mouth. Read or rap the text below. ElevenLabs makes a copy
          of your voice that raps your lyrics on your flow.
        </p>
        {current && phase === "idle" && (
          <div className="flex items-center gap-3 rounded-2xl bg-accent-soft px-4 py-3 text-sm">
            <span className="text-xl">🗣</span>
            <span className="flex-1">
              <b>{current.name}</b> is ready · created {new Date(current.created_at).toLocaleDateString()}
            </span>
            <button
              className="text-bad"
              onClick={async () => {
                if (!window.confirm("Delete your voice? Its copy at ElevenLabs is deleted too.")) return;
                await fetch("/api/voice", { method: "DELETE" });
                onDone(null);
              }}
            >
              Delete
            </button>
          </div>
        )}

        <p className="rounded-2xl bg-panel-2 px-4 py-3 text-[15px] leading-relaxed">{SAMPLE[lang] ?? SAMPLE.en}</p>

        {phase === "recording" ? (
          <div className="flex flex-col items-center">
            <p className="font-mono text-3xl font-bold tabular-nums">{fmtTime(secs)}</p>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-panel-2">
              <div className="h-full bg-[#dc2626] transition-all" style={{ width: `${Math.min(100, level * 160)}%` }} />
            </div>
            <p className="mt-1 text-xs text-muted">{secs < MIN_SECONDS ? `Keep going — at least ${MIN_SECONDS} s, a minute is best` : "Good — stop whenever you like"}</p>
            <button className="mt-4 flex h-20 w-20 items-center justify-center rounded-full bg-[#1f1f24] text-white" onClick={() => void stop()} aria-label="Stop">
              <span className="h-7 w-7 rounded-md bg-white" />
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <button className="btn-primary flex-1 justify-center rounded-2xl py-3" disabled={phase === "busy"} onClick={() => void start()}>
              ● {take.length ? "Record again" : "Record my voice"}
            </button>
            <label className="btn flex-1 cursor-pointer justify-center rounded-2xl py-3">
              ⬆ Upload
              <input
                type="file"
                multiple
                accept={BEAT_ACCEPT}
                className="hidden"
                disabled={phase === "busy"}
                onChange={async (e) => {
                  const files = [...(e.target.files ?? [])].slice(0, 5);
                  if (!files.length) return;
                  if (files.some((f) => f.size > MAX_BEAT_BYTES)) return setError("A file is larger than 50 MB.");
                  setError(null);
                  const items = await Promise.all(
                    files.map(async (f) => {
                      // the length, for the "enough audio" check
                      const seconds = await new Promise<number>((res) => {
                        const a = new Audio(URL.createObjectURL(f));
                        a.onloadedmetadata = () => res(Number.isFinite(a.duration) ? a.duration : 60);
                        a.onerror = () => res(60);
                      });
                      return { blob: f as Blob, ext: (f.name.split(".").pop() || "mp3").toLowerCase(), seconds, label: f.name };
                    }),
                  );
                  setTake(items);
                  setPhase("ready");
                }}
              />
            </label>
          </div>
        )}
        <p className="text-xs text-muted">Upload: recordings of your voice alone (acapella, no beat), up to 5 files.</p>

        {phase !== "recording" && take.length > 0 && (
          <div className="space-y-3">
            <ul className="space-y-1 text-sm">
              {take.map((t, i) => (
                <li key={i} className="flex items-center gap-2 rounded-xl bg-panel-2 px-3 py-2">
                  <button
                    onClick={() => {
                      preview.current?.pause();
                      preview.current = new Audio(URL.createObjectURL(t.blob));
                      void preview.current.play();
                    }}
                    aria-label="Listen"
                  >
                    ▶
                  </button>
                  <span className="min-w-0 flex-1 truncate">{t.label}</span>
                </li>
              ))}
            </ul>
            {total < MIN_SECONDS && <p className="text-xs text-warn">That&apos;s {Math.round(total)} s — at least {MIN_SECONDS} s gives a usable copy of your voice.</p>}
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>This is my own voice, and I agree that ElevenLabs makes a copy of it for VerseFlow.</span>
            </label>
            <button className="btn-primary w-full justify-center rounded-2xl py-3.5 text-base" disabled={!consent || phase === "busy" || total < 10} onClick={() => void create()}>
              {phase === "busy" ? (status ?? "Working…") : `${current ? "Replace my voice" : "Create my voice"} · 1 call`}
            </button>
          </div>
        )}
        {error && <p className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}
      </div>
    </div>
  );
}
