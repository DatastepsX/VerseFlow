"use client";

import { FlowText } from "@/components/FlowText";
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { syllableParts } from "@/lib/rhyme/syllabify";
import { marksFor } from "@/lib/marks";
import { slotsWithMarks, untyped } from "@/lib/flow/notation";
import { MarkedText } from "@/components/Marks";
import { Check, ChevronRight, Headphones, Laptop, Mic, Pause, Phone, Play, Plus, Restart, Sliders, Trash, Wand } from "@/components/icons";
import { FX_CATEGORIES, FX_PRESETS, layerPreset } from "@/lib/fx/presets";
import { keyName, NOTE_NAMES } from "@/lib/fx/tune";
import { followTo } from "@/components/writer/follow";
import { fmtTime } from "@/lib/audio/song-map";
import { louderGain, pct, TAKE_MAX } from "@/lib/studio/mix";
import { leadOf, partJobs, syncTakes, type SyncJob, type SyncMode } from "@/lib/studio/sync";
import { NotesBadge, NotesSheet, notesOf } from "./Notes";
import { VolumeSlider } from "@/components/VolumeSlider";
import { undoHeaders, undoStep } from "@/lib/undo-group";
import type { Timeline } from "@/lib/audio/timeline";
import type { StudioEngine } from "@/lib/studio/engine";
import type { Line, ProjectTree } from "@/lib/types";
import { GAIN_MAX, GAIN_MIN, useIsPhone, useLocalRecorder, usePref, useRemoteRecorder, type Recorder } from "./recorder";

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
  // the main device — where you record and play: this phone, or your Mac with the phone as its remote (kept with
  // your profile, so the Mac knows it too); a computer records itself
  const [main, setMain] = usePref<"phone" | "mac">("vf.studio.main", "phone");
  const on: On = main === "mac" ? "mac" : "here";
  // opened as the remote (?on=mac): the Mac becomes the main device
  useEffect(() => {
    if (props.initialOn) setMain(props.initialOn === "mac" ? "mac" : "phone");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as opened
  }, []);
  const setOn = (v: On) => setMain(v === "mac" ? "mac" : "phone");
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

