"use client";

import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { syllableParts } from "@/lib/rhyme/syllabify";
import { marksFor } from "@/lib/marks";
import { MarkedText } from "@/components/Marks";
import { Check, ChevronRight, Headphones, Laptop, Mic, Pause, Phone, Play, Plus, Restart, Sliders, Trash, Wand } from "@/components/icons";
import { FX_CATEGORIES, FX_PRESETS, layerPreset } from "@/lib/fx/presets";
import { keyName, NOTE_NAMES } from "@/lib/fx/tune";
import { followTo } from "@/components/writer/follow";
import { fmtTime } from "@/lib/audio/song-map";
import type { Timeline } from "@/lib/audio/timeline";
import type { StudioEngine } from "@/lib/studio/engine";
import type { Line, ProjectTree } from "@/lib/types";
import { useIsPhone, useLocalRecorder, usePref, useRemoteRecorder, type Recorder } from "./recorder";

type On = "here" | "mac";

interface Props {
  tree: ProjectTree;
  setTree: (t: ProjectTree) => void;
  engine: RefObject<StudioEngine | null>;
  beat: RefObject<AudioBuffer | null>;
  beatReady: boolean;
  bar: number;
  beatLength: number;
  rangeOf: (sectionId: string) => { start: number; end: number } | null;
  timeline: Timeline;
  /** ?on=mac: open as the remote for the Mac */
  initialOn?: On;
  /** recording: the tabs wait */
  onBusy: (busy: boolean) => void;
  /** recording layers you don't hear (the Mix) */
  muted: string[];
  onMix: () => void;
  /** the part being worked on (shared with Flow and Lyrics) */
  part: string | null;
  onPart: (id: string) => void;
}

const SUGGESTED_LANES = ["Harmony", "Backing", "Hook"];
const SIZES = { S: 17, M: 21, L: 27 } as const;

/**
 * Record: your voice for each part, on layers (Lead, Double, Ad-libs…), over
 * the beat with the lyrics following. On this phone, or on the Mac (its
 * microphone or sound card) with this phone as the remote — the same screen.
 */
