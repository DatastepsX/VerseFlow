"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sectionArtists } from "@/lib/artists";
import { barLength, fmtTime, sectionRanges } from "@/lib/audio/song-map";
import { buildTimeline, positionIn } from "@/lib/audio/timeline";
import { StudioEngine, type PlayLayer } from "@/lib/studio/engine";
import { takeWindow } from "@/lib/studio/timing";
import { encodeWav, peaksOf } from "@/lib/studio/wav";
import type { ProjectTree, Take } from "@/lib/types";

const DEFAULT_LANES = ["Lead", "Double", "Ad-libs"];

type Status =
  | { kind: "idle" }
  | { kind: "playing"; label: string }
  | { kind: "countin"; lane: string }
  | { kind: "recording"; lane: string; take: number }
  | { kind: "saving"; lane: string }
  | { kind: "calibrating" };

function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      // restoring a saved preference from browser storage after hydration
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw !== null) setV(JSON.parse(raw) as T);
    } catch {}
  }, [key]);
  return [
    v,
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(key, JSON.stringify(nv));
      } catch {}
    },
  ];
}

/**
 * Recording studio (Mac): record takes per section on layers (Lead, Double,
 * Ad-libs…) over the beat, with count-in, latency compensation and the
 * lyrics following the beat. Takes are 24-bit WAVs that start where they
 * belong on the beat.
 */
