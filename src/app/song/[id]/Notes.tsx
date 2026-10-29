"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Pause, Play, Trash } from "@/components/icons";
import { useAccount } from "@/lib/client/account";
import { usePref } from "@/lib/client/usePref";
import type { Line, LineNote, ProjectTree } from "@/lib/types";

/**
 * Notes on a line, for everyone working on the song: a comment, or a voice message ("rap it like this",
 * "double only the last word"). Written in Lyrics or in Record; every open device sees them (live sync).
 */

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

/** the notes of a line (for its badge) */
export const notesOf = (tree: ProjectTree, lineId: string) => (tree.notes ?? []).filter((n) => n.line_id === lineId);

/** 💬 2 — a line's notes, small (nothing when there are none, unless `always`) */
export function NotesBadge({ count, onClick, always }: { count: number; onClick: () => void; always?: boolean }) {
  if (!count && !always) return null;
  return (
    <button
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${count ? "bg-accent-soft text-accent" : "text-muted/60"}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={count ? `${count} note${count === 1 ? "" : "s"}` : "Add a note"}
    >
      💬{count ? ` ${count}` : "+"}
    </button>
  );
}

export function NotesSheet({ tree, line, setTree, onClose }: { tree: ProjectTree; line: Line; setTree: (t: ProjectTree) => void; onClose: () => void }) {
  const pid = tree.project.id;
  const notes = notesOf(tree, line.id);
  const [prefName, setName] = usePref("vf.me.name", "");
  const account = useAccount();
  // signed in: the account's name (the server takes it from the account anyway)
  const name = account?.user?.name ?? prefName;
  const mine = (n: LineNote) => !account?.user || !n.author_id || n.author_id === account.user.id;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const voice = useVoiceMemo();
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [notes.length]);

  const send = async () => {
    if (!name.trim()) return setErr("Your name first — so the others know who wrote it.");
    if (!text.trim() && !voice.blob) return;
    setBusy(true);
    setErr(null);
    try {
      let audioPath: string | null = null;
      if (voice.blob) {
        const kind = voice.blob.type.includes("mp4") ? "mp4" : "webm";
        const up = (await fetch(`/api/projects/${pid}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "uploadUrl", kind }) }).then((r) => r.json())) as {
          path?: string;
          signedUrl?: string;
          error?: string;
        };
        if (!up.path || !up.signedUrl) throw new Error(up.error ?? "Couldn't upload the voice message");
        const fd = new FormData();
        fd.append("cacheControl", "3600");
        fd.append("", new Blob([voice.blob], { type: kind === "mp4" ? "audio/mp4" : "audio/webm" }), `note.${kind}`);
        const put = await fetch(up.signedUrl, { method: "PUT", body: fd });
        if (!put.ok) throw new Error(`Upload failed (${put.status})`);
        audioPath = up.path;
      }
      const res = await fetch(`/api/projects/${pid}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lineId: line.id, text, audioPath, audioSeconds: audioPath ? voice.seconds : null, author: name }),
      });
      const t = (await res.json()) as ProjectTree & { error?: string };
      if (!res.ok) throw new Error(t.error ?? "The note couldn't be saved");
      setTree(t);
      setText("");
      voice.clear();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The note couldn't be saved");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (n: LineNote) => {
    if (!window.confirm("Delete this note?")) return;
    const res = await fetch(`/api/projects/${pid}/notes?id=${n.id}`, { method: "DELETE" });
    if (res.ok) setTree((await res.json()) as ProjectTree);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={() => !busy && onClose()}>
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-3xl bg-panel px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto mb-3 h-1.5 w-10 shrink-0 rounded-full bg-line" />
        <div className="shrink-0">
          <p className="label">Notes on the line</p>
          <p className="mt-0.5 line-clamp-2 text-[15px] font-semibold">{line.text.trim() || "(empty line)"}</p>
        </div>
        <div ref={list} className="mt-3 min-h-0 flex-1 space-y-2 overflow-auto">
          {!notes.length && <p className="py-4 text-center text-sm text-muted">No notes yet — how should it be sung or recorded? Write it, or say it.</p>}
          {notes.map((n) => (
            <div key={n.id} className="rounded-2xl bg-panel-2/70 px-3.5 py-2.5">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold">{n.author_name || "Someone"}</span>
                <span className="text-muted">{ago(n.created_at)}</span>
                {mine(n) && (
                  <button className="ml-auto text-muted" onClick={() => void remove(n)} aria-label="Delete the note">
                    <Trash className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {n.audio_path && <VoicePlayer pid={pid} noteId={n.id} seconds={n.audio_seconds} />}
              {n.text && <p className="mt-1 whitespace-pre-wrap text-sm">{n.text}</p>}
            </div>
          ))}
        </div>
        <div className="mt-3 shrink-0 space-y-2 border-t border-line/60 pt-3">
          {!name.trim() && <input className="input text-sm" placeholder="Your name (shown with your notes)" value={name} onChange={(e) => setName(e.target.value)} />}
          {voice.blob ? (
            <div className="flex items-center gap-2 rounded-2xl bg-accent-soft px-3 py-2 text-sm">
              <audio src={voice.url ?? undefined} controls className="h-8 min-w-0 flex-1" />
              <span className="font-mono text-xs text-accent">{voice.seconds.toFixed(0)} s</span>
              <button className="text-muted" onClick={voice.clear} aria-label="Remove the voice message">
                <Trash className="h-4 w-4" />
              </button>
            </div>
          ) : voice.recording ? (
            <button className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#dc2626] py-3 text-sm font-semibold text-white" onClick={voice.stop}>
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-white" /> Recording · {voice.seconds.toFixed(0)} s — tap to stop
            </button>
          ) : null}
          <div className="flex items-end gap-2">
            <textarea
              className="input min-h-11 flex-1 resize-none py-2.5 text-sm"
              rows={1}
              placeholder="A note on this line…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {!voice.blob && !voice.recording && (
              <button className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-panel-2 text-accent" onClick={() => void voice.start()} aria-label="Record a voice message">
                <Mic className="h-5 w-5" />
              </button>
            )}
            <button
              className="h-11 shrink-0 rounded-full bg-accent px-4 text-sm font-semibold text-white disabled:opacity-40"
              disabled={busy || voice.recording || (!text.trim() && !voice.blob)}
              onClick={() => void send()}
            >
              {busy ? "…" : "Send"}
            </button>
          </div>
          {voice.error && <p className="text-xs text-bad">{voice.error}</p>}
          {err && <p className="text-xs text-bad">{err}</p>}
        </div>
      </div>
    </div>
  );
}