function RecordScreen({ r, tree, setTree, rangeOf, bar, timeline, onBusy, host, muted, onMix }: Props & { r: Recorder; host?: boolean }) {
  const [size, setSize] = usePref<keyof typeof SIZES>("vf.rec.size", "M");
  const [sheet, setSheet] = useState(false);
  const [micSheet, setMicSheet] = useState(false);
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
  /** the written lines a take sings: those starting inside it, else its part's */
  const takeLines = (rt: Recorder["takes"][number]) => {
    const t = tree.takes.find((x) => x.id === rt.id);
    if (!t) return [];
    const all = tree.sections.flatMap((s) => s.lines).filter((l) => l.kind === "lyric" && l.text.trim() && l.status !== "DECLINED");
    const inside = all.filter((l) => l.audio_at !== null && l.audio_at >= t.start_at - 0.3 && l.audio_at < t.start_at + t.duration - 0.3);
    return inside.length ? inside : all.filter((l) => l.section_id === t.section_id);
  };
  /** the take being cut */
  const [cutting, setCutting] = useState<string | null>(null);
  /** the line whose notes are open */
  const [notesFor, setNotesFor] = useState<string | null>(null);
  /** in time: one take, or the whole part */
  const [timing, setTiming] = useState<{ takeId: string } | { part: string } | null>(null);
  /** forced alignment: the take + its lines' text → every syllable's time (1 call); the lines' flow follows the take */
  const [syncing, setSyncing] = useState<string | null>(null);
  const [synced, setSynced] = useState<Record<string, string>>({});
  const sync = async (t: Recorder["takes"][number]) => {
    const ids = takeLines(t).map((l) => l.id);
    setSyncing(t.id);
    try {
      const res = await undoStep(`Words synced to ${t.lane} take ${t.take_no}`, () =>
        fetch(`/api/takes/${t.id}`, { method: "POST", headers: { "content-type": "application/json", ...undoHeaders() }, body: JSON.stringify({ action: "align", lineIds: ids }) }),
      );
      const data = (await res.json().catch(() => ({}))) as ProjectTree & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not sync the words");
      setTree(data);
      const [n, of] = (res.headers.get("x-aligned") ?? "0/0").split("/");
      setSynced((m) => ({ ...m, [t.id]: n === "0" ? "The words didn't match the take" : `${n} of ${of} lines synced — karaoke and flow follow this take` }));
    } catch (e) {
      setSynced((m) => ({ ...m, [t.id]: e instanceof Error ? e.message : "Could not sync the words" }));
    } finally {
      setSyncing(null);
    }
  };
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
              <>
                Connected · your {r.device} records, this phone is the remote
                {r.mic && <span className="block text-xs opacity-80">🎙 {r.mic}</span>}
              </>
            ) : r.connected ? (
              <>Your {r.device} is there, its microphone still off — click anywhere on the VerseFlow page on it once (and let the browser always allow the microphone for this site: then it comes on by itself).</>
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
            {r.mic && <span className="mt-0.5 block text-xs">🎙 Recording with: <b className="text-fg">{r.mic}</b></span>}
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
                <div
                  key={l.id}
                  id={`rec-${l.id}`}
                  className={`-mx-2 flex items-start gap-1 rounded-xl px-2 py-0.5 transition-colors ${isLive ? "bg-accent-soft font-semibold text-fg" : liveAt >= 0 && k < liveAt ? "text-muted" : "text-fg/90"}`}
                >
                  <div className="min-w-0 flex-1">
                  {isLive && r.clock && Number.isFinite(from) ? (
                    <Karaoke line={l} lang={tree.project.language} from={from} until={Math.min(Number.isFinite(next) ? next : from + bar, from + 2 * bar)} clock={r.clock} />
                  ) : untyped(marksFor(l)).length ? (
                    <MarkedText text={l.text.trim()} marks={marksFor(l)} />
                  ) : (
                    <FlowText text={l.text.trim()} lang={tree.project.language} flow={l.flow} beat={bar / 4} marks={marksFor(l)} />
                  )}
                  </div>
                  {/* notes on the line: how to sing or record it (hidden while recording) */}
                  {!recording && <NotesBadge count={notesOf(tree, l.id).length} onClick={() => setNotesFor(l.id)} always />}
                </div>
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
            {section && tree.takes.some((t) => t.section_id === section.id && t.chosen && t.lane !== "Flow") && (
              <button
                className="flex shrink-0 items-center gap-1 rounded-full bg-panel-2 px-3 py-2 text-sm font-semibold text-fg/80 disabled:opacity-40"
                disabled={!idle}
                onClick={() => setTiming({ part: section.id })}
                aria-label="Sync the part"
              >
                ⇄ Sync
              </button>
            )}
            <button
              className="flex shrink-0 items-center gap-1 rounded-full bg-panel-2 px-3 py-2 text-sm font-semibold text-fg/80"
              onClick={onMix}
              aria-label="Mixer"
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
                        {tree.takes.find((x) => x.id === t.id)?.note && <span className="truncate text-[11px] text-muted">· {tree.takes.find((x) => x.id === t.id)?.note}</span>}
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
                      {takeLines(t).length > 0 && (
                        <button
                          className="mt-1.5 flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent disabled:opacity-40"
                          disabled={!idle || syncing !== null}
                          onClick={() => void sync(t)}
                          title="Match the written lines to this take: every syllable gets the time you rapped it (karaoke + flow)"
                        >
                          {syncing === t.id ? "Syncing…" : `Sync words · ${takeLines(t).length} line${takeLines(t).length === 1 ? "" : "s"} · 1 call`}
                        </button>
                      )}
                      {synced[t.id] && <p className="mt-1 text-[11px] text-accent">{synced[t.id]}</p>}
                      {(() => {
                        const full = tree.takes.find((x) => x.id === t.id);
                        const cut = full && (full.trim_in > 0 || full.trim_out !== null);
                        return (
                          <button
                            className={`mt-1.5 ml-1.5 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold disabled:opacity-40 ${cut ? "bg-accent-soft text-accent" : "bg-panel-2 text-fg/80"}`}
                            disabled={!idle || !full}
                            onClick={() => setCutting(t.id)}
                            aria-label={`Cut take ${t.take_no} and set its volume`}
                          >
                            ✂ {cut ? `Cut · ${fmtTime((full!.trim_out ?? full!.duration) - full!.trim_in)}` : "Cut"} · {full && (full.gain ?? 1) !== 1 ? pct(full.gain) : "Volume"}
                          </button>
                        );
                      })()}
                      <button
                        className="mt-1.5 ml-1.5 inline-flex items-center gap-1 rounded-full bg-panel-2 px-2.5 py-1 text-[11px] font-semibold text-fg/80 disabled:opacity-40"
                        disabled={!idle}
                        onClick={() => setTiming({ takeId: t.id })}
                        aria-label={`Sync take ${t.take_no}`}
                      >
                        ⇄ Sync
                      </button>
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
      <div className="h-36" />

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
        </div>
        {/* the microphone: its level live, before and while recording — tap for its gain, hearing yourself… */}
        {r.settings && <MicStrip r={r} onOpen={() => setMicSheet(true)} />}
      </div>

      {r.note && <div className="fixed left-1/2 top-20 z-30 -translate-x-1/2 rounded-full bg-fg px-3.5 py-1.5 text-xs font-semibold text-bg shadow-lg">{r.note}</div>}

      {sheet && (
        <RecordSettings
          r={r}
          size={size}
          setSize={setSize}
          onClose={() => setSheet(false)}
          onMic={() => {
            setSheet(false);
            setMicSheet(true);
          }}
        />
      )}
      {micSheet && <MicSheet r={r} onClose={() => setMicSheet(false)} />}
      {notesFor &&
        (() => {
          const line = tree.sections.flatMap((x) => x.lines).find((x) => x.id === notesFor);
          return line ? <NotesSheet tree={tree} line={line} setTree={setTree} onClose={() => setNotesFor(null)} /> : null;
        })()}
      {timing && (
        <SyncSheet
          tree={tree}
          jobs={
            "part" in timing
              ? partJobs(tree, timing.part)
              : (() => {
                  const t = tree.takes.find((x) => x.id === timing.takeId);
                  if (!t) return [];
                  const lead = leadOf(tree, t.section_id);
                  return [{ take: t, mode: t.lane !== "Lead" && lead && lead.id !== t.id ? { to: "lead" } : { to: "beat", grid: 4, strength: 0.75 } } as SyncJob];
                })()
          }
          title={"part" in timing ? `Sync ${section?.name ?? "the part"}` : "Sync this take"}
          onDone={(t) => setTree(t)}
          onClose={() => setTiming(null)}
        />
      )}
      {cutting &&
        (() => {
          const full = tree.takes.find((x) => x.id === cutting);
          const rt = r.takes.find((x) => x.id === cutting);
          if (!full) return null;
          return (
            <TakeCut
              take={full}
              peaks={rt?.peaks ?? full.peaks ?? []}
              onSave={async (from, to) => {
                const res = await fetch(`/api/takes/${full.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ trim: { from, to } }) });
                if (res.ok) setTree((await res.json()) as ProjectTree);
              }}
              onPreview={(clip, gain) => r.previewTake(full.id, clip, gain)}
              onStop={() => r.stop()}
              playing={r.status === "playing" && r.playingTake === full.id}
              clock={r.clock}
              onGain={(g) => r.takeGain(full.id, g)}
              onSaveGain={async (gain) => {
                const res = await fetch(`/api/takes/${full.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ gain }) });
                if (res.ok) setTree((await res.json()) as ProjectTree);
              }}
              onClose={() => setCutting(null)}
            />
          );
        })()}
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
  const plain =
    sung && sung.length === parts.length
      ? sung
      : sung && sung.length > 1
        ? parts.map((_, i) => sung[0] + ((sung[sung.length - 1] - sung[0]) * i) / Math.max(1, parts.length - 1))
        : parts.map((_, i) => from + ((until - from) * i) / parts.length);
  // the writer's symbols move the syllables as Hear does (double-time faster, breaks leave a gap)
  const typed = untyped(marks).length ? null : slotsWithMarks({ times: plain, end: line.flow?.end ?? plain[plain.length - 1] + 0.3 }, line.text, lang, marks);
  const times = typed?.slots.times ?? plain;
  // with marks set in the editor (accent, up…): word by word (a word lights up with its first syllable), the marks stay in place
  if (untyped(marks).length) {
    const wordStart: number[] = [];
    parts.forEach((p, i) => {
      if (i === 0 || p.space) wordStart.push(times[i]);
    });
    return <MarkedText text={line.text.trim()} marks={marks} lit={(w) => now >= (wordStart[w] ?? Infinity) - 0.03} />;
  }
  // as it is sung: word groups, breaks, long notes — each syllable lighting up on its time
  return <FlowText text={line.text.trim()} lang={lang} flow={line.flow} marks={marks} lit={(i) => now >= (times[i] ?? Infinity) - 0.03} />;
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

