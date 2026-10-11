"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { analyzeAudio, decodeAudio } from "@/lib/audio/analyze-file";
import { barLength, fmtTime, positionAt, sectionRanges } from "@/lib/audio/song-map";
import { barAt, snapToBar, waveformPeaks } from "@/lib/audio/tempo";
import { useWriter } from "./context";
import { LyricsDialog } from "./LyricsDialog";

interface PlayerApi {
  hasAudio: boolean;
  ready: boolean;
  playing: boolean;
  /** section + written line under the playhead (updates once per line, not per frame) */
  position: { sectionId: string; lineIndex: number | null } | null;
  loopId: string | null;
  setLoop: (sectionId: string | null) => void;
  toggle: () => void;
  seek: (t: number) => void;
  playSection: (sectionId: string) => void;
  /** current playhead time (read on demand, not reactive) */
  now: () => number;
  /** current time snapped to the nearest bar line */
  snappedNow: () => number;
  upload: (file: File) => Promise<void>;
  status: string | null;
}

const PlayerContext = createContext<PlayerApi | null>(null);

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer outside PlayerProvider");
  return ctx;
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const w = useWriter();
  const { tree } = w;
  const pid = tree.project.id;
  const audioMeta = tree.audio;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState<PlayerApi["position"]>(null);
  const [loopId, setLoop] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const loopRef = useRef(loopId);
  const treeRef = useRef(tree);
  useEffect(() => {
    loopRef.current = loopId;
    treeRef.current = tree;
  }, [loopId, tree]);

  // load the stored beat once per file: one download feeds both playback and the waveform
  const filename = audioMeta?.filename;
  useEffect(() => {
    if (!filename) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        setStatus("Loading beat…");
        const { url } = (await fetch(`/api/projects/${pid}/audio`).then((r) => r.json())) as { url: string | null };
        if (!url || cancelled) return;
        const blob = await fetch(url).then((r) => r.blob());
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
        const { mono } = await decodeAudio(blob);
        if (!cancelled) setPeaks(waveformPeaks(mono, 600));
        setStatus(null);
      } catch {
        if (!cancelled) setStatus("Could not load the beat.");
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filename, pid]);

  // follow the playhead: update position only when the section/line changes; handle section loop
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      const t = treeRef.current;
      if (a && t.audio) {
        const loop = loopRef.current;
        if (loop) {
          const r = sectionRanges(t.sections, t.audio).get(loop);
          if (r && (a.currentTime >= r.end - 0.01 || a.currentTime < r.start - 0.5)) a.currentTime = r.start;
        }
        const pos = positionAt(a.currentTime, t.sections, t.audio);
        setPosition((prev) =>
          prev?.sectionId === pos?.sectionId && prev?.lineIndex === pos?.lineIndex ? prev : pos,
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }, []);

  const seek = useCallback((t: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, t);
    const tr = treeRef.current;
    setPosition(positionAt(a.currentTime, tr.sections, tr.audio));
  }, []);

  const playSection = useCallback(
    (sectionId: string) => {
      const tr = treeRef.current;
      const r = sectionRanges(tr.sections, tr.audio).get(sectionId);
      if (!r) return;
      seek(r.start);
      void audioRef.current?.play();
    },
    [seek],
  );

  const now = useCallback(() => audioRef.current?.currentTime ?? 0, []);
  const snappedNow = useCallback(() => {
    const a = treeRef.current.audio;
    const t = audioRef.current?.currentTime ?? 0;
    return a?.bpm ? Math.round(snapToBar(t, a.bpm, a.beat_offset, a.beats_per_bar) * 1000) / 1000 : Math.round(t * 1000) / 1000;
  }, []);

  const { mutate } = w;
  const upload = useCallback(
    async (file: File) => {
      if (file.size > 50 * 1024 * 1024) {
        setStatus("The file is larger than 50 MB.");
        return;
      }
      try {
        setStatus("Analysing tempo…");
        const analysis = await analyzeAudio(file);
        setStatus("Uploading…");
        const up = (await fetch(`/api/projects/${pid}/audio`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "uploadUrl", filename: file.name }),
        }).then((r) => r.json())) as { path: string; signedUrl: string; error?: string };
        if (!up.signedUrl) throw new Error(up.error ?? "Upload not possible");
        const fd = new FormData();
        fd.append("cacheControl", "3600");
        fd.append("", file);
        const put = await fetch(up.signedUrl, { method: "PUT", body: fd, headers: { "x-upsert": "false" } });
        if (!put.ok) throw new Error(`Upload failed (${put.status})`);
        await mutate(`/api/projects/${pid}/audio`, {
          action: "save",
          path: up.path,
          filename: file.name,
          duration: analysis.duration,
          bpm: analysis.tempo.bpm || null,
          beat_offset: analysis.tempo.offset,
        });
        setStatus(null);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : "Upload failed");
      }
    },
    [mutate, pid],
  );

  const api: PlayerApi = useMemo(
    () => ({
      hasAudio: !!audioMeta,
      ready: !!src && !!filename,
      playing,
      position,
      loopId,
      setLoop,
      toggle,
      seek,
      playSection,
      now,
      snappedNow,
      upload,
      status,
    }),
    [audioMeta, src, playing, position, loopId, toggle, seek, playSection, now, snappedNow, upload, status],
  );

  return (
    <PlayerContext.Provider value={api}>
      {children}
      {src && filename && (
        <audio
          ref={audioRef}
          src={src}
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}
      {audioMeta && <PlayerBar peaks={filename ? peaks : []} audioRef={audioRef} />}
    </PlayerContext.Provider>
  );
}