/** a voice message: tap to play (its file is fetched when first played) */
function VoicePlayer({ pid, noteId, seconds }: { pid: string; noteId: string; seconds: number | null }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [err, setErr] = useState(false);
  useEffect(() => () => audio.current?.pause(), []);
  const toggle = async () => {
    if (playing) {
      audio.current?.pause();
      return;
    }
    try {
      if (!audio.current) {
        const r = (await fetch(`/api/projects/${pid}/notes?audio=${noteId}`).then((x) => x.json())) as { url?: string };
        if (!r.url) throw new Error();
        const a = new Audio(r.url);
        a.onended = () => setPlaying(false);
        a.onpause = () => setPlaying(false);
        a.onplay = () => setPlaying(true);
        audio.current = a;
      }
      await audio.current.play();
    } catch {
      setErr(true);
    }
  };
  return (
    <button className="mt-1.5 flex items-center gap-2 rounded-full bg-panel px-3 py-1.5 text-xs font-semibold text-accent" onClick={() => void toggle()}>
      {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      Voice message{seconds ? ` · ${Math.round(seconds)} s` : ""}
      {err && <span className="text-bad"> · couldn&apos;t play</span>}
    </button>
  );
}

/** a short voice message from the microphone (MP4 on Safari, WebM elsewhere), up to 2 minutes */
function useVoiceMemo() {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      rec.current?.stream.getTracks().forEach((t) => t.stop());
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );
  const stop = () => rec.current?.state === "recording" && rec.current.stop();
  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const parts: Blob[] = [];
      const t0 = Date.now();
      r.ondataavailable = (e) => e.data.size && parts.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timer.current) clearInterval(timer.current);
        setRecording(false);
        const b = new Blob(parts, { type: (r.mimeType || type || "audio/webm").split(";")[0] });
        setSeconds((Date.now() - t0) / 1000);
        setBlob(b);
        setUrl(URL.createObjectURL(b));
      };
      rec.current = r;
      r.start();
      setRecording(true);
      setSeconds(0);
      timer.current = setInterval(() => {
        const s = (Date.now() - t0) / 1000;
        setSeconds(s);
        if (s >= 120) stop();
      }, 250);
    } catch (e) {
      setError(e instanceof Error ? `Microphone: ${e.message}` : "The microphone is not available.");
    }
  };
  const clear = () => {
    if (url) URL.revokeObjectURL(url);
    setBlob(null);
    setUrl(null);
    setSeconds(0);
  };
  return { recording, seconds, blob, url, error, start, stop, clear };
}
