"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtTime } from "@/lib/audio/song-map";
import { buildTimeline, positionIn } from "@/lib/audio/timeline";
import { BEAT_ACCEPT, MAX_BEAT_BYTES, uploadBeat } from "@/lib/client/beat";
import { processFlow, processVocals, type FlowStep } from "@/lib/flow/pipeline";
import { stressPattern } from "@/lib/flow/lines";
import { prosody } from "@/lib/rhyme/prosody";
import { StudioEngine } from "@/lib/studio/engine";
import { LANGUAGES, type Line, type ProjectTree } from "@/lib/types";
import { followTo } from "@/components/writer/follow";
import { download, fullText } from "@/components/writer/util";

type View = "flow" | "lyrics" | "more";
type LyricLine = Line & { alternatives: ProjectTree["sections"][number]["lines"][number]["alternatives"] };

const STEPS: { key: FlowStep; label: string }[] = [
  { key: "rhythm", label: "Finding your rhythm" },
  { key: "upload", label: "Saving your flow" },
  { key: "words", label: "Recognising your words" },
  { key: "song", label: "Laying out the song" },
  { key: "suggest", label: "Writing lyrics for every bar" },
];
const VOCAL_STEPS: { key: FlowStep; label: string }[] = [
  { key: "words", label: "Reading the lyrics from your song" },
  { key: "song", label: "Finding the flow of every line" },
  { key: "suggest", label: "Writing 3 alternatives per line" },
];

/**
 * The app: upload a beat → record your flow (sing or rap anything over it)
 * → a first version of the lyrics, written to your rhythm and your words →
 * go through it bar by bar: keep, next option, new options, edit, remove.
 */