export function Studio({ initialTree }: { initialTree: ProjectTree }) {
  const [tree, setTree] = useState(initialTree);
  const pid = tree.project.id;
  const audio = tree.audio;
  const bar = audio ? barLength(audio) : null;
  const ranges = useMemo(() => sectionRanges(tree.sections, audio), [tree.sections, audio]);
  const sections = tree.sections.filter((s) => ranges.has(s.id));
  const timeline = useMemo(() => buildTimeline(tree.sections, audio, tree.project.language), [tree.sections, audio, tree.project.language]);
  const lanes = tree.project.settings?.lanes?.length ? tree.project.settings.lanes : DEFAULT_LANES;

  const [sectionId, setSectionId] = useState<string | null>(sections[0]?.id ?? null);
  const section = tree.sections.find((s) => s.id === sectionId) ?? null;
  const range = section ? (ranges.get(section.id) ?? null) : null;

  // preferences on this Mac
  const [deviceId, setDeviceId] = usePref<string>("vf.studio.device", "");
  const [channel, setChannel] = usePref<number>("vf.studio.channel", 0);
  const [countIn, setCountIn] = usePref<number>("vf.studio.countin", 1);
  const [metronome, setMetronome] = usePref<boolean>("vf.studio.metronome", true);
  const [latencyMs, setLatencyMs] = usePref<number | null>("vf.studio.latency", null);
  const [muted, setMuted] = useState<Set<string>>(new Set());

  const engine = useRef<StudioEngine | null>(null);
  const beat = useRef<AudioBuffer | null>(null);
  const buffers = useRef(new Map<string, AudioBuffer>());
  const [armed, setArmed] = useState<string | null>(null);
  const [inputs, setInputs] = useState<{ id: string; label: string }[]>([]);
  const [beatReady, setBeatReady] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [pos, setPos] = useState<{ sectionId: string; lineIndex: number | null } | null>(null);
  const [now, setNow] = useState(0);
  const stopAt = useRef<number | null>(null);
  const recordingLane = useRef<string | null>(null);
  const [lyricSize, setLyricSize] = usePref<number>("vf.studio.size", 30);
  // phones: the setup (input, count-in, latency) folds away
  const [setupOpen, setSetupOpen] = useState(false);

  // what the hardware reports until the writer calibrates
  const [reported, setReported] = useState(0);
  const latency = (latencyMs ?? reported * 1000) / 1000;

  // the engine lives as long as the page; the beat is decoded once
  useEffect(() => {
    const e = new StudioEngine();
    engine.current = e;
    let cancelled = false;
    (async () => {
      if (!audio) return;
      try {
        const { url } = (await fetch(`/api/projects/${pid}/audio`).then((r) => r.json())) as { url: string | null };
        if (!url) return;
        const data = await fetch(url).then((r) => r.arrayBuffer());
        const buf = await e.decode(data);
        if (!cancelled) {
          beat.current = buf;
          setBeatReady(true);
        }
      } catch {
        if (!cancelled) setError("Could not load the beat.");
      }
    })();
    return () => {
      cancelled = true;
      e.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, audio?.filename]);

  const api = useCallback(
    async (path: string, body?: unknown, method?: string) => {
      const res = await fetch(path, {
        method: method ?? "POST",
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Something went wrong");
      if ((data as ProjectTree).project && (data as ProjectTree).sections) setTree(data as ProjectTree);
      return { res, data };
    },
    [],
  );

  /** decoded audio of takes (downloaded once) */
  const loadTakes = useCallback(
    async (takes: Take[]) => {
      const e = engine.current;
      if (!e) return;
      const missing = takes.filter((t) => !buffers.current.has(t.id));
      if (!missing.length) return;
      const { data } = await api(`/api/projects/${pid}/takes?ids=${missing.map((t) => t.id).join(",")}`, undefined, "GET");
      const urls = (data as { urls: Record<string, string> }).urls;
      await Promise.all(
        missing.map(async (t) => {
          const u = urls[t.id];
          if (!u) return;
          const buf = await e.decode(await fetch(u).then((r) => r.arrayBuffer()));
          buffers.current.set(t.id, buf);
        }),
      );
    },
    [api, pid],
  );

  const takesOf = (lane: string, sid = sectionId) => tree.takes.filter((t) => t.section_id === sid && t.lane === lane);

  /** chosen takes of other layers that sound in the window (for playback / while recording) */
  const layersFor = async (from: number, to: number, skipLane?: string, only?: Take) => {
    const takes = only
      ? [only]
      : tree.takes.filter((t) => t.chosen && !muted.has(t.lane) && t.lane !== skipLane && t.start_at < to && t.start_at + t.duration > from);
    await loadTakes(takes);
    return takes
      .map((t) => ({ buffer: buffers.current.get(t.id), at: t.start_at }))
      .filter((l): l is PlayLayer => !!l.buffer);
  };

  const arm = async () => {
    setError(null);
    try {
      const e = engine.current!;
      const label = await e.arm(deviceId || undefined);
      setArmed(label);
      setReported(e.reportedLatency);
      setInputs(await e.inputs());
    } catch (err) {
      setError(err instanceof Error ? `Microphone: ${err.message}` : "Microphone not available");
    }
  };

  const countInClicks = (from: number, to: number) => {
    if (!metronome || !bar || !audio?.bpm) return [];
    const beatLen = 60 / audio.bpm;
    const out: { at: number; accent: boolean }[] = [];
    for (let k = 0; from + k * beatLen < to - 0.01; k++) out.push({ at: from + k * beatLen, accent: k % (audio.beats_per_bar || 4) === 0 });
    return out;
  };

  const play = async (opts: { take?: Take; label?: string } = {}) => {
    const e = engine.current;
    if (!e || !range || !bar) return;
    await e.ctx.resume();
    const w = takeWindow(range, bar, countIn);
    const layers = await layersFor(w.from, w.to, undefined, opts.take);
    // listening to one take: with the other layers' chosen takes too
    if (opts.take) layers.push(...(await layersFor(w.from, w.to, opts.take.lane)));
    e.play(Math.max(0, w.from), { beat: beat.current, layers });
    stopAt.current = w.to;
    setStatus({ kind: "playing", label: opts.label ?? section?.name ?? "" });
  };

  const record = async (lane: string) => {
    const e = engine.current;
    if (!e || !range || !bar || !section) return;
    if (!e.armed) {
      setError("Arm the studio first (button at the top).");
      return;
    }
    setError(null);
    const w = takeWindow(range, bar, countIn);
    const layers = await layersFor(w.from, w.to, lane);
    e.play(w.from, { beat: beat.current, layers, clicks: countInClicks(w.from, range.start) });
    e.startRecording();
    recordingLane.current = lane;
    stopAt.current = w.to;
    setStatus(countIn > 0 ? { kind: "countin", lane } : { kind: "recording", lane, take: takesOf(lane).length + 1 });
  };

  const stop = async () => {
    const e = engine.current;
    if (!e) return;
    stopAt.current = null;
    const lane = recordingLane.current;
    recordingLane.current = null;
    if (!lane || !range || !bar || !section) {
      e.stop();
      setStatus({ kind: "idle" });
      setPos(null);
      return;
    }
    setStatus({ kind: "saving", lane });
    try {
      const w = takeWindow(range, bar, countIn);
      const rec = await e.stopRecording(latency, channel, w.from);
      if (!rec || rec.samples.length < rec.sampleRate * 0.3) throw new Error("Nothing was recorded.");
      const wav = encodeWav([rec.samples], rec.sampleRate, 24);
      const { data: up } = await api(`/api/projects/${pid}/takes`, { action: "uploadUrl" });
      const { path, signedUrl } = up as { path: string; signedUrl: string };
      const fd = new FormData();
      fd.append("cacheControl", "3600");
      fd.append("", new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }), "take.wav");
      const put = await fetch(signedUrl, { method: "PUT", body: fd, headers: { "x-upsert": "false" } });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      const { res } = await api(`/api/projects/${pid}/takes`, {
        action: "save",
        path,
        section_id: section.id,
        lane,
        start_at: Math.round(rec.startAt * 100000) / 100000,
        duration: rec.samples.length / rec.sampleRate,
        sample_rate: rec.sampleRate,
        peaks: peaksOf(rec.samples, 160),
      });
      // keep the recording for instant playback
      const id = res.headers.get("x-take-id");
      if (id) {
        const buf = e.ctx.createBuffer(1, rec.samples.length, rec.sampleRate);
        buf.copyToChannel(rec.samples as Float32Array<ArrayBuffer>, 0);
        buffers.current.set(id, buf);
      }
      setStatus({ kind: "idle" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Saving the take failed");
      setStatus({ kind: "idle" });
    }
    setPos(null);
  };

  const calibrate = async () => {
    const e = engine.current;
    if (!e?.armed) {
      setError("Arm the studio first.");
      return;
    }
    setError(null);
    setStatus({ kind: "calibrating" });
    try {
      const l = await e.calibrate(channel);
      if (l === null) setError("The clicks weren't heard — hold the headphones to the microphone (or turn the volume up) and try again.");
      else setLatencyMs(Math.round(l * 1000 * 10) / 10);
    } finally {
      setStatus({ kind: "idle" });
    }
  };

  // clock: playhead, lyrics follow, auto-stop, input meter
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const e = engine.current;
      if (e) {
        if (status.kind === "playing" || status.kind === "countin" || status.kind === "recording") {
          const p = e.position();
          setNow(p);
          const next = positionIn(timeline, p);
          setPos((prev) => (prev?.sectionId === next?.sectionId && prev?.lineIndex === next?.lineIndex ? prev : next));
          if (status.kind === "countin" && range && p >= range.start - 0.02)
            setStatus({ kind: "recording", lane: status.lane, take: takesOf(status.lane).length + 1 });
          if (stopAt.current !== null && p >= stopAt.current) {
            stopAt.current = null;
            void stop();
          }
        }
        if (e.armed) setLevel(e.level());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  const busy = status.kind !== "idle";
  const recording = status.kind === "recording" || status.kind === "countin";

  // keyboard: space = play / stop, R = record the first layer
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return;
      if (ev.code === "Space") {
        ev.preventDefault();
        if (busy) void stop();
        else void play();
      } else if (ev.key === "r" || ev.key === "R") {
        if (!busy) void record(lanes[0]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!audio || !bar)
    return (
      <div className="min-h-dvh bg-[#0b0b0d] p-8 text-[#e8e8e8]">
        <Link href={`/p/${pid}`} className="text-sm text-[#8b7bff]">
          ← Back
        </Link>
        <p className="mt-6">Upload the beat and set its tempo first (Write → player), then anchor the sections on it.</p>
      </div>
    );

  const lyricLines = section?.lines.filter((l) => l.kind === "lyric" && l.text.trim() && l.status !== "DECLINED") ?? [];
  const live = pos?.sectionId === section?.id ? pos?.lineIndex : null;
  const performers = section ? sectionArtists(tree, section) : [];

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#0b0b0d] text-[#e8e8e8]">
      {/* top bar: input, latency, count-in (folded on phones) */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#222] px-3 py-2 text-sm md:px-4">
        <Link href={`/p/${pid}`} className="text-[#8b7bff]">
          ←<span className="hidden md:inline"> Write</span>
        </Link>
        {/* basis-0: the title shrinks (truncates) instead of pushing the buttons onto a second row */}
        <strong className="min-w-0 shrink grow basis-0 truncate">{tree.project.title}</strong>
        <span className="shrink-0 rounded bg-[#1a1a1f] px-2 py-0.5 font-mono text-xs">
          {audio.bpm}<span className="hidden sm:inline"> BPM</span> · {fmtTime(now > 0 ? now : 0)}
        </span>
        {armed && (
          <span className="flex items-center gap-1.5 text-xs md:hidden">
            <span className="text-[#4ade80]">●</span>
            <span className="h-2 w-10 overflow-hidden rounded bg-[#222]">
              <span className="block h-full bg-[#4ade80]" style={{ width: `${Math.min(100, level * 100)}%` }} />
            </span>
          </span>
        )}
        {!armed && (
          <button className="shrink-0 rounded bg-[#e0730b] px-3 py-1 font-semibold" onClick={() => void arm()}>
            🎙 Arm<span className="hidden md:inline"> studio</span>
          </button>
        )}
        <button className="rounded bg-[#1a1a1f] px-2 py-1 md:hidden" onClick={() => setSetupOpen((o) => !o)} aria-label="Setup">
          ⚙
        </button>
        <div className={`${setupOpen ? "flex" : "hidden"} w-full flex-wrap items-center gap-2 md:flex md:w-auto`}>
        {armed && (
          <span className="flex flex-wrap items-center gap-2 text-xs">
            <span className="hidden text-[#4ade80] md:inline">● Armed</span>
            <select className="max-w-48 rounded bg-[#1a1a1f] px-1 py-0.5" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} onBlur={() => void arm()}>
              <option value="">Default input</option>
              {inputs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <select className="rounded bg-[#1a1a1f] px-1 py-0.5" value={channel} onChange={(e) => setChannel(Number(e.target.value))} title="Which input of the interface">
              <option value={0}>Input 1</option>
              <option value={1}>Input 2</option>
              <option value={-1}>1 + 2</option>
            </select>
            <span className="h-2 w-24 overflow-hidden rounded bg-[#222]" title="Input level">
              <span
                className="block h-full"
                style={{ width: `${Math.min(100, level * 100)}%`, background: level > 0.9 ? "#ef4444" : level > 0.6 ? "#f59e0b" : "#4ade80" }}
              />
            </span>
          </span>
        )}
        <label className="flex items-center gap-1 text-xs">
          Count-in
          <select className="rounded bg-[#1a1a1f] px-1 py-0.5" value={countIn} onChange={(e) => setCountIn(Number(e.target.value))}>
            {[0, 1, 2].map((n) => (
              <option key={n} value={n}>
                {n} bar{n === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={metronome} onChange={(e) => setMetronome(e.target.checked)} /> click
        </label>
        <span className="flex items-center gap-1 text-xs" title="Delay between what you hear and what is recorded — every take is shifted by it">
          Latency
          <input
            className="w-14 rounded bg-[#1a1a1f] px-1 py-0.5 text-right font-mono"
            type="number"
            step={0.5}
            value={Math.round(latency * 1000 * 10) / 10}
            onChange={(e) => setLatencyMs(Number(e.target.value))}
          />
          ms
          <button className="rounded bg-[#1a1a1f] px-2 py-0.5" disabled={busy} onClick={() => void calibrate()}>
            {status.kind === "calibrating" ? "Listening…" : "Calibrate"}
          </button>
        </span>
        </div>
      </header>
      {error && <p className="bg-[#3b1111] px-4 py-1.5 text-sm text-[#fca5a5]">{error}</p>}
      {!armed && (
        <p className="shrink-0 bg-[#1a1408] px-3 py-1.5 text-xs text-[#fbbf24] md:px-4">
          Tap “Arm” once: the browser needs a tap to use the microphone.
          <span className="hidden md:inline">
            {" "}
            Use wired headphones and your interface&apos;s direct monitoring; set the latency once with “Calibrate” (hold the headphones to the
            mic).
          </span>
        </p>
      )}

      {/* sections (phones: swipeable chips) */}
      <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-[#222] px-3 py-2 md:hidden [scrollbar-width:none]">
        {sections.map((s) => {
          const n = tree.takes.filter((t) => t.section_id === s.id).length;
          return (
            <button
              key={s.id}
              disabled={busy}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${s.id === sectionId ? "bg-[#6d4aff] text-white" : "bg-[#1a1a1f] text-[#ccc]"}`}
              onClick={() => setSectionId(s.id)}
            >
              {s.name}
              {n ? <span className="ml-1 font-normal opacity-70">{n}</span> : null}
            </button>
          );
        })}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* sections */}
        <nav className="hidden w-48 shrink-0 overflow-auto border-r border-[#222] p-2 md:block">
          {sections.length === 0 && <p className="p-2 text-xs text-[#888]">Anchor sections on the beat first (⚓ in the player).</p>}
          {sections.map((s) => {
            const r = ranges.get(s.id)!;
            const n = tree.takes.filter((t) => t.section_id === s.id).length;
            return (
              <button
                key={s.id}
                disabled={busy}
                className={`mb-1 block w-full rounded px-2 py-1.5 text-left text-sm ${s.id === sectionId ? "bg-[#6d4aff] text-white" : "hover:bg-[#1a1a1f]"}`}
                onClick={() => setSectionId(s.id)}
              >
                <span className="font-semibold">{s.name}</span>
                <span className="block text-[11px] opacity-70">
                  {fmtTime(r.start)} · {r.bars ?? "?"} bars{n ? ` · ${n} take${n === 1 ? "" : "s"}` : ""}
                </span>
              </button>
            );
          })}
        </nav>

        <main className="flex min-w-0 flex-1 flex-col">
          {section && range ? (
            <>
              {/* transport + status */}
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#222] px-3 py-2 md:px-4">
                <h2 className="text-base font-bold uppercase tracking-widest md:text-lg">{section.name}</h2>
                {performers.map((a) => (
                  <span key={a.id} className="text-sm" style={{ color: a.color }}>
                    ● {a.name}
                  </span>
                ))}
                <span className="text-xs text-[#888]">
                  {fmtTime(range.start)}–{fmtTime(range.end)}
                </span>
                <span className="ml-auto" />
                {busy ? (
                  <button className="rounded bg-[#333] px-4 py-1.5 font-semibold" onClick={() => void stop()}>
                    ■ Stop
                  </button>
                ) : (
                  <button className="rounded bg-[#333] px-4 py-1.5 font-semibold disabled:opacity-40" disabled={!beatReady} onClick={() => void play()}>
                    ▶ Play section
                  </button>
                )}
                <StatusBadge status={status} />
              </div>

              {/* lyrics, following the beat */}
              <div className="min-h-0 flex-1 overflow-auto px-4 py-3 md:px-6 md:py-4" style={{ fontSize: `min(${lyricSize}px, 7vw)`, lineHeight: 1.3 }}>
                {lyricLines.length === 0 && <p className="text-base text-[#666]">No lyrics in this section yet.</p>}
                {lyricLines.map((l) => {
                  const k = section.lines.indexOf(l);
                  return (
                    <div key={l.id} className={`rounded px-2 transition-colors ${live === k ? "bg-[#6d4aff]/30 text-white" : live !== null && live !== undefined ? "text-[#777]" : ""}`}>
                      {l.text}
                    </div>
                  );
                })}
              </div>

              {/* layers and takes */}
              <div className="max-h-[45%] shrink-0 overflow-auto border-t border-[#222] bg-[#111114] px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-4 md:py-3">
                <div className="mb-2 flex items-center gap-2 text-xs text-[#888]">
                  <span className="font-semibold uppercase tracking-wide">Layers</span>
                  <span className="hidden md:inline">R = record {lanes[0]} · Space = play / stop</span>
                  <span className="ml-auto flex items-center gap-1">
                    lyrics
                    <button className="rounded bg-[#1a1a1f] px-1.5" onClick={() => setLyricSize(Math.max(16, lyricSize - 4))}>
                      A−
                    </button>
                    <button className="rounded bg-[#1a1a1f] px-1.5" onClick={() => setLyricSize(Math.min(72, lyricSize + 4))}>
                      A+
                    </button>
                  </span>
                </div>
                <div className="space-y-2">
                  {lanes.map((lane) => {
                    const takes = takesOf(lane);
                    const isRec = recording && status.lane === lane;
                    return (
                      <div key={lane} className="flex items-center gap-2">
                        <button
                          className={`w-24 shrink-0 rounded px-2 py-1.5 text-left text-sm font-semibold md:w-28 disabled:opacity-40 ${isRec ? "animate-pulse bg-[#dc2626] text-white" : "bg-[#2a1515] text-[#fca5a5] hover:bg-[#3b1a1a]"}`}
                          disabled={busy || !beatReady}
                          onClick={() => void record(lane)}
                          title={`Record a new ${lane} take of ${section.name}`}
                        >
                          ● {lane}
                        </button>
                        <button
                          className={`rounded px-1.5 py-1 text-xs ${muted.has(lane) ? "bg-[#333] text-[#888] line-through" : "text-[#aaa] hover:bg-[#1a1a1f]"}`}
                          title="Mute this layer in playback"
                          onClick={() =>
                            setMuted((m) => {
                              const n = new Set(m);
                              if (n.has(lane)) n.delete(lane);
                              else n.add(lane);
                              return n;
                            })
                          }
                        >
                          M
                        </button>
                        <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
                          {takes.length === 0 && <span className="self-center text-xs text-[#555]">no takes yet</span>}
                          {takes.map((t) => (
                            <TakeChip
                              key={t.id}
                              take={t}
                              disabled={busy}
                              onPlay={() => void play({ take: t, label: `${lane} take ${t.take_no}` })}
                              onChoose={() => void api(`/api/takes/${t.id}`, undefined, "PATCH").catch((e: Error) => setError(e.message))}
                              onDelete={() => {
                                if (window.confirm(`Delete ${lane} take ${t.take_no}?`))
                                  void api(`/api/takes/${t.id}`, undefined, "DELETE").catch((e: Error) => setError(e.message));
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  <LaneEditor lanes={lanes} onChange={(l) => void api(`/api/projects/${pid}`, { action: "setLanes", lanes: l })} disabled={busy} />
                </div>
              </div>
            </>
          ) : (
            <p className="p-6 text-[#888]">Choose a section.</p>
          )}
        </main>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  if (status.kind === "idle") return null;
  const text =
    status.kind === "playing"
      ? `▶ ${status.label}`
      : status.kind === "countin"
        ? `Count-in… ${status.lane}`
        : status.kind === "recording"
          ? `● REC ${status.lane} · take ${status.take}`
          : status.kind === "saving"
            ? `Saving ${status.lane} take…`
            : "Calibrating…";
  const red = status.kind === "recording" || status.kind === "countin";
  return <span className={`rounded px-2 py-1 text-sm font-semibold ${red ? "bg-[#dc2626] text-white" : "bg-[#1a1a1f] text-[#ccc]"}`}>{text}</span>;
}

function TakeChip({ take, disabled, onPlay, onChoose, onDelete }: { take: Take; disabled: boolean; onPlay: () => void; onChoose: () => void; onDelete: () => void }) {
  return (
    <div className={`flex shrink-0 items-center gap-1 rounded border px-1.5 py-1 ${take.chosen ? "border-[#6d4aff] bg-[#6d4aff]/15" : "border-[#2a2a30]"}`}>
      <button className="text-xs disabled:opacity-40" disabled={disabled} onClick={onPlay} title="Play with the beat">
        ▶
      </button>
      <span className="text-xs font-semibold">{take.take_no}</span>
      <svg width="64" height="18" viewBox="0 0 64 18" className="text-[#8b7bff]" aria-hidden>
        {(take.peaks ?? []).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 32)) === 0).slice(0, 32).map((p, i) => (
          <rect key={i} x={i * 2} y={9 - p * 8} width={1.2} height={Math.max(0.5, p * 16)} fill="currentColor" />
        ))}
      </svg>
      <button
        className={`text-xs ${take.chosen ? "text-[#facc15]" : "text-[#666] hover:text-[#facc15]"}`}
        onClick={onChoose}
        title={take.chosen ? "Chosen take (used in playback and exports)" : "Use this take"}
      >
        ★
      </button>
      <button className="text-xs text-[#666] hover:text-[#ef4444]" onClick={onDelete} title="Delete take">
        ✕
      </button>
    </div>
  );
}

function LaneEditor({ lanes, onChange, disabled }: { lanes: string[]; onChange: (l: string[]) => void; disabled: boolean }) {
  const [name, setName] = useState("");
  return (
    <div className="flex items-center gap-1.5 pt-1 text-xs">
      <input
        className="w-36 rounded bg-[#1a1a1f] px-2 py-1"
        placeholder="New layer (e.g. Harmony)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) {
            onChange([...lanes, name.trim()]);
            setName("");
          }
        }}
      />
      <button
        className="rounded bg-[#1a1a1f] px-2 py-1 disabled:opacity-40"
        disabled={disabled || !name.trim()}
        onClick={() => {
          onChange([...lanes, name.trim()]);
          setName("");
        }}
      >
        + Layer
      </button>
    </div>
  );
}