function RecordSettings({ r, size, setSize, onClose, onMic }: { r: Recorder; size: keyof typeof SIZES; setSize: (s: keyof typeof SIZES) => void; onClose: () => void; onMic: () => void }) {
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
              <button className="flex w-full items-center gap-3 rounded-2xl bg-accent-soft px-4 py-3 text-left text-sm font-semibold text-accent" onClick={onMic}>
                <Mic className="h-4 w-4" />
                <span className="flex-1">Level, gain, hear yourself</span>
                <ChevronRight className="h-4 w-4" />
              </button>
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
              <div className="space-y-2.5 rounded-2xl bg-panel-2 px-4 py-3 text-sm">
                <p>
                  Delay {s.headphones ? "with headphones" : "without headphones"} <b className="font-mono">{s.latencyMs} ms</b>
                  <span className="block text-xs text-muted">
                    {s.calibrated ? "Set on this device — every take is moved by it." : "Estimated — set it once on this device: clap along."}
                    {` ${s.headphones ? "Without" : "With"} headphones: ${s.otherLatencyMs !== null ? `${s.otherLatencyMs} ms` : "not set yet"}.`}
                  </span>
                </p>
                <button
                  className="btn-primary w-full justify-center rounded-xl py-2.5 text-sm disabled:opacity-40"
                  disabled={r.status !== "idle"}
                  onClick={() => s.calibrate("claps")}
                >
                  {r.status === "calibrating" ? "Clap on each click…" : "Clap along · 4 clicks to count in, then clap 8"}
                </button>
                <p className="text-xs text-muted">
                  Clap (or say “ta”) right on each click, close to the microphone. Do it the way you record: {s.headphones ? "with" : "without"} headphones. The
                  delay is kept for that setting on this device — iPhone and Mac each have their own.
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <button className="text-muted underline disabled:opacity-40" disabled={r.status !== "idle"} onClick={() => s.calibrate("clicks")}>
                    Measure with clicks (headphones held to the mic)
                  </button>
                  {s.calibrated && (
                    <button className="text-muted underline" onClick={() => s.setLatencyMs(null)}>
                      Use the estimate again
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <p className="rounded-2xl bg-panel-2 px-4 py-3 text-sm text-muted">The microphone and the timing are set on your Mac (Record → Settings).</p>
        )}
        <a href="/settings" className="block text-center text-xs text-muted underline">
          All your settings (the same in every song): timing for each device, your voice, appearance
        </a>
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

/**
 * Cut a take: where it starts and ends (the rest stays in the recording: a cut can be undone or moved). The
 * waveform shows what plays; the outside is dimmed.
 */
function TakeCut(props: {
  take: { id: string; take_no: number; lane: string; duration: number; start_at: number; trim_in: number; trim_out: number | null; gain: number };
  peaks: number[];
  onSave: (from: number, to: number | null) => Promise<void>;
  /** hear the whole recording (null) or the cut as set now (saved or not) */
  onPreview: (clip: { from: number; to: number | null } | null, gain: number) => void;
  onStop: () => void;
  playing: boolean;
  /** the song position being heard (on this device) */
  clock: (() => number) | null;
  /** the volume, heard at once */
  onGain: (gain: number) => void;
  onSaveGain: (gain: number) => Promise<void>;
  onClose: () => void;
}) {
  const d = props.take.duration;
  const [from, setFrom] = useState(props.take.trim_in);
  const [to, setTo] = useState(props.take.trim_out ?? d);
  const [gain, setGain] = useState(props.take.gain ?? 1);
  const [busy, setBusy] = useState(false);
  /** what is playing: the whole take or the cut */
  const [hearing, setHearing] = useState<"whole" | "cut" | null>(null);
  const changed = Math.abs(from - props.take.trim_in) > 0.005 || Math.abs(to - (props.take.trim_out ?? d)) > 0.005;
  const gainChanged = Math.abs(gain - (props.take.gain ?? 1)) > 0.005;
  const save = async (a: number, b: number) => {
    setBusy(true);
    try {
      await props.onSave(a, b >= d - 0.01 ? null : b);
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    setBusy(true);
    try {
      if (changed) await props.onSave(from, to >= d - 0.01 ? null : to);
      if (gainChanged) await props.onSaveGain(gain);
    } finally {
      setBusy(false);
    }
    props.onClose();
  };
  const hear = (what: "whole" | "cut") => {
    if (props.playing && hearing === what) {
      setHearing(null);
      return props.onStop();
    }
    setHearing(what);
    props.onPreview(what === "whole" ? { from: 0, to: null } : { from, to: to >= d - 0.01 ? null : to }, gain);
  };
  const now = props.playing ? hearing : null;
  // where it is in the recording (a line over the waveform)
  const [head, setHead] = useState<number | null>(null);
  const { clock, playing } = props;
  const start = props.take.start_at;
  useEffect(() => {
    if (!playing || !clock) return;
    let id = requestAnimationFrame(function loop() {
      setHead(clock() - start);
      id = requestAnimationFrame(loop);
    });
    return () => {
      cancelAnimationFrame(id);
      setHead(null);
    };
  }, [playing, clock, start]);
  const n = 120;
  const step = Math.max(1, props.peaks.length / n);
  const bars = Array.from({ length: Math.min(n, props.peaks.length) }, (_, i) => props.peaks[Math.floor(i * step)] ?? 0);
  const at = (t: number) => `${(t / Math.max(0.01, d)) * 100}%`;
  const heardBtn = (what: "whole" | "cut", label: string) => (
    <button
      className={`btn flex-1 justify-center rounded-2xl border-0 py-3 text-sm disabled:opacity-50 ${now === what ? "bg-accent text-white" : "bg-panel-2"}`}
      disabled={busy}
      onClick={() => hear(what)}
      aria-pressed={now === what}
    >
      {now === what ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />} {now === what ? "Stop" : label}
    </button>
  );
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={() => !busy && props.onClose()}>
      <div onClick={(e) => e.stopPropagation()} className="max-h-[92dvh] w-full max-w-lg space-y-4 overflow-auto rounded-t-3xl bg-panel px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
        <div>
          <h2 className="text-xl font-bold">
            {props.take.lane} take {props.take.take_no}
          </h2>
          <p className="text-xs text-muted">
            Cut {fmtTime(from)} – {fmtTime(to)} · {Math.round((to - from) * 10) / 10} s of {Math.round(d * 10) / 10} s. The rest stays in the recording.
          </p>
        </div>
        <div className="relative h-16 overflow-hidden rounded-xl bg-panel-2">
          <svg viewBox={`0 0 ${bars.length * 3} 20`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full text-accent" aria-hidden>
            {bars.map((v, i) => (
              <rect key={i} x={i * 3} y={10 - Math.max(0.5, v * 9)} width={2} height={Math.max(1, v * 18)} fill="currentColor" />
            ))}
          </svg>
          <div className="absolute inset-y-0 left-0 bg-bg/70" style={{ width: at(from) }} />
          <div className="absolute inset-y-0 right-0 bg-bg/70" style={{ width: `calc(100% - ${at(to)})` }} />
          <div className="absolute inset-y-0 w-0.5 bg-fg" style={{ left: at(from) }} />
          <div className="absolute inset-y-0 w-0.5 bg-fg" style={{ left: `calc(${at(to)} - 2px)` }} />
          {head !== null && head >= 0 && head <= d && <div className="absolute inset-y-0 w-0.5 bg-[#dc2626]" style={{ left: at(head) }} />}
        </div>
        <label className="block space-y-1 text-sm">
          <span className="flex justify-between">
            <span className="font-semibold">Start</span>
            <span className="font-mono text-xs text-muted">{from.toFixed(2)} s</span>
          </span>
          <input type="range" className="w-full accent-[var(--accent)]" min={0} max={d} step={0.01} value={from} onChange={(e) => setFrom(Math.min(Number(e.target.value), to - 0.2))} aria-label="Start of the cut" />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="flex justify-between">
            <span className="font-semibold">End</span>
            <span className="font-mono text-xs text-muted">{to.toFixed(2)} s</span>
          </span>
          <input type="range" className="w-full accent-[var(--accent)]" min={0} max={d} step={0.01} value={to} onChange={(e) => setTo(Math.max(Number(e.target.value), from + 0.2))} aria-label="End of the cut" />
        </label>
        <div className="flex gap-2">
          {heardBtn("whole", "Whole take")}
          {heardBtn("cut", "The cut")}
        </div>
        <div className="rounded-2xl bg-panel-2/70 px-4 py-3">
          <p className="text-sm font-semibold">Volume of this take</p>
          <VolumeSlider
            value={gain}
            max={TAKE_MAX}
            label={`Take ${props.take.take_no}`}
            onValue={(v) => {
              setGain(v);
              props.onGain(v);
            }}
          />
          {/* a quiet take: as loud as it can be without clipping */}
          {louderGain(props.peaks) !== null && Math.abs((louderGain(props.peaks) ?? 1) - gain) > 0.05 && (
            <button
              className="mt-1 flex items-center gap-1 rounded-full bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent"
              onClick={() => {
                const g = louderGain(props.peaks)!;
                setGain(g);
                props.onGain(g);
              }}
            >
              <Wand className="h-3.5 w-3.5" /> {louderGain(props.peaks)! > gain ? "Louder" : "Softer"} · as loud as it can be ({pct(louderGain(props.peaks)!)})
            </button>
          )}
          <p className="text-[11px] text-muted">The whole {props.take.lane} layer: the Mixer.</p>
        </div>
        <button className="btn-primary w-full justify-center rounded-2xl py-3 text-sm disabled:opacity-50" disabled={busy} onClick={() => void finish()}>
          <Check className="h-4 w-4" /> {changed || gainChanged ? "Save" : "Done"}
        </button>
        {(props.take.trim_in > 0 || props.take.trim_out !== null) && (
          <button
            className="w-full text-center text-xs text-muted underline"
            disabled={busy}
            onClick={async () => {
              setFrom(0);
              setTo(d);
              await save(0, d);
            }}
          >
            The whole take again
          </button>
        )}
      </div>
    </div>
  );
}

/** a level in dB (−60 … 0) */
const dbOf = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const meterAt = (v: number) => Math.max(0, Math.min(1, (dbOf(v) + 60) / 60));

/**
 * The input level as a studio meter: in dB, green up to −12, yellow to −3, red above; the loudest of the last
 * moment stays a while (peak hold), and a clip lights up red.
 */
function Meter({ level, hold, clipped, big }: { level: number; hold: number; clipped: boolean; big?: boolean }) {
  const w = meterAt(level) * 100;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className={`relative flex-1 overflow-hidden rounded-full bg-panel-2 ${big ? "h-3.5" : "h-2"}`}>
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${w}%`, background: "linear-gradient(to right, var(--ok) 0%, var(--ok) 79%, #eab308 80%, #eab308 94%, var(--bad) 95%)", backgroundSize: `${(100 / Math.max(1, w)) * 100}% 100%` }}
        />
        <div className="absolute inset-y-0 w-0.5 bg-fg/80" style={{ left: `${meterAt(hold) * 100}%` }} />
        {/* −12 and −6 dB */}
        <div className="absolute inset-y-0 w-px bg-fg/20" style={{ left: "80%" }} />
        <div className="absolute inset-y-0 w-px bg-fg/20" style={{ left: "90%" }} />
      </div>
      <span className={`shrink-0 whitespace-nowrap text-right font-mono tabular-nums ${big ? "w-16 text-sm" : "w-12 text-[10px]"} ${clipped ? "font-bold text-bad" : "text-muted"}`}>
        {clipped ? "CLIP" : Number.isFinite(dbOf(hold)) ? `${Math.round(dbOf(hold))} dB` : "–∞"}
      </span>
    </div>
  );
}

function MicStrip({ r, onOpen }: { r: Recorder; onOpen: () => void }) {
  const s = r.settings!;
  if (!r.armed)
    return (
      <div className="flex justify-center px-6 pb-1">
        <button className="flex items-center gap-1.5 rounded-full bg-panel-2 px-3 py-1.5 text-xs font-semibold text-fg/80" onClick={r.arm}>
          <Mic className="h-3.5 w-3.5 text-accent" /> Check the microphone
        </button>
      </div>
    );
  return (
    <button className="flex w-full items-center gap-2 px-6 pb-1.5 text-left" onClick={onOpen} aria-label="Microphone: level, gain, hear yourself">
      <Mic className="h-3.5 w-3.5 shrink-0 text-accent" />
      <Meter level={r.level} hold={r.meter.hold} clipped={r.meter.clip} />
      <span className="shrink-0 rounded-full bg-panel-2 px-2 py-0.5 font-mono text-[10px] font-semibold text-fg/80">
        {s.gainDb > 0 ? "+" : ""}
        {s.gainDb} dB
      </span>
      {s.monitor && s.headphones && <Headphones className="h-3.5 w-3.5 shrink-0 text-accent" />}
    </button>
  );
}

/** the microphone: which one, its level, its gain (auto: sing 5 s), hearing yourself */
function MicSheet({ r, onClose }: { r: Recorder; onClose: () => void }) {
  const s = r.settings!;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="max-h-[92dvh] w-full max-w-lg space-y-4 overflow-auto rounded-t-3xl bg-panel px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
        <div>
          <h2 className="text-xl font-bold">Microphone</h2>
          <p className="truncate text-xs text-muted">{r.mic ?? "not on yet"}</p>
        </div>
        {!r.armed ? (
          <button className="btn-primary w-full justify-center rounded-2xl py-3" onClick={r.arm}>
            <Mic className="h-4 w-4" /> Switch the microphone on
          </button>
        ) : (
          <>
            <div className="space-y-1.5">
              <p className="label">Level</p>
              <Meter level={r.level} hold={r.meter.hold} clipped={r.meter.clip} big />
              <p className="text-[11px] text-muted">Sing your loudest: the bar should reach the yellow (about −6 dB), never the red.</p>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <p className="label">Gain</p>
                <button className="font-mono text-sm font-semibold text-accent" onClick={() => s.setGainDb(0)} aria-label="Gain back to 0 dB">
                  {s.gainDb > 0 ? "+" : ""}
                  {s.gainDb} dB
                </button>
              </div>
              <input
                type="range"
                min={GAIN_MIN}
                max={GAIN_MAX}
                step={0.5}
                value={s.gainDb}
                onChange={(e) => s.setGainDb(Number(e.target.value))}
                className="vf-volume w-full"
                aria-label="Microphone gain"
                style={{ ["--fill" as string]: `${((s.gainDb - GAIN_MIN) / (GAIN_MAX - GAIN_MIN)) * 100}%` }}
              />
              <button className="btn w-full justify-center rounded-2xl border-0 bg-panel-2 py-3 text-sm disabled:opacity-60" disabled={s.leveling !== null || r.status !== "idle"} onClick={s.autoLevel}>
                <Wand className="h-4 w-4" />
                {s.leveling !== null ? `Listening… sing your loudest · ${s.leveling}` : "Auto level · sing your loudest for 5 s"}
              </button>
              {s.levelNote && <p className="rounded-xl bg-panel-2 px-3 py-2 text-sm">{s.levelNote}</p>}
              <p className="text-[11px] text-muted">Kept for this microphone on this device. A browser can&apos;t turn the microphone itself up — this makes its sound louder before it is recorded.</p>
            </div>
          </>
        )}
        <div className="space-y-2.5">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              I wear headphones
              <span className="block text-xs text-muted">{s.headphones ? "Clean takes, no processing." : "The beat from the speaker is filtered out of the take (with a USB microphone, this can silence it)."}</span>
            </span>
            <Toggle on={s.headphones} onChange={s.setHeadphones} />
          </label>
          <label className={`flex items-center justify-between gap-3 text-sm ${s.headphones ? "" : "opacity-50"}`}>
            <span>
              Hear myself
              <span className="block text-xs text-muted">
                {s.headphones
                  ? "Your voice in the headphones while you sing — with a slight delay from the browser. Your microphone's own headphone output (if it has one) has none."
                  : "Only with headphones (from a speaker it would feed back)."}
              </span>
            </span>
            <Toggle on={s.monitor && s.headphones} onChange={(on) => s.headphones && s.setMonitor(on)} />
          </label>
          {s.monitor && s.headphones && (
            <p className={`rounded-xl px-3 py-2 text-xs ${s.monitorDelayMs !== null && s.monitorDelayMs > 40 ? "bg-warn-soft text-warn" : "bg-panel-2 text-muted"}`}>
              {s.monitorDelayMs === null
                ? "This device doesn't say how late you hear yourself."
                : `You hear yourself about ${s.monitorDelayMs} ms late.`}{" "}
              {(s.monitorDelayMs === null || s.monitorDelayMs > 40) &&
                "Above ~30 ms it's hard to sing with: Bluetooth headphones (AirPods) add 150–300 ms — use wired headphones, best plugged into the microphone itself (no delay at all) — and turn this off. "}
              The timing setting (Clap along) puts your takes on the beat; it can&apos;t make what you hear while singing any earlier.
            </p>
          )}
        </div>
        <button className="btn-primary w-full justify-center rounded-2xl py-3" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * Takes in time: each one onto the beat (its syllables pulled onto the grid) or following the part's Lead
 * (a double, ad-libs: syllable by syllable). Every take synced becomes a new take — the one it came from stays.
 */
function SyncSheet({ tree, jobs: initial, title, onDone, onClose }: { tree: ProjectTree; jobs: SyncJob[]; title: string; onDone: (t: ProjectTree) => void; onClose: () => void }) {
  const [jobs, setJobs] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const seg = (on: boolean) => `flex-1 rounded-full px-2 py-1.5 text-xs font-semibold ${on ? "bg-panel text-fg shadow-sm" : "text-muted"}`;
  const set = (i: number, mode: SyncMode) => setJobs(jobs.map((j, k) => (k === i ? { ...j, mode } : j)));
  const beat = jobs.find((j) => j.mode.to === "beat")?.mode as Extract<SyncMode, { to: "beat" }> | undefined;
  const setBeat = (patch: Partial<Extract<SyncMode, { to: "beat" }>>) => setJobs(jobs.map((j) => (j.mode.to === "beat" ? { ...j, mode: { ...j.mode, ...patch } } : j)));
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={() => !busy && onClose()}>
      <div onClick={(e) => e.stopPropagation()} className="max-h-[92dvh] w-full max-w-lg space-y-4 overflow-auto rounded-t-3xl bg-panel px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
        <div>
          <h2 className="text-xl font-bold">{title}</h2>
          <p className="text-xs text-muted">Each take synced becomes a new take (pitch kept) — the one it came from stays, to choose again. No AI call.</p>
        </div>
        {!jobs.length && <p className="text-sm text-muted">No take to sync here yet.</p>}
        <div className="space-y-2">
          {jobs.map((j, i) => {
            const lead = leadOf(tree, j.take.section_id);
            const canFollow = j.take.lane !== "Lead" && !!lead && lead.id !== j.take.id;
            return (
              <div key={j.take.id} className="rounded-2xl bg-panel-2/70 px-3.5 py-2.5">
                <p className="text-sm font-semibold">
                  {j.take.lane} · take {j.take.take_no}
                </p>
                <div className="mt-1.5 flex rounded-full bg-panel-2 p-1">
                  <button className={seg(j.mode.to === "beat")} onClick={() => set(i, { to: "beat", grid: beat?.grid ?? 4, strength: beat?.strength ?? 0.75 })}>
                    On the beat
                  </button>
                  <button className={seg(j.mode.to === "lead")} disabled={!canFollow} onClick={() => canFollow && set(i, { to: "lead" })}>
                    {canFollow ? `Follow Lead ${lead!.take_no}` : "Follow the Lead"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {beat && (
          <div className="space-y-2">
            <p className="label">On the beat</p>
            <div className="flex items-center gap-2 text-xs">
              <span className="w-16 text-muted">Grid</span>
              <div className="flex flex-1 rounded-full bg-panel-2 p-1">
                <button className={seg(beat.grid === 4)} onClick={() => setBeat({ grid: 4 })}>
                  1/16
                </button>
                <button className={seg(beat.grid === 2)} onClick={() => setBeat({ grid: 2 })}>
                  1/8
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="w-16 text-muted">Strength</span>
              <div className="flex flex-1 rounded-full bg-panel-2 p-1">
                {[0.5, 0.75, 1].map((v) => (
                  <button key={v} className={seg(beat.strength === v)} onClick={() => setBeat({ strength: v })}>
                    {v === 1 ? "Tight" : v === 0.75 ? "Natural" : "Light"} · {v * 100}%
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-muted">Each syllable moves that part of the way to the nearest {beat.grid === 4 ? "16th" : "8th"} — 100% is exactly on it, less keeps some of your feel.</p>
          </div>
        )}
        {jobs.some((j) => j.mode.to === "lead") && <p className="text-[11px] text-muted">Follow the Lead: the take is stretched and squeezed so each syllable lands on the Lead&apos;s — for doubles and ad-libs that say the same words.</p>}
        {err && <p className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad">{err}</p>}
        {result ? (
          <>
            <div className="rounded-xl bg-ok-soft px-3 py-2 text-sm text-ok">
              <p className="font-semibold">In time — the new takes play now.</p>
              {result.map((x) => (
                <p key={x} className="text-xs">
                  {x}
                </p>
              ))}
            </div>
            <button className="btn-primary w-full justify-center rounded-2xl py-3" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <button
            className="btn-primary w-full justify-center rounded-2xl py-3 disabled:opacity-60"
            disabled={!!busy || !jobs.length}
            onClick={async () => {
              setErr(null);
              setBusy("Starting…");
              try {
                const r = await syncTakes(tree, jobs, setBusy);
                onDone(r.tree);
                setResult(r.done);
              } catch (e) {
                setErr(e instanceof Error ? e.message : "Syncing failed.");
              } finally {
                setBusy(null);
              }
            }}
          >
            ⇄ {busy ?? `Sync ${jobs.length} take${jobs.length === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
    </div>
  );
}
