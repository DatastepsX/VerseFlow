"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { decodeAudio } from "@/lib/audio/analyze-file";
import { uploadBeat } from "@/lib/client/beat";
import { barLength, fmtTime, sectionRanges } from "@/lib/audio/song-map";
import { buildTimeline, lineStart as timelineLineStart, positionIn, type Timeline } from "@/lib/audio/timeline";
import { analyseBeat } from "@/lib/audio/structure";
import { barAt, detectTempo, snapToBar, waveformPeaks } from "@/lib/audio/tempo";
import { useWriter } from "./context";
import { LyricsDialog } from "./LyricsDialog";
import { TapSync } from "./TapSync";

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
  /** where a line (index in section.lines) starts on the beat, if the section is on the beat */
  lineStart: (sectionId: string, index: number) => number | null;
  playSection: (sectionId: string) => void;
  /** move the playhead to a section's start without changing play/pause */
  cueSection: (sectionId: string) => void;
  /** current playhead time (read on demand, not reactive) */
  now: () => number;
  /** current time snapped to the nearest bar line */
  snappedNow: () => number;
  upload: (file: File) => Promise<void>;
  /**
   * set the tempo (null = detect) and fit the exact grid + beat changes to the song;
   * align = also move the section starts onto the beat
   */
  fitBeat: (bpm: number | null, align?: boolean) => Promise<void>;
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
  const samplesRef = useRef<{ mono: Float32Array; sampleRate: number } | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState<PlayerApi["position"]>(null);
  const [loopId, setLoop] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const loopRef = useRef(loopId);
  const treeRef = useRef(tree);
  // when each line starts on the beat: synced/tapped times, else estimated from the line lengths
  const timeline = useMemo(() => buildTimeline(tree.sections, tree.audio, w.lang), [tree.sections, tree.audio, w.lang]);
  const timelineRef = useRef<Timeline>(timeline);
  useEffect(() => {
    loopRef.current = loopId;
    treeRef.current = tree;
    timelineRef.current = timeline;
  }, [loopId, tree, timeline]);

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
        const { mono, sampleRate } = await decodeAudio(blob);
        if (cancelled) return;
        samplesRef.current = { mono, sampleRate };
        setPeaks(waveformPeaks(mono, 600));
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
        const pos = positionIn(timelineRef.current, a.currentTime);
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
    setPosition(positionIn(timelineRef.current, a.currentTime));
  }, []);
  const lineStart = useCallback((sectionId: string, index: number) => timelineLineStart(timelineRef.current, sectionId, index), []);

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

  const cueSection = useCallback(
    (sectionId: string) => {
      const tr = treeRef.current;
      const r = sectionRanges(tr.sections, tr.audio).get(sectionId);
      if (r) seek(r.start);
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
      try {
        await mutate(`/api/projects/${pid}/audio`, await uploadBeat(pid, file, setStatus));
        setStatus(null);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : "Upload failed");
      }
    },
    [mutate, pid],
  );

  const fitBeat = useCallback(
    async (bpm: number | null, align = false) => {
      const smp = samplesRef.current;
      const meta = treeRef.current.audio;
      if (!smp || !meta) {
        if (bpm) await mutate(`/api/projects/${pid}/audio`, { action: "update", bpm });
        return;
      }
      setStatus("Listening to the beat…");
      // let the status paint before the analysis blocks the main thread for a moment
      await new Promise((r) => setTimeout(r, 30));
      let approx = bpm;
      let note = "";
      if (!approx) {
        // detect; keep the writer's octave (half / double time) when it is one of the readings
        const d = detectTempo(smp.mono.subarray(0, Math.min(smp.mono.length, smp.sampleRate * 180)), smp.sampleRate).bpm;
        const cur = meta.bpm;
        const readings = [d / 2, d, d * 2];
        const same = cur ? readings.find((r) => Math.abs(r / cur - 1) <= 0.04) : undefined;
        approx = same ?? (cur ? readings.sort((a, b) => Math.abs(Math.log(a / cur)) - Math.abs(Math.log(b / cur)))[0] : d);
        if (cur && !same) note = ` Tempo ${cur} → ${Math.round(approx * 100) / 100} BPM: ${cur} doesn't match the beat of this song.`;
      }
      if (!approx) {
        setStatus("No clear beat found — enter the BPM.");
        return;
      }
      const fit = analyseBeat(smp.mono, smp.sampleRate, approx, meta.beats_per_bar || 4);
      await mutate(`/api/projects/${pid}/audio`, { action: "update", bpm: fit.bpm, beat_offset: fit.offset, changes: fit.changes });
      let moved = 0;
      if (align) {
        const res = await mutate(`/api/projects/${pid}/audio`, { action: "alignSections" });
        moved = Number(res?.headers.get("x-moved") ?? 0);
      }
      setStatus(
        `${fit.bpm} BPM · bar 1 at ${fit.offset.toFixed(2)} s · ${fit.changes.length} beat changes` +
          (align ? ` · ${moved} section${moved === 1 ? "" : "s"} moved onto the beat` : "") +
          "." +
          note,
      );
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
      lineStart,
      playSection,
      cueSection,
      now,
      snappedNow,
      upload,
      fitBeat,
      status,
    }),
    [audioMeta, src, filename, playing, position, loopId, toggle, seek, lineStart, playSection, cueSection, now, snappedNow, upload, fitBeat, status],
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
    const isField = (t: Element | null) =>
      t instanceof HTMLElement && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "checkbox"));
    // don't trust focusout alone (iOS skips it when a focused field re-renders or the keyboard
    // is dismissed): always re-check what actually has focus
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recheck = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setTyping(small() && isField(document.activeElement)), 60);
    };
    const vv = window.visualViewport;
    document.addEventListener("focusin", recheck);
    document.addEventListener("focusout", recheck);
    document.addEventListener("touchend", recheck, true);
    vv?.addEventListener("resize", recheck);
    const poll = setInterval(recheck, 1500);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener("focusin", recheck);
      document.removeEventListener("focusout", recheck);
      document.removeEventListener("touchend", recheck, true);
      vv?.removeEventListener("resize", recheck);
    };
  }, []);
  const expanded = mode === "full";
  const [bpmEdit, setBpmEdit] = useState<string | null>(null);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [tapOpen, setTapOpen] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const syncVocals = async () => {
    setSyncNote("Syncing…");
    const res = await w.mutate(`/api/projects/${w.tree.project.id}/lyrics`, { action: "sync" });
    const n = res ? Number(res.headers.get("x-synced") ?? 0) : null;
    setSyncNote(
      n === null ? null : n ? `${n} lines synced to the vocals` : "No written line was found in the vocals — use 👆 Tap along",
    );
  };
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
        {typing && (
          // while the keyboard is open: a small pill under the header so play/pause stays reachable
          <div className="fixed right-2 top-[6.25rem] z-40 flex items-center overflow-hidden rounded-full border border-line bg-panel/95 text-xs shadow-lg backdrop-blur">
            <button
              className="px-3 py-1.5"
              disabled={!p.ready}
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={p.toggle}
              onTouchEnd={(e) => {
                e.preventDefault();
                p.toggle();
              }}
              title="Play / pause"
            >
              {p.playing ? "❚❚" : "▶"}
            </button>
            <span className="border-l border-line px-2 py-1.5 font-mono tabular-nums">
              {fmtTime(time)}
              {pos ? ` · bar ${Math.max(1, pos.bar)}` : ""}
            </span>
          </div>
        )}
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
    <div aria-hidden className={`${expanded ? "h-56" : "h-14"} ${tapOpen ? "pb-20" : ""}`} />
    <div className="fixed inset-x-0 bottom-14 z-30 border-t border-line bg-panel/95 px-3 py-2 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur lg:bottom-0 lg:left-44 lg:right-[380px]">
      {tapOpen && <TapSync onClose={() => setTapOpen(false)} />}
      <div className={`flex items-center gap-2 text-sm ${expanded ? "flex-wrap" : "flex-nowrap overflow-hidden"}`}>
        <button className="btn-primary w-16 justify-center" disabled={!p.ready} onClick={p.toggle} title="Play / pause (space)">
          {p.ready ? (p.playing ? "❚❚" : "▶") : "…"}
        </button>
        <span className="whitespace-nowrap font-mono text-xs tabular-nums">
          {fmtTime(time)}
          <span className={expanded ? "" : "hidden sm:inline"}> / {fmtTime(duration)}</span>
        </span>
        {pos && (
          <span className="whitespace-nowrap rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs tabular-nums" title="bar . beat">
            bar {Math.max(1, pos.bar)}.{pos.beat}
          </span>
        )}
        {current && <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-accent">{current.name}</span>}

        <span className="ml-auto flex items-center gap-1 text-xs">
          {bpmEdit !== null ? (
            <input
              className="input w-20 py-1 text-xs"
              autoFocus
              value={bpmEdit}
              onChange={(e) => setBpmEdit(e.target.value)}
              onBlur={() => {
                const v = parseFloat(bpmEdit.replace(",", "."));
                if (v >= 30 && v <= 300) void p.fitBeat(v);
                setBpmEdit(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <button className="btn whitespace-nowrap px-2 py-1 text-xs font-semibold" title="Detected tempo — click to correct" onClick={() => setBpmEdit(String(audio.bpm ?? ""))}>
              {audio.bpm ? `${audio.bpm} BPM` : "BPM ?"}
            </button>
          )}
          {audio.bpm && expanded && (
            <>
              <button className="btn-ghost px-1 text-xs" title="Half time" onClick={() => void p.fitBeat(audio.bpm! / 2)}>
                ÷2
              </button>
              <button className="btn-ghost px-1 text-xs" title="Double time" onClick={() => void p.fitBeat(audio.bpm! * 2)}>
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
            <button
              className="btn-primary px-2 py-0.5 text-xs"
              disabled={!p.ready}
              onClick={() => void p.fitBeat(null, true)}
              title="Finds the exact tempo and bar 1 from the song, the bars where the beat changes, and moves every section start onto them"
            >
              🧲 Snap sections to the beat
            </button>
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
            <button
              className="btn px-2 py-0.5 text-xs"
              onClick={() => void syncVocals()}
              title="Find each written line in the vocals read from this song and follow them exactly (no API call)"
            >
              🎯 Sync to vocals
            </button>
            <button className="btn px-2 py-0.5 text-xs" onClick={() => setTapOpen((v) => !v)} title="Tap while the song plays each time a line starts">
              👆 Tap along
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
          {syncNote && <p className="mt-1 text-xs text-muted">{syncNote}</p>}
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