export function RecordView(props: Props) {
  const phone = useIsPhone();
  const [on, setOn] = usePref<On>("vf.rec.on", "here", props.initialOn);
  // a computer records itself (and your phone can drive it)
  const where: On = phone ? on : "here";
  const parts = props.tree.sections;
  const sectionId = props.part && parts.some((p) => p.id === props.part) ? props.part : (parts[0]?.id ?? null);
  const section: [string | null, (id: string) => void] = [sectionId, props.onPart];
  return (
    <div className="space-y-4">
      {phone ? (
        <div className="flex rounded-full bg-panel-2 p-1" role="radiogroup" aria-label="Record on">
          {(
            [
              ["here", Phone, "This phone"],
              ["mac", Laptop, "My Mac"],
            ] as const
          ).map(([v, Icon, label]) => (
            <button
              key={v}
              role="radio"
              aria-checked={where === v}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-sm font-semibold transition-colors ${where === v ? "bg-panel text-fg shadow-sm" : "text-muted"}`}
              onClick={() => setOn(v)}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {where === "mac" ? <RemoteRecord {...props} section={section} /> : <LocalRecord {...props} section={section} host={!phone} />}
    </div>
  );
}

function LocalRecord(props: Props & { section: [string | null, (id: string) => void]; host: boolean }) {
  const r = useLocalRecorder(props);
  return <RecordScreen r={r} {...props} />;
}

function RemoteRecord(props: Props & { section: [string | null, (id: string) => void] }) {
  const r = useRemoteRecorder(props);
  return <RecordScreen r={r} {...props} />;
}

function RecordScreen({ r, tree, rangeOf, bar, timeline, onBusy, host, muted, onMix }: Props & { r: Recorder; host?: boolean }) {
  const [size, setSize] = usePref<keyof typeof SIZES>("vf.rec.size", "M");
  const [sheet, setSheet] = useState(false);
  /** the sound library, open for this layer */
  const [soundFor, setSoundFor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** how far each take was moved here (shown next to its timing buttons) */
  const [moved, setMoved] = useState<Record<string, number>>({});
  const nudge = (id: string, by: number) => {
    setMoved((m) => ({ ...m, [id]: Math.round(((m[id] ?? 0) + by) * 1000) / 1000 }));
    r.shift(id, by);
  };
  const [newLane, setNewLane] = useState("");
  const section = tree.sections.find((s) => s.id === r.sectionId) ?? null;
  const range = section ? rangeOf(section.id) : null;
  const lines = section?.lines.filter((l) => l.kind === "lyric" && l.text.trim() && l.status !== "DECLINED") ?? [];
  const live = r.lineIndex !== null && section ? (section.lines[r.lineIndex]?.id ?? null) : null;
  const takes = r.takes.filter((t) => t.lane === r.lane).sort((a, b) => b.take_no - a.take_no);
  const recording = r.status === "recording" || r.status === "countin";
  const idle = r.status === "idle";
  const canRecord = idle && !r.starting && r.beatReady && !!range && (!r.remote || (r.connected && r.armed));
  const nextTake = Math.max(0, ...r.takes.filter((t) => t.lane === r.lane).map((t) => t.take_no)) + 1;

  // recording on this device: the tabs wait until the take is saved
  const busy = !r.remote && (recording || r.status === "saving");
  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);
  // the line being sung stays in view
  useEffect(() => {
    if (live) followTo(document.getElementById(`rec-${live}`));
  }, [live]);
  // a computer: space = play / stop, R = record
  useEffect(() => {
    if (r.remote) return;
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return;
      if (ev.code === "Space") {
        ev.preventDefault();
        if (idle) r.play();
        else r.stop();
      } else if ((ev.key === "r" || ev.key === "R") && canRecord) r.record(r.lane);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const statusText = r.starting
    ? "Switching the microphone on…"
    : r.tuning
      ? "Tuning the voice…"
    : r.status === "countin"
      ? `${r.statusLane} · get ready…`
      : r.status === "recording"
        ? `Recording ${r.statusLane}${r.takeNo ? ` · take ${r.takeNo}` : ""}`
        : r.status === "saving"
          ? "Saving the take…"
          : r.status === "calibrating"
            ? "Listening to the clicks…"
            : r.status === "playing"
              ? r.playingTake
                ? `Playing ${r.takes.find((t) => t.id === r.playingTake)?.lane ?? ""} take ${r.takes.find((t) => t.id === r.playingTake)?.take_no ?? ""}`
                : `Playing ${section?.name ?? ""}`
              : r.remote && !r.connected
                ? "Waiting for your Mac…"
                : r.remote && !r.armed
                  ? "Allow the microphone on your Mac"
                  : !r.beatReady
                    ? "Loading the beat…"
                    : `Record ${r.lane} · take ${nextTake}`;

  return (
    <>
      {/* the Mac: where it stands */}
      {r.remote && (
        <div className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-sm ${r.connected && r.armed ? "bg-ok-soft text-ok" : "bg-panel-2 text-muted"}`}>
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${r.connected && r.armed ? "bg-ok" : r.connected ? "bg-warn" : "animate-pulse bg-muted"}`} />
          <span className="flex-1">
            {r.connected && r.armed ? (
              <>Connected · your {r.device} records, this phone is the remote</>
            ) : r.connected ? (
              <>Your {r.device} is there — click “Allow microphone” on it once.</>
            ) : (
              <>
                On your Mac, open this song and click <b>Record</b>. They connect by themselves.
              </>
            )}
          </span>
        </div>
      )}
      {/* a computer: the phone can be its remote */}
      {host && (
        <div className="flex items-center gap-3 rounded-2xl bg-panel px-4 py-3 text-sm ring-1 ring-line/60">
          <Phone className="h-5 w-5 shrink-0 text-accent" />
          <span className="flex-1 text-muted">
            Your phone can be the remote: open this song on it → <b className="text-fg">Record</b> → <b className="text-fg">My Mac</b>.
          </span>
          {!r.armed && (
            <button className="shrink-0 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white" onClick={r.arm}>
              Allow microphone
            </button>
          )}
        </div>
      )}
      {r.error && (
        <p className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad" onClick={r.clearError}>
          {r.error}
        </p>
      )}

      {/* the parts */}
      <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4">
        {tree.sections.map((s) => {
          const n = r.takeCount(s.id);
          const active = s.id === r.sectionId;
          return (
            <button
              key={s.id}
              disabled={!idle}
              onClick={() => r.select(s.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold transition-colors disabled:opacity-60 ${active ? "bg-fg text-bg" : "bg-panel-2 text-fg/80"}`}
            >
              {s.name}
              {n > 0 && (
                <span className={`flex items-center gap-0.5 text-[11px] font-normal ${active ? "opacity-70" : "text-muted"}`}>
                  <Mic className="h-3 w-3" />
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* the part's lyrics, following the beat */}
      {section && (
        <section className="rounded-3xl bg-panel px-4 pb-4 pt-3.5 ring-1 ring-line/60">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[17px] font-bold">{section.name}</h2>
            {range && (
              <span className="font-mono text-[11px] text-muted">
                {fmtTime(range.start)} · {fmtTime(range.end - range.start)} · {Math.max(1, Math.round((range.end - range.start) / bar))} bars
              </span>
            )}
          </div>
          <div className="mt-2 space-y-1" style={{ fontSize: SIZES[size] ?? SIZES.M, lineHeight: 1.35 }}>
            {lines.length === 0 && <p className="text-sm text-muted">No lyrics in this part yet — record anyway (ad-libs, a hook…), or write them in Lyrics.</p>}
            {lines.map((l, k) => {
              const isLive = l.id === live;
              const liveAt = live ? lines.findIndex((x) => x.id === live) : -1;
              // when each line starts on the beat, and when the next one does (its syllables share that time)
              const starts = timeline.get(section.id)?.starts ?? [];
              const startOf = (x: Line) => starts[section.lines.indexOf(x as (typeof section.lines)[number])];
              const from = startOf(l);
              const next = lines[k + 1] ? startOf(lines[k + 1]) : (range?.end ?? from + bar);
              return (
                <p
                  key={l.id}
                  id={`rec-${l.id}`}
                  className={`-mx-2 rounded-xl px-2 py-0.5 transition-colors ${isLive ? "bg-accent-soft font-semibold text-fg" : liveAt >= 0 && k < liveAt ? "text-muted" : "text-fg/90"}`}
                >
                  {isLive && r.clock && Number.isFinite(from) ? (
                    <Karaoke line={l} lang={tree.project.language} from={from} until={Math.min(Number.isFinite(next) ? next : from + bar, from + 2 * bar)} clock={r.clock} />
                  ) : marksFor(l).length ? (
                    <MarkedText text={l.text.trim()} marks={marksFor(l)} />
                  ) : (
                    l.text
                  )}
                </p>
              );
            })}
          </div>
        </section>
      )}

      {/* layers and their takes */}
      {section && (
        <div className="space-y-2.5">
          <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4">
            {r.lanes.map((l) => {
              const n = r.takes.filter((t) => t.lane === l).length;
              const active = l === r.lane;
              return (
                <button
                  key={l}
                  disabled={!idle}
                  onClick={() => r.setLane(l)}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-semibold transition-colors ${active ? "bg-accent text-white" : "bg-panel-2 text-fg/80"}`}
                >
                  <span className={muted.includes(l) ? "line-through opacity-60" : ""}>{l}</span>
                  {n > 0 && <span className={`text-xs font-normal ${active ? "opacity-80" : "text-muted"}`}>{n}</span>}
                </button>
              );
            })}
            <button
              className="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-line px-3 py-2 text-sm font-semibold text-muted"
              disabled={!idle}
              onClick={() => setAdding((a) => !a)}
              aria-label="New layer"
            >
              <Plus className="h-4 w-4" />
              Layer
            </button>
            <button
              className="flex shrink-0 items-center gap-1 rounded-full bg-panel-2 px-3 py-2 text-sm font-semibold text-fg/80"
              onClick={onMix}
              aria-label="What you hear"
            >
              <Sliders className="h-4 w-4" />
              Mix
            </button>
          </div>
          {adding && (
            <div className="space-y-2 rounded-2xl bg-panel p-3 ring-1 ring-line/60">
              <div className="flex gap-2">
                <input
                  className="input flex-1 text-base"
                  placeholder="Name, e.g. Harmony"
                  value={newLane}
                  maxLength={30}
                  onChange={(e) => setNewLane(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newLane.trim()) {
                      r.addLane(newLane);
                      setNewLane("");
                      setAdding(false);
                    }
                  }}
                />
                <button
                  className="btn-primary rounded-xl px-4"
                  disabled={!newLane.trim()}
                  onClick={() => {
                    r.addLane(newLane);
                    setNewLane("");
                    setAdding(false);
                  }}
                >
                  Add
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTED_LANES.filter((l) => !r.lanes.includes(l)).map((l) => (
                  <button
                    key={l}
                    className="rounded-full bg-panel-2 px-3 py-1 text-xs font-semibold"
                    onClick={() => {
                      r.addLane(l);
                      setAdding(false);
                    }}
                  >
                    + {l}
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* the layer's sound: from the library */}
          <button
            className="flex w-full items-center gap-3 rounded-2xl bg-panel px-3.5 py-2.5 text-left ring-1 ring-line/60 disabled:opacity-60"
            disabled={!idle && r.status !== "playing"}
            onClick={() => setSoundFor(r.lane)}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
              <Wand className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-muted">Sound of the {r.lane}</span>
              <span className="block truncate text-[15px] font-semibold">{layerPreset(r.sounds, r.lane).name}</span>
            </span>
            <ChevronRight className="h-4 w-4 text-muted" />
          </button>
          {takes.length === 0 ? (
            <p className="px-1 text-sm text-muted">No {r.lane} takes yet — tap the red button to record one.</p>
          ) : (
            <div className="space-y-2">
              {takes.map((t) => {
                const playingThis = r.status === "playing" && r.playingTake === t.id;
                return (
                  <div key={t.id} className={`flex items-center gap-3 rounded-2xl bg-panel px-3 py-2.5 ring-1 ${t.chosen ? "ring-accent/60" : "ring-line/60"}`}>
                    <button
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${playingThis ? "bg-accent text-white" : "bg-panel-2 text-fg"} disabled:opacity-40`}
                      disabled={!(idle || r.status === "playing")}
                      onClick={() => (playingThis ? r.stop() : r.playTake(t.id))}
                      aria-label={playingThis ? "Stop" : `Play take ${t.take_no}`}
                    >
                      {playingThis ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-semibold">Take {t.take_no}</span>
                        <span className="font-mono text-[11px] text-muted">{fmtTime(t.duration)}</span>
                        {t.chosen && <span className="text-[11px] font-semibold text-accent">in the song</span>}
                      </div>
                      <Peaks peaks={t.peaks} className={`mt-1 h-5 w-full ${t.chosen ? "text-accent" : "text-muted/70"}`} />
                      {/* off the beat? move it by ear: 20 ms a tap (later takes on this device follow) */}
                      <div className="mt-1 flex items-center gap-1 text-[11px] text-muted">
                        <button
                          className="rounded-full bg-panel-2 px-2 py-0.5 font-semibold text-fg/80 disabled:opacity-40"
                          disabled={!(idle || r.status === "playing")}
                          onClick={() => nudge(t.id, -0.02)}
                          aria-label={`Take ${t.take_no} earlier`}
                        >
                          ‹ earlier
                        </button>
                        <span className="min-w-14 text-center tabular-nums">{moved[t.id] ? `${moved[t.id] > 0 ? "+" : ""}${Math.round(moved[t.id] * 1000)} ms` : "timing"}</span>
                        <button
                          className="rounded-full bg-panel-2 px-2 py-0.5 font-semibold text-fg/80 disabled:opacity-40"
                          disabled={!(idle || r.status === "playing")}
                          onClick={() => nudge(t.id, 0.02)}
                          aria-label={`Take ${t.take_no} later`}
                        >
                          later ›
                        </button>
                      </div>
                    </div>
                    {!t.chosen && (
                      <button className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-panel-2 px-3 text-xs font-semibold disabled:opacity-40" disabled={!idle} onClick={() => r.choose(t.id)}>
                        <Check className="h-3.5 w-3.5" />
                        Use
                      </button>
                    )}
                    <button
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted active:bg-panel-2 disabled:opacity-40"
                      disabled={!idle}
                      onClick={() => window.confirm(`Delete ${t.lane} take ${t.take_no}?`) && r.remove(t.id)}
                      aria-label={`Delete take ${t.take_no}`}
                    >
                      <Trash className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div className="h-24" />

      {/* transport, above the tabs */}
      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-lg border-t border-line/70 bg-bg/95 pb-[calc(env(safe-area-inset-bottom)+4.3rem)] backdrop-blur-xl">
        <div className="flex items-center justify-between px-8 pt-3">
          {recording ? (
            <DockButton label="Again" onClick={r.restart}>
              <Restart className="h-5 w-5" />
            </DockButton>
          ) : (
            <DockButton label={r.status === "playing" && !r.playingTake ? "Stop" : "Play part"} disabled={!(idle || r.status === "playing") || !r.beatReady || !range} onClick={() => (r.status === "playing" ? r.stop() : r.play())}>
              {r.status === "playing" && !r.playingTake ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
            </DockButton>
          )}
          <BigButton r={r} canRecord={canRecord} />
          <DockButton label="Settings" onClick={() => setSheet(true)} disabled={recording}>
            <Sliders className="h-5 w-5" />
          </DockButton>
        </div>
        <div className="flex h-7 items-center justify-center gap-2 px-6 text-xs font-semibold text-muted">
          <span className={`truncate ${recording ? "text-[#dc2626]" : ""}`}>{statusText}</span>
          {recording && !r.remote && (
            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-panel-2" title="Input level">
              <span className="block h-full rounded-full" style={{ width: `${Math.min(100, r.level * 100)}%`, background: r.level > 0.9 ? "var(--bad)" : "var(--ok)" }} />
            </span>
          )}
        </div>
      </div>

      {r.note && <div className="fixed left-1/2 top-20 z-30 -translate-x-1/2 rounded-full bg-fg px-3.5 py-1.5 text-xs font-semibold text-bg shadow-lg">{r.note}</div>}

      {sheet && <RecordSettings r={r} size={size} setSize={setSize} onClose={() => setSheet(false)} />}
      {soundFor && <SoundLibrary r={r} lane={soundFor} hasTake={r.takes.some((t) => t.lane === soundFor)} onClose={() => setSoundFor(null)} />}
    </>
  );
}

/**
 * The line being sung, syllable by syllable on the beat: what is sung lights up as the song plays. Each
 * syllable at its time in the line's flow; without one, the line's time is shared out evenly.
 */
function Karaoke({ line, lang, from, until, clock }: { line: Line; lang: string; from: number; until: number; clock: () => number }) {
  const [now, setNow] = useState(from);
  useEffect(() => {
    let id = requestAnimationFrame(function loop() {
      setNow(clock());
      id = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(id);
  }, [clock]);
  const parts = syllableParts(line.text.trim(), lang);
  const marks = marksFor(line);
  if (!parts) return marks.length ? <MarkedText text={line.text.trim()} marks={marks} /> : <>{line.text}</>;
  const sung = line.flow?.times;
  // the flow's syllable times; written with a syllable more or less: spread over the same stretch
  const times =
    sung && sung.length === parts.length
      ? sung
      : sung && sung.length > 1
        ? parts.map((_, i) => sung[0] + ((sung[sung.length - 1] - sung[0]) * i) / Math.max(1, parts.length - 1))
        : parts.map((_, i) => from + ((until - from) * i) / parts.length);
  // with marks: word by word (a word lights up with its first syllable), the marks stay in place
  if (marks.length) {
    const wordStart: number[] = [];
    parts.forEach((p, i) => {
      if (i === 0 || p.space) wordStart.push(times[i]);
    });
    return <MarkedText text={line.text.trim()} marks={marks} lit={(w) => now >= (wordStart[w] ?? Infinity) - 0.03} />;
  }
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p.space && " "}
          <span className={now >= times[i] - 0.03 ? "text-accent" : ""}>{p.text}</span>
        </span>
      ))}
    </>
  );
}

function DockButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button className="flex w-16 flex-col items-center gap-1 text-[11px] font-semibold text-muted disabled:opacity-40" disabled={disabled} onClick={onClick}>
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-panel-2 text-fg">{children}</span>
      {label}
    </button>
  );
}

/** record · the count-in · stop */
function BigButton({ r, canRecord }: { r: Recorder; canRecord: boolean }) {
  const base = "relative flex h-[76px] w-[76px] items-center justify-center rounded-full shadow-xl active:scale-95 disabled:opacity-40";
  if (r.status === "countin")
    return (
      <button className={`${base} bg-[#dc2626] text-white shadow-red-500/30`} onClick={r.stop} aria-label="Cancel">
        <span className="font-mono text-3xl font-bold tabular-nums">{r.beatsLeft ?? "…"}</span>
      </button>
    );
  if (r.status === "recording")
    return (
      <button className={`${base} bg-[#dc2626] text-white shadow-red-500/30`} onClick={r.stop} aria-label="Stop and keep the take">
        <span className="absolute inset-0 animate-ping rounded-full bg-[#dc2626]/40" />
        <span className="relative h-7 w-7 rounded-md bg-white" />
      </button>
    );
  if (r.status === "saving" || r.status === "calibrating")
    return (
      <span className={`${base} bg-panel-2`}>
        <span className="h-7 w-7 animate-spin rounded-full border-[3px] border-muted border-r-transparent" />
      </span>
    );
  return (
    <button className={`${base} bg-[#dc2626] text-white shadow-red-500/30`} disabled={!canRecord} onClick={() => r.record(r.lane)} aria-label={`Record ${r.lane}`}>
      <span className="h-8 w-8 rounded-full bg-white" />
    </button>
  );
}

function Peaks({ peaks, className }: { peaks: number[]; className?: string }) {
  const n = 40;
  const step = Math.max(1, Math.floor(peaks.length / n));
  const p = peaks.filter((_, i) => i % step === 0).slice(0, n);
  return (
    <svg viewBox={`0 0 ${n * 3} 20`} preserveAspectRatio="none" className={className} aria-hidden>
      {p.map((v, i) => (
        <rect key={i} x={i * 3} y={10 - Math.max(0.6, v * 9)} width={1.8} height={Math.max(1.2, v * 18)} rx={0.9} fill="currentColor" />
      ))}
    </svg>
  );
}

/**
 * The sound library: the typical modern vocal chains, by kind. Tapping one gives it to the layer and plays
 * it on the layer's take in this part, with the beat and the other layers.
 */
function SoundLibrary({ r, lane, hasTake, onClose }: { r: Recorder; lane: string; hasTake: boolean; onClose: () => void }) {
  const current = layerPreset(r.sounds, lane).id;
  const playing = r.status === "playing";
  const key = r.songKey;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92dvh] w-full max-w-lg space-y-4 overflow-auto rounded-t-3xl bg-panel px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3"
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
        <div>
          <h2 className="text-xl font-bold">Sound · {lane}</h2>
          <p className="text-xs text-muted">
            {hasTake ? `Tap a sound to hear it on your ${lane} take — your recording stays as it is.` : `Record a ${lane} take in this part to hear the sounds on it.`}
          </p>
        </div>
        {FX_CATEGORIES.map((cat) => (
          <div key={cat}>
            <p className="label">{cat === "Tuned" ? "Autotune" : cat === "Layers" ? "For doubles & ad-libs" : cat}</p>
            <div className="grid grid-cols-2 gap-2">
              {FX_PRESETS.filter((p) => p.category === cat).map((p) => {
                const on = p.id === current;
                return (
                  <button
                    key={p.id}
                    className={`rounded-2xl p-3 text-left ring-1 transition-colors disabled:opacity-50 ${on ? "bg-accent-soft ring-accent" : "bg-panel-2 ring-transparent active:bg-line/60"}`}
                    disabled={r.tuning || (!r.connected && r.remote)}
                    onClick={() => r.trySound(lane, p.id)}
                    aria-pressed={on}
                  >
                    <span className="flex items-center gap-1 text-sm font-bold">
                      {on && <Check className="h-3.5 w-3.5 text-accent" />}
                      {p.name}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted">{p.about}</span>
                  </button>
                );
              })}
            </div>
            {cat === "Tuned" && (
              <label className="mt-2 flex items-center gap-2 px-1 text-xs text-muted">
                Key
                <select
                  className="rounded-lg bg-panel-2 px-2 py-1 text-xs text-fg"
                  value={key === "chromatic" ? "chromatic" : key ? `${key.root}${key.minor ? "m" : ""}` : ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) r.setKey(v === "chromatic" ? "chromatic" : { root: parseInt(v, 10), minor: v.endsWith("m") });
                  }}
                >
                  {!key && <option value="">found in the beat when first tuned</option>}
                  {NOTE_NAMES.flatMap((n, i) => [
                    <option key={`${i}`} value={`${i}`}>
                      {n} major
                    </option>,
                    <option key={`${i}m`} value={`${i}m`}>
                      {n} minor
                    </option>,
                  ])}
                  <option value="chromatic">Chromatic (every semitone)</option>
                </select>
                <span className="truncate">{key ? (key === "chromatic" ? "" : `— ${keyName(key)}`) : ""}</span>
              </label>
            )}
          </div>
        ))}
        <div className="flex items-center gap-2">
          {(r.tuning || playing) && (
            <span className="flex flex-1 items-center gap-2 text-xs font-semibold text-accent">
              {r.tuning && <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-r-transparent" />}
              {r.tuning ? "Tuning the voice…" : "Playing"}
            </span>
          )}
          {playing && (
            <button className="rounded-full bg-panel-2 px-4 py-2 text-sm font-semibold" onClick={r.stop}>
              Stop
            </button>
          )}
          <button className="btn-primary ml-auto rounded-2xl px-6 py-3" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function RecordSettings({ r, size, setSize, onClose }: { r: Recorder; size: keyof typeof SIZES; setSize: (s: keyof typeof SIZES) => void; onClose: () => void }) {
  const s = r.settings;
  const seg = (on: boolean) => `flex-1 rounded-full py-2 text-sm font-semibold transition-colors ${on ? "bg-panel text-fg shadow-sm" : "text-muted"}`;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92dvh] w-full max-w-lg space-y-5 overflow-auto rounded-t-3xl bg-panel px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3"
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
        <h2 className="text-xl font-bold">Recording</h2>

        <div className="space-y-2">
          <p className="label">Count-in</p>
          <div className="flex rounded-full bg-panel-2 p-1">
            {[0, 1, 2].map((n) => (
              <button key={n} className={seg(r.countIn === n)} onClick={() => r.setCountIn(n)}>
                {n === 0 ? "Off" : `${n} bar${n === 1 ? "" : "s"}`}
              </button>
            ))}
          </div>
          {s && (
            <label className="flex items-center justify-between gap-3 px-1 py-1 text-sm">
              Click during the count-in
              <Toggle on={s.metronome} onChange={s.setMetronome} />
            </label>
          )}
        </div>

        <div className="space-y-2">
          <p className="label">Lyrics size</p>
          <div className="flex rounded-full bg-panel-2 p-1">
            {(Object.keys(SIZES) as (keyof typeof SIZES)[]).map((k) => (
              <button key={k} className={seg(size === k)} onClick={() => setSize(k)}>
                {k === "S" ? "Small" : k === "M" ? "Medium" : "Large"}
              </button>
            ))}
          </div>
        </div>

        {s ? (
          <>
            <div className="space-y-2">
              <p className="label">Microphone</p>
              <select className="input text-base" value={s.deviceId} onChange={(e) => s.setDeviceId(e.target.value)}>
                <option value="">{r.armed ? "Default microphone" : "Default microphone (allow it first)"}</option>
                {s.inputs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
              {s.inputs.length > 1 && (
                <div className="flex rounded-full bg-panel-2 p-1">
                  {(
                    [
                      [0, "Input 1"],
                      [1, "Input 2"],
                      [-1, "1 + 2"],
                    ] as const
                  ).map(([c, label]) => (
                    <button key={c} className={seg(s.channel === c)} onClick={() => s.setChannel(c)}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <label className="flex items-center justify-between gap-3 px-1 py-1 text-sm">
                <span className="flex items-center gap-2">
                  <Headphones className="h-4 w-4 text-muted" />
                  <span>
                    I wear headphones
                    <span className="block text-xs text-muted">{s.headphones ? "Clean takes, no processing." : "The beat from the speaker is filtered out of the take (less clean)."}</span>
                  </span>
                </span>
                <Toggle on={s.headphones} onChange={s.setHeadphones} />
              </label>
            </div>

            <div className="space-y-2">
              <p className="label">Timing</p>
              <div className="flex items-center gap-3 rounded-2xl bg-panel-2 px-4 py-3 text-sm">
                <span className="flex-1">
                  Delay <b className="font-mono">{s.latencyMs} ms</b>
                  <span className="block text-xs text-muted">
                    {s.calibrated ? "Measured — every take is moved by it." : "Estimated. Measure it once: hold the headphones to the microphone and tap Measure."}
                  </span>
                </span>
                <button className="rounded-full bg-panel px-3 py-1.5 text-xs font-semibold ring-1 ring-line disabled:opacity-40" disabled={r.status !== "idle"} onClick={s.calibrate}>
                  {r.status === "calibrating" ? "Listening…" : "Measure"}
                </button>
              </div>
              {s.calibrated && (
                <button className="px-1 text-xs text-muted underline" onClick={() => s.setLatencyMs(null)}>
                  Use the estimate again
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="rounded-2xl bg-panel-2 px-4 py-3 text-sm text-muted">The microphone and the timing are set on your Mac (Record → Settings).</p>
        )}
        <button className="btn-primary w-full rounded-2xl py-3" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={(e) => {
        e.preventDefault();
        onChange(!on);
      }}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-line"}`}
    >
      <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}