const REGION_COLORS = ["#6d4aff", "#e0730b", "#0e9f6e", "#d61f69", "#1c64f2", "#9f580a", "#0694a2", "#7e3af2"];

function PlayerBar({ peaks, audioRef }: { peaks: number[]; audioRef: React.RefObject<HTMLAudioElement | null> }) {
  const w = useWriter();
  const p = usePlayer();
  const audio = w.tree.audio!;
  const duration = audio.duration ?? 0;
  const [time, setTime] = useState(0);
  // full | mini (one row) | hidden (floating button); remembered per browser
  const [mode, setModeState] = useState<"full" | "mini" | "hidden">("full");
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("vf.player.mode");
    } catch {}
    const initial = saved === "full" || saved === "mini" || saved === "hidden" ? saved : window.innerWidth < 1024 ? "mini" : "full";
    // restoring a saved preference after hydration
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModeState(initial);
  }, []);
  const setMode = (m: "full" | "mini" | "hidden") => {
    setModeState(m);
    try {
      localStorage.setItem("vf.player.mode", m);
    } catch {}
  };
  // on phones the keyboard needs the space: tuck the player away while typing
  useEffect(() => {
    const small = () => window.matchMedia("(max-width: 1023px)").matches;
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "TEXTAREA" || t.tagName === "INPUT");
    const onIn = (e: FocusEvent) => small() && isField(e.target) && setTyping(true);
    const onOut = (e: FocusEvent) => isField(e.target) && setTyping(false);
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);
  const expanded = mode === "full";
  const [bpmEdit, setBpmEdit] = useState<string | null>(null);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const waveRef = useRef<HTMLDivElement>(null);

  // fine-grained clock for this bar only
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const tick = () => {
      const t = audioRef.current?.currentTime ?? 0;
      if (Math.abs(t - last) > 0.04) {
        last = t;
        setTime(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [audioRef]);

  // space bar toggles playback when not typing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      if (e.code === "Space") {
        e.preventDefault();
        p.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  const ranges = sectionRanges(w.tree.sections, audio);
  const anchored = w.tree.sections.filter((s) => ranges.has(s.id));
  const pos = barAt(time, audio.bpm ?? 0, audio.beat_offset, audio.beats_per_bar);
  const current = w.tree.sections.find((s) => {
    const r = ranges.get(s.id);
    return r && time >= r.start && time < r.end;
  });
  const update = (patch: Record<string, number | null>) => void w.mutate(`/api/projects/${w.tree.project.id}/audio`, { action: "update", ...patch });
  const pct = (t: number) => `${duration ? (t / duration) * 100 : 0}%`;

  const seekFromEvent = (clientX: number) => {
    const el = waveRef.current;
    if (!el || !duration) return;
    const r = el.getBoundingClientRect();
    p.seek(((clientX - r.left) / r.width) * duration);
  };

  const anchorSection = (sectionId: string) =>
    void w.mutate(`/api/sections/${sectionId}`, { audio_start: p.snappedNow() }, "PATCH");

  if (mode === "hidden" || typing) {
    return (
      <>
        {!typing && (
          <div className="fixed bottom-[4.5rem] right-3 z-30 flex overflow-hidden rounded-full border border-line bg-panel shadow-lg lg:bottom-4 lg:right-[396px]">
            <button className="px-3 py-2 text-sm" disabled={!p.ready} onClick={p.toggle} title="Play / pause">
              {p.playing ? "❚❚" : "▶"}
            </button>
            <button className="border-l border-line px-3 py-2 text-sm" onClick={() => setMode("mini")} title="Show the player">
              🎵 {p.playing ? fmtTime(time) : ""}
            </button>
          </div>
        )}
        {lyricsOpen && <LyricsDialog onClose={() => setLyricsOpen(false)} />}
      </>
    );
  }

  return (
    <>
    {/* reserves room at the end of the page so the fixed player never covers the last lines */}
    <div aria-hidden className={expanded ? "h-56" : "h-14"} />
    <div className="fixed inset-x-0 bottom-14 z-30 border-t border-line bg-panel/95 px-3 py-2 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur lg:bottom-0 lg:left-44 lg:right-[380px]">
      <div className={`flex items-center gap-2 text-sm ${expanded ? "flex-wrap" : "flex-nowrap overflow-hidden"}`}>
        <button className="btn-primary w-16 justify-center" disabled={!p.ready} onClick={p.toggle} title="Play / pause (space)">
          {p.ready ? (p.playing ? "❚❚" : "▶") : "…"}
        </button>
        <span className="font-mono text-xs tabular-nums">
          {fmtTime(time)} / {fmtTime(duration)}
        </span>
        {pos && (
          <span className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs tabular-nums" title="bar . beat">
            bar {Math.max(1, pos.bar)}.{pos.beat}
          </span>
        )}
        {current && <span className="truncate text-xs font-semibold uppercase tracking-wide text-accent">{current.name}</span>}

        <span className="ml-auto flex items-center gap-1 text-xs">
          {bpmEdit !== null ? (
            <input
              className="input w-20 py-1 text-xs"
              autoFocus
              value={bpmEdit}
              onChange={(e) => setBpmEdit(e.target.value)}
              onBlur={() => {
                const v = parseFloat(bpmEdit.replace(",", "."));
                if (v >= 30 && v <= 300) update({ bpm: v });
                setBpmEdit(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <button className="btn px-2 py-1 text-xs font-semibold" title="Detected tempo — click to correct" onClick={() => setBpmEdit(String(audio.bpm ?? ""))}>
              {audio.bpm ? `${audio.bpm} BPM` : "BPM ?"}
            </button>
          )}
          {audio.bpm && expanded && (
            <>
              <button className="btn-ghost px-1 text-xs" title="Half time" onClick={() => update({ bpm: Math.round((audio.bpm! / 2) * 10) / 10 })}>
                ÷2
              </button>
              <button className="btn-ghost px-1 text-xs" title="Double time" onClick={() => update({ bpm: Math.round(audio.bpm! * 2 * 10) / 10 })}>
                ×2
              </button>
              <button
                className="btn-ghost px-1 text-xs"
                title="Bar 1 starts at the current position (re-aligns the bar grid)"
                onClick={() => update({ beat_offset: Math.round(p.now() * 1000) / 1000 })}
              >
                ⌖ bar 1 here
              </button>
            </>
          )}
          <button className="btn-ghost px-1.5 text-sm" onClick={() => setMode(expanded ? "mini" : "full")} title={expanded ? "Make smaller" : "Show waveform & sections"}>
            {expanded ? "▾" : "▴"}
          </button>
          <button className="btn-ghost px-1.5 text-sm" onClick={() => setMode("hidden")} title="Hide the player">
            ✕
          </button>
        </span>
      </div>

      {expanded && (
        <>
          <div
            ref={waveRef}
            className="relative mt-2 h-14 cursor-pointer select-none overflow-hidden rounded bg-panel-2"
            onClick={(e) => seekFromEvent(e.clientX)}
          >
            {/* section regions */}
            {anchored.map((s, i) => {
              const r = ranges.get(s.id)!;
              return (
                <div
                  key={s.id}
                  className="absolute inset-y-0 border-l-2"
                  style={{ left: pct(r.start), width: pct(r.end - r.start), borderColor: REGION_COLORS[i % REGION_COLORS.length], background: `${REGION_COLORS[i % REGION_COLORS.length]}1f` }}
                >
                  <span className="absolute left-1 top-0.5 max-w-full truncate text-[10px] font-bold uppercase" style={{ color: REGION_COLORS[i % REGION_COLORS.length] }}>
                    {s.name}
                    {r.bars ? ` · ${r.bars} bars` : ""}
                  </span>
                </div>
              );
            })}
            {/* waveform */}
            <div className="absolute inset-x-0 bottom-0 top-3 flex items-center">
              {peaks.map((v, i) => (
                <div key={i} className="flex-1 bg-muted/50" style={{ height: `${Math.max(2, v * 100)}%`, opacity: duration && (i / peaks.length) * duration < time ? 1 : 0.55 }} />
              ))}
            </div>
            <div className="absolute inset-y-0 w-0.5 bg-accent" style={{ left: pct(time) }} />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted">Section starts here{audio.bpm ? " (snaps to bar)" : ""}:</span>
            {w.tree.sections.map((s) => (
              <button
                key={s.id}
                className={`btn px-2 py-0.5 text-xs ${ranges.has(s.id) ? "" : "border-dashed"}`}
                title={ranges.has(s.id) ? `Move “${s.name}” to start here` : `Anchor “${s.name}” here`}
                onClick={() => anchorSection(s.id)}
              >
                ⚓ {s.name}
              </button>
            ))}
            <button
              className="btn px-2 py-0.5 text-xs"
              onClick={() => {
                const name = window.prompt("New section starting here (e.g. Intro, Rap 1, Chorus):");
                if (name?.trim())
                  void w.mutate(`/api/projects/${w.tree.project.id}`, {
                    action: "addSection",
                    name: name.trim(),
                    group_size: w.tree.project.type === "song" || w.tree.project.type === "rap" ? 2 : 1,
                    audio_start: p.snappedNow(),
                  });
              }}
            >
              + New section here
            </button>
            <button className="btn px-2 py-0.5 text-xs" onClick={() => setLyricsOpen(true)} title="Read the vocals of this song and fill the free bars">
              🎤 Lyrics from beat
            </button>
            {p.loopId && (
              <button className="btn-ghost px-1 text-xs text-accent" onClick={() => p.setLoop(null)}>
                🔁 loop on — stop
              </button>
            )}
            <span className="ml-auto truncate text-muted" title={audio.filename}>
              {audio.filename}
            </span>
            <label className="btn-ghost cursor-pointer px-1 text-xs">
              Replace
              <input type="file" accept="audio/*" className="hidden" onChange={(e) => e.target.files?.[0] && void p.upload(e.target.files[0])} />
            </label>
            <button
              className="btn-ghost px-1 text-xs text-bad"
              onClick={() => {
                if (window.confirm("Remove the beat from this project? Section anchors are cleared too."))
                  void w.mutate(`/api/projects/${w.tree.project.id}/audio`, undefined, "DELETE");
              }}
            >
              Remove
            </button>
          </div>
          {p.status && <p className="mt-1 text-xs text-muted">{p.status}</p>}
        </>
      )}
      {barLength(audio) === null && <p className="mt-1 text-xs text-warn">No tempo detected — enter the BPM to get bars.</p>}
      {lyricsOpen && <LyricsDialog onClose={() => setLyricsOpen(false)} />}
    </div>
    </>
  );
}

/** Header button: upload a beat when the project has none yet. */
export function UploadBeatButton() {
  const p = usePlayer();
  const w = useWriter();
  if (w.tree.audio) return null;
  return (
    <label className="btn cursor-pointer" title="Upload a beat (MP3, WAV, M4A…) to detect BPM and anchor sections">
      {p.status ?? "🎵 Beat"}
      <input type="file" accept="audio/*,.mp3,.wav,.m4a" className="hidden" onChange={(e) => e.target.files?.[0] && void p.upload(e.target.files[0])} />
    </label>
  );
}