export function SongApp({ initialTree, autoVocals = false }: { initialTree: ProjectTree; autoVocals?: boolean }) {
  const router = useRouter();
  const [tree, setTree] = useState(initialTree);
  const pid = tree.project.id;
  const lang = tree.project.language;
  const lyricLines = tree.sections.flatMap((s) => s.lines.filter((l) => l.kind === "lyric"));
  const hasLines = lyricLines.length > 0;
  const flowTake = [...tree.takes].reverse().find((t) => t.lane === "Flow" && t.chosen) ?? null;
  const [view, setView] = useState<View>(hasLines ? "lyrics" : "flow");
  const [error, setError] = useState<string | null>(null);

  const call = async (path: string, body?: unknown, method = "POST") => {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as ProjectTree & { error?: string };
    if (!res.ok) {
      setError(data.error ?? "Something went wrong");
      return null;
    }
    if (data.project && data.sections) setTree(data);
    return data;
  };

  // ---------- audio: one engine for playing and recording ----------
  const engine = useRef<StudioEngine | null>(null);
  const beat = useRef<AudioBuffer | null>(null);
  const flowBuf = useRef<{ id: string; buf: AudioBuffer } | null>(null);
  const [beatReady, setBeatReady] = useState(false);
  useEffect(() => {
    const e = new StudioEngine();
    engine.current = e;
    return () => e.close();
  }, []);
  const filename = tree.audio?.filename;
  useEffect(() => {
    if (!filename) return;
    let cancelled = false;
    (async () => {
      try {
        const { url } = (await fetch(`/api/projects/${pid}/audio`).then((r) => r.json())) as { url: string | null };
        if (!url || cancelled) return;
        const buf = await engine.current!.decode(await fetch(url).then((r) => r.arrayBuffer()));
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
    };
  }, [filename, pid]);

  const loadFlow = async () => {
    if (!flowTake || flowBuf.current?.id === flowTake.id) return;
    const r = (await fetch(`/api/projects/${pid}/takes?ids=${flowTake.id}`).then((x) => x.json())) as { urls: Record<string, string> };
    const u = r.urls?.[flowTake.id];
    if (!u) return;
    const buf = await engine.current!.decode(await fetch(u).then((x) => x.arrayBuffer()));
    flowBuf.current = { id: flowTake.id, buf };
  };

  // ---------- playback with the lyrics following ----------
  const timeline = useMemo(() => buildTimeline(tree.sections, tree.audio, lang), [tree.sections, tree.audio, lang]);
  const [playing, setPlaying] = useState(false);
  const [withFlow, setWithFlow] = useState(true);
  const [now, setNow] = useState(0);
  const [live, setLive] = useState<string | null>(null);
  const stopAt = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const e = engine.current;
      if (!e) return;
      const p = e.position();
      setNow(p);
      const pos = positionIn(timeline, p);
      const sec = pos ? tree.sections.find((s) => s.id === pos.sectionId) : null;
      const line = sec && pos?.lineIndex !== null && pos?.lineIndex !== undefined ? sec.lines[pos.lineIndex] : null;
      setLive((prev) => {
        const next = line?.id ?? null;
        if (next && next !== prev) followTo(document.getElementById(`line-${next}`));
        return next;
      });
      if ((stopAt.current !== null && p >= stopAt.current) || (tree.audio?.duration && p >= tree.audio.duration)) {
        e.stop();
        setPlaying(false);
        setLive(null);
      }
    }, 60);
    return () => clearInterval(id);
  }, [playing, timeline, tree.sections, tree.audio?.duration]);

  const play = async (from: number, until: number | null = null) => {
    const e = engine.current;
    if (!e || !beat.current) return;
    await e.ctx.resume();
    if (withFlow) await loadFlow().catch(() => {});
    const layers = withFlow && flowBuf.current && flowTake ? [{ buffer: flowBuf.current.buf, at: flowTake.start_at, gain: 0.9 }] : [];
    e.play(Math.max(0, from), { beat: beat.current, layers, beatGain: 0.8 });
    stopAt.current = until;
    setPlaying(true);
  };
  const stopPlay = () => {
    engine.current?.stop();
    setPlaying(false);
    setLive(null);
  };

  // ---------- recording the flow ----------
  const [headphones, setHeadphones] = useState(true);
  const [rec, setRec] = useState<null | "recording" | "processing">(null);
  const [source, setSource] = useState<"flow" | "vocals">("flow");
  const [level, setLevel] = useState(0);
  const [step, setStep] = useState<{ key: FlowStep; progress?: { done: number; total: number } } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const stopRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (rec !== "recording") return;
    const id = setInterval(() => {
      const e = engine.current;
      if (!e) return;
      setNow(e.position());
      setLevel(e.level());
      if (tree.audio?.duration && e.position() >= tree.audio.duration) void stopRef.current?.();
    }, 60);
    return () => clearInterval(id);
  }, [rec, tree.audio?.duration]);

  const startFlow = async () => {
    const e = engine.current;
    if (!e || !beat.current) return;
    if (hasLines && !window.confirm("Record a new flow? It replaces the current draft (kept lines are saved as a version).")) return;
    setError(null);
    setNote(null);
    try {
      await e.arm(undefined, { voiceProcessing: !headphones });
    } catch (err) {
      setError(err instanceof Error ? `Microphone: ${err.message}` : "The microphone is not available.");
      return;
    }
    stopPlay();
    e.play(0, { beat: beat.current });
    e.startRecording();
    setRec("recording");
  };

  const stopFlow = async () => {
    const e = engine.current;
    if (!e || rec !== "recording") return;
    setSource("flow");
    setRec("processing");
    const r = await e.stopRecording(e.reportedLatency, 0, 0);
    e.disarm();
    if (!r) {
      setError("Nothing was recorded.");
      setRec(null);
      return;
    }
    try {
      const out = await processFlow(pid, tree, r, (key, progress) => setStep({ key, progress }), setTree);
      setTree(out.tree);
      if (out.wordsFailed) setNote(`Your words couldn't be recognised (${out.wordsFailed}) — the lyrics follow your rhythm only.`);
      // keep the fresh recording for playback
      const buf = e.ctx.createBuffer(1, r.samples.length, r.sampleRate);
      buf.copyToChannel(r.samples as Float32Array<ArrayBuffer>, 0);
      flowBuf.current = { id: out.takeId, buf };
      setView("lyrics");
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setRec(null);
      setStep(null);
    }
  };

  useEffect(() => {
    stopRef.current = stopFlow;
  });

  // ---------- the song's own vocals ----------
  const readVocals = async () => {
    if (!tree.audio) return;
    if (hasLines && !window.confirm("Read the lyrics from the song? It replaces the current draft (a version is saved first).")) return;
    stopPlay();
    setError(null);
    setNote(null);
    setSource("vocals");
    setRec("processing");
    setView("flow");
    let latest = tree;
    try {
      latest = await processVocals(pid, tree, (key, progress) => setStep({ key, progress }), (t) => {
        latest = t;
        setTree(t);
      });
      setTree(latest);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setRec(null);
      setStep(null);
      // the lyrics are there even when the suggestions failed
      if (latest.sections.some((s) => s.lines.some((l) => l.kind === "lyric"))) setView("lyrics");
      window.scrollTo(0, 0);
    }
  };
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoVocals || autoStarted.current || hasLines || !tree.audio) return;
    autoStarted.current = true;
    router.replace(`/song/${pid}`);
    void readVocals();
  });

  // ---------- line actions ----------
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const lineAction = async (id: string, fn: () => Promise<unknown>) => {
    setBusyLine(id);
    try {
      await fn();
    } finally {
      setBusyLine(null);
    }
  };
  const missing = lyricLines.filter((l) => !l.text.trim()).map((l) => l.id);
  const kept = lyricLines.filter((l) => l.status === "APPROVED" || l.status === "APPROVED_EDITED").length;

  // ---------- screens ----------
  const total = tree.audio?.duration ?? 0;
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col bg-bg">
      {/* top bar */}
      <header className="sticky top-0 z-20 border-b border-line bg-bg/95 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
        <div className="flex items-center gap-2">
          <Link href="/" className="-ml-1 px-1 text-xl text-muted" aria-label="Back">
            ‹
          </Link>
          <h1 className="min-w-0 flex-1 truncate text-lg font-bold">{tree.project.title}</h1>
          {view === "lyrics" && hasLines && (
            <span className="shrink-0 rounded-full bg-panel-2 px-2.5 py-1 text-xs font-medium text-muted">
              ✓ {kept}/{lyricLines.length}
            </span>
          )}
        </div>
        {/* player */}
        {view === "lyrics" && tree.audio && (
          <div className="mt-2 flex items-center gap-2">
            <button
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-lg text-white disabled:opacity-40"
              disabled={!beatReady}
              onClick={() => (playing ? stopPlay() : void play(now >= total - 1 ? 0 : now))}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? "❚❚" : "▶"}
            </button>
            <div className="min-w-0 flex-1">
              <div
                className="relative h-2 cursor-pointer overflow-hidden rounded-full bg-panel-2"
                onClick={(ev) => {
                  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                  const t = ((ev.clientX - r.left) / r.width) * total;
                  setNow(t);
                  if (playing) void play(t);
                }}
              >
                <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${total ? (now / total) * 100 : 0}%` }} />
              </div>
              <div className="mt-0.5 flex justify-between font-mono text-[11px] text-muted">
                <span>{fmtTime(now)}</span>
                <span>{fmtTime(total)}</span>
              </div>
            </div>
            {flowTake && (
              <button
                className={`shrink-0 rounded-full px-2.5 py-1.5 text-xs font-semibold ${withFlow ? "bg-accent-soft text-accent" : "bg-panel-2 text-muted"}`}
                onClick={() => setWithFlow((v) => !v)}
                title="Hear your recorded flow with the beat"
              >
                🎤 {withFlow ? "on" : "off"}
              </button>
            )}
          </div>
        )}
      </header>

      {error && (
        <p className="mx-4 mt-3 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      {note && view === "lyrics" && (
        <p className="mx-4 mt-3 rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn" onClick={() => setNote(null)}>
          {note}
        </p>
      )}

      <main className="flex-1 px-4 pb-32 pt-4">
        {/* ----- FLOW ----- */}
        {view === "flow" && !tree.audio && <BeatUpload pid={pid} onDone={(t) => setTree(t)} />}
        {view === "flow" && tree.audio && (
          <div className="flex flex-col items-center text-center">
            {rec === null && (
              <>
                <h2 className="text-2xl font-extrabold">Record your flow</h2>
                <p className="mt-2 max-w-sm text-sm text-muted">
                  The beat plays from the start. Sing or rap anything over it — real words, “na-na”, anything. Your rhythm and your words become
                  the lyrics.
                </p>
                <ol className="mt-5 w-full space-y-2 text-left text-sm">
                  <li className="flex gap-3 rounded-2xl bg-panel px-4 py-3">
                    <span>🎧</span>
                    <span>Put on headphones (wired is best) so the mic only hears you.</span>
                  </li>
                  <li className="flex gap-3 rounded-2xl bg-panel px-4 py-3">
                    <span>🎤</span>
                    <span>Tap record and flow over the whole beat — stop whenever you like.</span>
                  </li>
                  <li className="flex gap-3 rounded-2xl bg-panel px-4 py-3">
                    <span>✨</span>
                    <span>
                      You get a first version of the song with 3 options for every bar.
                      <span className="block text-xs text-muted">· 1 word recognition + 1 AI call per 8 bars</span>
                    </span>
                  </li>
                </ol>
                <label className="mt-4 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={headphones} onChange={(e) => setHeadphones(e.target.checked)} />
                  I&apos;m wearing headphones
                </label>
                {!headphones && <p className="mt-1 text-xs text-warn">Without headphones the beat is filtered out of the mic as well as possible.</p>}
                <button
                  className="mt-8 flex h-28 w-28 items-center justify-center rounded-full bg-[#dc2626] text-white shadow-xl shadow-red-500/30 active:scale-95 disabled:opacity-40"
                  disabled={!beatReady}
                  onClick={() => void startFlow()}
                  aria-label="Record your flow"
                >
                  <span className="h-10 w-10 rounded-full bg-white" />
                </button>
                <p className="mt-3 text-sm font-semibold">{beatReady ? "Tap to start" : "Loading the beat…"}</p>
                <button className="mt-8 flex w-full items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3.5 text-left" onClick={() => void readVocals()}>
                  <span className="text-2xl">🎙</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">The track already has vocals?</span>
                    <span className="block text-xs text-muted">Read the lyrics and the flow from it · 1 recognition + 1 AI call per 8 lines</span>
                  </span>
                  <span className="text-muted">›</span>
                </button>
              </>
            )}
            {rec === "recording" && (
              <>
                <p className="text-sm font-semibold uppercase tracking-widest text-[#dc2626]">● Recording your flow</p>
                <p className="mt-2 font-mono text-4xl font-bold tabular-nums">{fmtTime(Math.max(0, now))}</p>
                <p className="text-sm text-muted">of {fmtTime(total)}</p>
                <div className="mt-6 h-2 w-full overflow-hidden rounded-full bg-panel-2">
                  <div className="h-full bg-[#dc2626]" style={{ width: `${total ? (Math.max(0, now) / total) * 100 : 0}%` }} />
                </div>
                <div className="mt-6 flex h-16 w-full items-end justify-center gap-1">
                  {Array.from({ length: 24 }, (_, i) => (
                    <span
                      key={i}
                      className="w-2 rounded-full bg-accent transition-all"
                      style={{ height: `${Math.max(6, Math.min(100, level * 140 * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + now * 6)))))}%` }}
                    />
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted">{level < 0.02 ? "Not hearing you yet — sing or rap!" : "Hearing you ✓"}</p>
                <button
                  className="mt-8 flex h-28 w-28 items-center justify-center rounded-full bg-[#1f1f24] text-white shadow-xl active:scale-95"
                  onClick={() => void stopFlow()}
                  aria-label="Stop"
                >
                  <span className="h-9 w-9 rounded-md bg-white" />
                </button>
                <p className="mt-3 text-sm font-semibold">Tap to finish</p>
              </>
            )}
            {rec === "processing" && (
              <>
                <h2 className="text-2xl font-extrabold">{source === "vocals" ? "Reading your song…" : "Writing your song…"}</h2>
                <ul className="mt-6 w-full space-y-2 text-left">
                  {(source === "vocals" ? VOCAL_STEPS : STEPS).map((s, i, steps) => {
                    const cur = steps.findIndex((x) => x.key === step?.key);
                    const state = i < cur ? "done" : i === cur ? "now" : "todo";
                    return (
                      <li key={s.key} className={`flex items-center gap-3 rounded-2xl px-4 py-3 ${state === "now" ? "bg-accent-soft" : "bg-panel"}`}>
                        <span className="w-5 text-center">
                          {state === "done" ? "✓" : state === "now" ? <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent border-r-transparent" /> : "·"}
                        </span>
                        <span className={state === "todo" ? "text-muted" : "font-medium"}>
                          {s.label}
                          {state === "now" && s.key === "suggest" && step?.progress ? ` ${step.progress.done}/${step.progress.total}` : ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-4 text-xs text-muted">About a minute. Keep this screen open.</p>
              </>
            )}
          </div>
        )}

        {/* ----- LYRICS ----- */}
        {view === "lyrics" && !hasLines && (
          <div className="mt-10 text-center">
            <p className="text-muted">No lyrics yet.</p>
            <button className="btn-primary mt-4 rounded-full px-5 py-2.5" onClick={() => setView("flow")}>
              🎤 Record your flow
            </button>
          </div>
        )}
        {view === "lyrics" && hasLines && (
          <div className="space-y-6">
            {missing.length > 0 && (
              <button
                className="w-full rounded-2xl bg-accent-soft px-4 py-3 text-sm font-semibold text-accent disabled:opacity-50"
                disabled={busyLine === "missing"}
                onClick={() =>
                  void lineAction("missing", async () => {
                    for (let i = 0; i < missing.length; i += 8) await call(`/api/projects/${pid}/flow`, { action: "suggest", lineIds: missing.slice(i, i + 8) });
                  })
                }
              >
                {busyLine === "missing"
                  ? "Writing…"
                  : `✨ Write the ${missing.length} empty line${missing.length === 1 ? "" : "s"} · ${Math.ceil(missing.length / 8)} call${missing.length > 8 ? "s" : ""}`}
              </button>
            )}
            {tree.sections.map((s) => {
              const lines = s.lines.filter((l) => l.kind === "lyric") as LyricLine[];
              if (!lines.length) return null;
              return (
                <section key={s.id}>
                  <h3 className="mb-2 px-1 text-xs font-bold uppercase tracking-widest text-muted">{s.name}</h3>
                  <div className="space-y-2">
                    {lines.map((l, i) => (
                      <LineCard
                        key={l.id}
                        line={l}
                        lang={lang}
                        live={live === l.id}
                        couplet={i % 2 === 1}
                        busy={busyLine === l.id}
                        editing={editing === l.id}
                        draft={draft}
                        setDraft={setDraft}
                        onPlay={() => {
                          const at = l.audio_at ?? 0;
                          void play(Math.max(0, at - 0.4), at + 8);
                        }}
                        onKeep={() =>
                          void lineAction(l.id, () =>
                            call(
                              `/api/lines/${l.id}`,
                              l.status === "APPROVED" || l.status === "APPROVED_EDITED" ? { status: "SUGGESTED", action: "unkeep" } : { status: "APPROVED", action: "approve" },
                              "PATCH",
                            ),
                          )
                        }
                        onNext={() => void lineAction(l.id, () => call(`/api/alternatives/${l.alternatives[0].id}`, { action: "swap" }))}
                        onNew={() => void lineAction(l.id, () => call(`/api/projects/${pid}/flow`, { action: "suggest", lineIds: [l.id] }))}
                        onEdit={() => {
                          setEditing(l.id);
                          setDraft(l.text);
                        }}
                        onSave={() => {
                          setEditing(null);
                          if (draft.trim() && draft.trim() !== l.text.trim())
                            void lineAction(l.id, () => call(`/api/lines/${l.id}`, { text: draft.trim(), status: "APPROVED_EDITED", action: "edit" }, "PATCH"));
                        }}
                        onCancel={() => setEditing(null)}
                        onRemove={() => {
                          if (window.confirm("Remove this line?")) void lineAction(l.id, () => call(`/api/lines/${l.id}`, undefined, "DELETE"));
                        }}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}

        {/* ----- MORE ----- */}
        {view === "more" && (
          <MoreView
            tree={tree}
            onRename={(title) => void call(`/api/projects/${pid}`, { title }, "PATCH")}
            onLanguage={(language) => void call(`/api/projects/${pid}`, { language }, "PATCH")}
            onDelete={async () => {
              if (!window.confirm(`Delete “${tree.project.title}” for good?`)) return;
              await fetch(`/api/projects/${pid}`, { method: "DELETE" });
              router.push("/");
            }}
          />
        )}
      </main>

      {/* tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-lg border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        {(
          [
            ["flow", "🎤", "Flow"],
            ["lyrics", "📝", "Lyrics"],
            ["more", "⋯", "More"],
          ] as [View, string, string][]
        ).map(([v, icon, label]) => (
          <button
            key={v}
            disabled={rec !== null}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs font-medium ${view === v ? "text-accent" : "text-muted"}`}
            onClick={() => {
              if (playing) stopPlay();
              setView(v);
            }}
          >
            <span className="text-xl leading-none">{icon}</span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function LineCard(props: {
  line: LyricLine;
  lang: string;
  live: boolean;
  couplet: boolean;
  busy: boolean;
  editing: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onPlay: () => void;
  onKeep: () => void;
  onNext: () => void;
  onNew: () => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const { line: l, lang } = props;
  const kept = l.status === "APPROVED" || l.status === "APPROVED_EDITED";
  const target = l.flow?.syllables ?? null;
  const syl = l.text.trim() ? prosody(l.text, lang).syllables : 0;
  const fits = target !== null && syl > 0 ? Math.abs(syl - target) <= 1 : null;
  return (
    <div
      id={`line-${l.id}`}
      className={`rounded-2xl border px-3.5 py-3 transition-colors ${props.live ? "border-accent bg-accent-soft" : kept ? "border-ok/40 bg-panel" : "border-line bg-panel"} ${props.couplet ? "" : ""}`}
    >
      {props.editing ? (
        <div className="space-y-2">
          <textarea
            className="input min-h-16 text-[17px]"
            autoFocus
            value={props.draft}
            onChange={(e) => props.setDraft(e.target.value.replace(/\n/g, " "))}
          />
          <div className="flex gap-2">
            <button className="btn-primary flex-1 justify-center rounded-xl py-2" onClick={props.onSave}>
              Save
            </button>
            <button className="btn flex-1 justify-center rounded-xl py-2" onClick={props.onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <button className="block w-full text-left" onClick={props.onPlay} title="Play this bar">
            <span className={`text-[17px] leading-snug ${l.text.trim() ? "" : "italic text-muted"}`}>{l.text.trim() || (props.busy ? "Writing…" : "…")}</span>
          </button>
          {l.flow && <Pattern flow={l.flow} />}
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
            {target !== null && (
              <span className={fits === false ? "text-warn" : fits ? "text-ok" : ""} title={`You sang ${target} syllables here`}>
                {syl || "–"}/{target} syl
              </span>
            )}
            {l.flow?.source === "vocals" ? (
              l.text.trim() === l.flow.words.trim() ? (
                <span className="font-semibold text-accent">· 🎙 your recording</span>
              ) : (
                <span className="min-w-0 truncate">· recorded “{l.flow.words}”</span>
              )
            ) : (
              l.flow?.words && <span className="min-w-0 truncate">· you sang “{l.flow.words}”</span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <button
              className={`flex h-10 flex-1 items-center justify-center rounded-xl text-sm font-semibold ${kept ? "bg-ok text-white" : "bg-panel-2 text-ok"}`}
              disabled={props.busy || !l.text.trim()}
              onClick={props.onKeep}
            >
              ✓ {kept ? "Kept" : "Keep"}
            </button>
            <button
              className="flex h-10 flex-1 items-center justify-center rounded-xl bg-panel-2 text-sm font-semibold text-accent disabled:opacity-40"
              disabled={props.busy || l.alternatives.length === 0}
              onClick={props.onNext}
              title="Next option (free)"
            >
              ↻ {l.alternatives.length || ""}
            </button>
            <button
              className="flex h-10 flex-1 items-center justify-center rounded-xl bg-panel-2 text-sm font-semibold disabled:opacity-40"
              disabled={props.busy}
              onClick={props.onNew}
              title="3 new options for this bar (1 AI call)"
            >
              {props.busy ? (
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent border-r-transparent" />
              ) : (
                <>
                  ✨<span className="ml-1 text-[10px] font-medium text-muted">1 call</span>
                </>
              )}
            </button>
            <button className="flex h-10 w-10 items-center justify-center rounded-xl bg-panel-2 text-sm" onClick={props.onEdit} aria-label="Edit">
              ✎
            </button>
            <button className="flex h-10 w-10 items-center justify-center rounded-xl bg-panel-2 text-sm text-bad" onClick={props.onRemove} aria-label="Remove">
              🗑
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** the line's sung rhythm: one mark per syllable, stressed ones tall, a held last note drawn long */
function Pattern({ flow }: { flow: NonNullable<Line["flow"]> }) {
  const stressed = new Set(flow.stress);
  return (
    <div className="mt-1.5 flex h-4 items-end gap-[3px]" title={stressPattern(flow)} aria-label={`Flow: ${stressPattern(flow)}`}>
      {Array.from({ length: flow.syllables }, (_, i) => {
        const last = i === flow.syllables - 1;
        return (
          <span
            key={i}
            className={`rounded-full ${stressed.has(i + 1) ? "h-4 bg-accent" : "h-2 bg-accent/35"} ${last && flow.held ? "w-5" : "w-1.5"}`}
          />
        );
      })}
    </div>
  );
}

function BeatUpload({ pid, onDone }: { pid: string; onDone: (t: ProjectTree) => void }) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-6 flex flex-col items-center text-center">
      <h2 className="text-2xl font-extrabold">Upload your beat</h2>
      <p className="mt-2 text-sm text-muted">The beat you want to write lyrics for.</p>
      <label className="mt-6 flex w-full cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-accent/50 bg-accent-soft/40 px-4 py-10">
        <span className="text-4xl">🎵</span>
        <span className="font-semibold">{status ?? "Choose an audio file"}</span>
        <span className="text-xs text-muted">MP3 or any audio file, up to 50 MB</span>
        <input
          type="file"
          accept={BEAT_ACCEPT}
          className="hidden"
          disabled={!!status}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > MAX_BEAT_BYTES) {
              setError("The file is larger than 50 MB.");
              return;
            }
            setError(null);
            try {
              const body = await uploadBeat(pid, f, setStatus);
              const res = await fetch(`/api/projects/${pid}/audio`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
              const t = (await res.json()) as ProjectTree & { error?: string };
              if (!res.ok) throw new Error(t.error ?? "Upload failed");
              onDone(t);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Upload failed");
            } finally {
              setStatus(null);
            }
          }}
        />
      </label>
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
    </div>
  );
}

function MoreView({
  tree,
  onRename,
  onLanguage,
  onDelete,
}: {
  tree: ProjectTree;
  onRename: (t: string) => void;
  onLanguage: (l: string) => void;
  onDelete: () => void;
}) {
  const pid = tree.project.id;
  const [copied, setCopied] = useState(false);
  const text = fullText(tree);
  const slug = tree.project.title.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase() || "lyrics";
  const row = "flex w-full items-center gap-3 rounded-2xl bg-panel px-4 py-3.5 text-left";
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <label className="label">Name</label>
        <input className="input text-base" defaultValue={tree.project.title} onBlur={(e) => e.target.value.trim() && e.target.value !== tree.project.title && onRename(e.target.value.trim())} />
        <label className="label">Language</label>
        <div className="flex flex-wrap gap-1.5">
          {LANGUAGES.map((l) => (
            <button
              key={l.value}
              className={`rounded-full px-3.5 py-2 text-sm font-medium ${tree.project.language === l.value ? "bg-accent text-white" : "bg-panel-2"}`}
              onClick={() => onLanguage(l.value)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <button
          className={row}
          disabled={!text}
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <span>📋</span>
          <span className="flex-1">{copied ? "Copied ✓" : "Copy the lyrics"}</span>
        </button>
        <button className={row} disabled={!text} onClick={() => download(`${slug}.txt`, `${tree.project.title}\n\n${text}`)}>
          <span>⬇️</span>
          <span className="flex-1">Download the lyrics (.txt)</span>
        </button>
      </div>
      <div className="space-y-2">
        <p className="label">Advanced</p>
        <Link href={`/p/${pid}`} className={row}>
          <span>✍️</span>
          <span className="flex-1">
            Full editor
            <span className="block text-xs text-muted">sections, rhymes, patterns, performers, history</span>
          </span>
          <span className="text-muted">›</span>
        </Link>
        <Link href={`/p/${pid}/studio`} className={row}>
          <span>🎚</span>
          <span className="flex-1">
            Studio
            <span className="block text-xs text-muted">record vocal takes on a Mac with your sound card</span>
          </span>
          <span className="text-muted">›</span>
        </Link>
        <Link href={`/p/${pid}/remote`} className={row}>
          <span>📱</span>
          <span className="flex-1">
            Remote
            <span className="block text-xs text-muted">control the Studio on your Mac from this phone</span>
          </span>
          <span className="text-muted">›</span>
        </Link>
      </div>
      <button className={`${row} text-bad`} onClick={onDelete}>
        <span>🗑</span>
        <span className="flex-1">Delete this song</span>
      </button>
    </div>
  );
}
