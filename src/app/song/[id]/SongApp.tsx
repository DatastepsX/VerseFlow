"use client";

import { FlowText } from "@/components/FlowText";
import type { LyricsBrief } from "@/lib/brief";
import { deviceKind, isHandheld } from "@/lib/client/profile";
import type { RemoteCmd } from "@/lib/studio/remote";
import { NAV_EVENT, postNav, type NavDetail } from "@/components/RemoteFollow";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtTime } from "@/lib/audio/song-map";
import { buildTimeline, positionIn } from "@/lib/audio/timeline";
import { extendBuffers } from "@/lib/audio/arrange";
import { BEAT_ACCEPT, MAX_BEAT_BYTES, uploadBeat } from "@/lib/client/beat";
import { dropSounds } from "@/lib/flow/fillers";
import { chunkLines, processFlow, processTaps, processVocals, saveFlowTake, type FlowStep } from "@/lib/flow/pipeline";
import { stressPattern } from "@/lib/flow/lines";
import { prosody } from "@/lib/rhyme/prosody";
import { StudioEngine, type PlayLayer } from "@/lib/studio/engine";
import { detectSyllables } from "@/lib/flow/syllables";
import { guideLayers, spokenIds } from "@/lib/voice/client";
import { LANGUAGES, type Line, type ProjectTree } from "@/lib/types";
import { followTo } from "@/components/writer/follow";
import { download, fullText } from "@/components/writer/util";
import { VoiceSheet, type VoiceInfo } from "./VoiceSheet";
import { RecordView } from "./Record";
import { Mixer, type ExportOptions } from "./Mixer";
import { exportStems as exportStemsZip, type Stem } from "@/lib/studio/export";
import { MarkedText, MarksEditor } from "@/components/Marks";
import { marksFor, type Mark } from "@/lib/marks";
import { NOTATION_KEYS, parseNotation, toNotation, untyped } from "@/lib/flow/notation";
import { lanesOf, usePref } from "./recorder";
import { buildChain } from "@/lib/fx/chain";
import { layerPreset } from "@/lib/fx/presets";
import { channelOf, clipOf, laneBus, mixPans, mixVolumes, withChannel, type ChannelPatch } from "@/lib/studio/mix";
import { undoHeaders, undoStep } from "@/lib/undo-group";
import { TapFlow } from "./TapFlow";
import { FlowSheet, type SheetAudio } from "./FlowSheet";
import { exampleWords } from "@/lib/flow/example";
import { coupletsOf } from "@/lib/flow/couplets";
import { analyzeLine, compareLines } from "@/lib/rhyme/analyze";
import { gridFor, type BeatGrid, type FlowGridModel } from "@/lib/flow/grid";
import {
  AudioLines,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  Hand,
  LineBreak,
  Headphones,
  Lyrics,
  Mic,
  Music,
  Pause,
  Pencil,
  Play,
  Plus,
  Shuffle,
  Sliders,
  Sparkles,
  Trash,
  Redo,
  Restart,
  Undo,
  User,
  Waveform,
} from "@/components/icons";

export type View = "flow" | "lyrics" | "record" | "mix" | "more";
type LyricLine = Line & { alternatives: ProjectTree["sections"][number]["lines"][number]["alternatives"] };

const STEPS: { key: FlowStep; label: string }[] = [
  { key: "rhythm", label: "Finding your rhythm" },
  { key: "upload", label: "Saving your flow" },
  { key: "words", label: "Recognising your words" },
  { key: "song", label: "Laying out the song" },
  { key: "suggest", label: "Writing lyrics for every bar" },
];
const TAP_STEPS: { key: FlowStep; label: string }[] = [
  { key: "song", label: "Laying out your lines" },
  { key: "suggest", label: "Writing lyrics for every line" },
];
const VOCAL_STEPS: { key: FlowStep; label: string }[] = [
  { key: "words", label: "Listening for lyrics in your song" },
  { key: "song", label: "Finding the flow of every line" },
  { key: "suggest", label: "Writing 3 alternatives per line" },
];

/**
 * The app: upload a beat → record your flow (sing or rap anything over it)
 * → a first version of the lyrics, written to your rhythm and your words →
 * go through it bar by bar: keep, next option, new options, edit, remove.
 */
export function SongApp({
  initialTree,
  autoDetect = false,
  initialView,
  recordOn,
}: {
  initialTree: ProjectTree;
  autoDetect?: boolean;
  initialView?: View;
  /** ?on=mac: Record opens as the remote for the Mac */
  recordOn?: "here" | "mac";
}) {
  const router = useRouter();
  const [tree, setTree] = useState(initialTree);
  const pid = tree.project.id;
  // the song open on another device (the Mac, the phone) changed: this one follows within a few seconds
  const seenVersion = useRef<string | null>(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      const r = (await fetch(`/api/projects/${pid}/version`, { cache: "no-store" })
        .then((x) => (x.ok ? x.json() : null))
        .catch(() => null)) as { v: string } | null;
      if (!r || stop) return;
      if (seenVersion.current !== null && r.v !== seenVersion.current) {
        const t = (await fetch(`/api/projects/${pid}`, { cache: "no-store" })
          .then((x) => (x.ok ? x.json() : null))
          .catch(() => null)) as ProjectTree | null;
        if (!t?.project || stop) return;
        setTree(t);
      }
      seenVersion.current = r.v;
    };
    void tick();
    const id = setInterval(() => void tick(), 3000);
    const onShow = () => void tick();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      stop = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [pid]);
  const lang = tree.project.language;
  const lyricLines = tree.sections.flatMap((s) => s.lines.filter((l) => l.kind === "lyric"));
  const hasLines = lyricLines.length > 0;
  // your recorded flows: the whole song's, and the ones recorded for single parts (while the part exists)
  const sectionIds = new Set(tree.sections.map((s) => s.id));
  const wholeFlow = [...tree.takes].reverse().find((t) => t.lane === "Flow" && t.chosen && !t.section_id) ?? null;
  const flowTakes = [...(wholeFlow ? [wholeFlow] : []), ...tree.takes.filter((t) => t.lane === "Flow" && t.chosen && t.section_id && sectionIds.has(t.section_id))];
  const [view, setView] = useState<View>(initialView ?? (hasLines ? "lyrics" : "flow"));
  // the main device — where you record and play: this phone, or your Mac with the phone as its remote
  const [mainDevice] = usePref<"phone" | "mac">("vf.studio.main", "phone");
  const handheld = isHandheld();
  /** this phone drives the Mac: what it shows and what it plays happen there */
  const controller = mainDevice === "mac" && handheld;
  /** this Mac follows the phone */
  const remoteHost = mainDevice === "mac" && !handheld;
  const sendRemote = (cmd: RemoteCmd) =>
    void fetch(`/api/projects/${pid}/remote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd }) }).catch(() => {});
  /** the phone shows "playing" while the Mac plays what it asked for */
  const remoteEnd = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playOnMac = (cmd: Extract<RemoteCmd, { t: "songPlay" }>) => {
    sendRemote(cmd);
    setPlaying(true);
    if (remoteEnd.current) clearTimeout(remoteEnd.current);
    remoteEnd.current = setTimeout(() => setPlaying(false), Math.min(600, Math.max(2, (cmd.until ?? cmd.from + 30) - cmd.from)) * 1000);
    // can the Mac play it? (it is open, and its sound is allowed)
    setTimeout(() => {
      void fetch("/api/remote/nav", { cache: "no-store" })
        .then((r) => r.json())
        .then((r: { host: { sound: string; at: number } | null; now: number }) => {
          if (!r.host || r.now - r.host.at > 45_000) setError("Your Mac doesn't answer — open VerseFlow in the browser on your Mac (any page), then press Play again.");
          else if (r.host.sound === "locked") setError("On your Mac, click once anywhere on the VerseFlow page to allow sound — it starts playing then.");
        })
        .catch(() => {});
    }, 1200);
  };
  /** a take is being recorded on this device: the tabs wait */
  const [recBusy, setRecBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = async (path: string, body?: unknown, method = "POST") => {
    const res = await fetch(path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...undoHeaders() },
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
  const flowBufs = useRef(new Map<string, AudioBuffer>());
  const [beatReady, setBeatReady] = useState(false);
  useEffect(() => {
    const e = new StudioEngine();
    engine.current = e;
    return () => e.close();
  }, []);
  const filename = tree.audio?.filename;
  // the song, and the song without its vocals (when removed): what plays is the music alone unless you want the vocals
  const instrumental = tree.audio?.instrumental_path ?? null;
  // where the original vocals are out: the whole song (default), none, or chosen parts — saved with the song
  const vocalsOff = tree.project.settings?.vocalsOff ?? "all";
  const offRanges =
    vocalsOff === "all"
      ? [{ start: 0, end: Infinity }]
      : tree.sections
          .filter((x) => vocalsOff.includes(x.id))
          .map((x) => {
            const i = tree.sections.indexOf(x);
            const start = x.audio_start ?? x.lines.find((l) => l.kind === "lyric")?.audio_at ?? 0;
            const end = tree.sections.slice(i + 1).find((y) => y.audio_start !== null)?.audio_start ?? Infinity;
            return { start, end };
          });
  const offKey = JSON.stringify(offRanges);
  // parts made longer: bars added to the song as it loads
  const extKey = JSON.stringify(tree.project.settings?.extensions ?? []);
  const songBufs = useRef<{ full: AudioBuffer | null; music: AudioBuffer | null }>({ full: null, music: null });
  const [bufsLoaded, setBufsLoaded] = useState(0);
  useEffect(() => {
    const e = engine.current;
    const loaded = songBufs.current;
    const { full, music } = loaded.full && e ? extendBuffers(e.ctx, loaded.full, loaded.music, JSON.parse(extKey)) : loaded;
    beat.current = full && music && e ? withoutVocals(e.ctx, full, music, JSON.parse(offKey)) : full;
  }, [offKey, extKey, bufsLoaded]);
  const setVocalsOff = (v: "all" | string[]) => void call(`/api/projects/${pid}`, { settings: { ...(tree.project.settings ?? {}), vocalsOff: v } }, "PATCH");
  useEffect(() => {
    if (!filename) return;
    let cancelled = false;
    (async () => {
      try {
        const { url, instrumentalUrl } = (await fetch(`/api/projects/${pid}/audio`).then((r) => r.json())) as { url: string | null; instrumentalUrl: string | null };
        if (!url || cancelled) return;
        const [buf, music] = await Promise.all([
          engine.current!.decode(await fetch(url).then((r) => r.arrayBuffer())),
          instrumentalUrl ? fetch(instrumentalUrl).then((r) => r.arrayBuffer()).then((d) => engine.current!.decode(d)) : null,
        ]);
        if (!cancelled) {
          songBufs.current = { full: buf, music };
          setBufsLoaded((n) => n + 1);
          setBeatReady(true);
        }
      } catch {
        if (!cancelled) setError("Could not load the beat.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filename, pid, instrumental]);
  /** the song without its vocals: 1 ElevenLabs call */
  const [separating, setSeparating] = useState(false);
  const separate = async () => {
    if (!window.confirm("Remove the vocals from the song? The song stays as uploaded; the music without vocals is added. · 1 call (ElevenLabs)")) return false;
    stopPlay();
    setSeparating(true);
    try {
      return !!(await call(`/api/projects/${pid}/audio`, { action: "separate" }));
    } finally {
      setSeparating(false);
    }
  };
  /** the original vocals in one part: off (the music alone) or on */
  const partVocalsOff = (id: string) => !!instrumental && (vocalsOff === "all" || vocalsOff.includes(id));
  const togglePartVocals = async (id: string) => {
    const ids = tree.sections.map((x) => x.id);
    // not split yet: split once (1 call), then the vocals are out of this part only
    if (!instrumental) {
      if (await separate()) setVocalsOff([id]);
      return;
    }
    const cur = vocalsOff === "all" ? ids : vocalsOff;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    setVocalsOff(ids.every((x) => next.includes(x)) ? "all" : next);
  };

  const loadFlow = async () => {
    const todo = flowTakes.filter((t) => !flowBufs.current.has(t.id));
    if (!todo.length) return;
    const r = (await fetch(`/api/projects/${pid}/takes?ids=${todo.map((t) => t.id).join(",")}`).then((x) => x.json())) as { urls: Record<string, string> };
    await Promise.all(
      todo.map(async (t) => {
        const u = r.urls?.[t.id];
        if (u) flowBufs.current.set(t.id, await engine.current!.decode(await fetch(u).then((x) => x.arrayBuffer())));
      }),
    );
  };

  // ---------- playback with the lyrics following ----------
  const timeline = useMemo(() => buildTimeline(tree.sections, tree.audio, lang), [tree.sections, tree.audio, lang]);
  const [playing, setPlaying] = useState(false);
  // your recorded flow plays along (turned down or muted in the mixer)
  const withFlow = true;
  /** the mixer (kept with the song: the phone mixes what the Mac plays) — each channel's volume, pan, mute, solo */
  const muted = lanesOf(tree).filter((l) => channelOf(tree.project.settings, laneBus(l)).mute);
  // a channel changed: heard at once (the engine follows the song's settings), saved a moment later
  const mixSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const treeRef = useRef(tree);
  useEffect(() => {
    treeRef.current = tree;
  });
  const setChannel = (key: string, patch: ChannelPatch) => {
    const t = treeRef.current;
    const settings = withChannel(t.project.settings, key, patch);
    const next = { ...t, project: { ...t.project, settings } };
    treeRef.current = next;
    setTree(next);
    if (mixSave.current) clearTimeout(mixSave.current);
    mixSave.current = setTimeout(() => void call(`/api/projects/${pid}`, { settings: treeRef.current.project.settings }, "PATCH"), 450);
  };
  // the engine's channels follow the mixer (live, also while it plays)
  const mixKey = JSON.stringify([mixVolumes(tree.project.settings, lanesOf(tree)), mixPans(tree.project.settings, lanesOf(tree))]);
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    const [vols, pans] = JSON.parse(mixKey) as Record<string, number>[];
    for (const [k, v] of Object.entries(vols)) e.setVolume(k, v);
    for (const [k, v] of Object.entries(pans)) e.setPan(k, v);
  }, [mixKey]);
  /** the takes used in the song, each on its layer's channel (an off layer plays silent: turning it on is live), with their sound (as in Record; autotune only there) */
  const takeLayers = async (): Promise<PlayLayer[]> => {
    const lanes = lanesOf(tree);
    const takes = tree.takes.filter((t) => t.chosen && lanes.includes(t.lane));
    const todo = takes.filter((t) => !flowBufs.current.has(t.id));
    if (todo.length) {
      const r = (await fetch(`/api/projects/${pid}/takes?ids=${todo.map((t) => t.id).join(",")}`).then((x) => x.json())) as { urls: Record<string, string> };
      await Promise.all(todo.map(async (t) => r.urls?.[t.id] && flowBufs.current.set(t.id, await engine.current!.decode(await fetch(r.urls[t.id]).then((x) => x.arrayBuffer())))));
    }
    const bpm = tree.audio?.bpm ?? 90;
    return takes.flatMap((t) => {
      const buffer = flowBufs.current.get(t.id);
      const p = layerPreset(tree.project.settings?.fx, t.lane);
      return buffer
        ? [{ buffer, at: t.start_at, gain: t.gain ?? 1, pan: t.pan ?? 0, bus: laneBus(t.lane), id: t.id, fx: p.id === "raw" ? undefined : (ctx: BaseAudioContext) => buildChain(ctx, p, bpm), clip: clipOf(t) }]
        : [];
    });
  };
  const [now, setNow] = useState(0);
  const [live, setLive] = useState<string | null>(null);
  const stopAt = useRef<number | null>(null);
  /** a flow is being tapped: the lyrics don't scroll along */
  const tappingRef = useRef(false);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const e = engine.current;
      if (!e) return;
      const p = e.position();
      setNow(p);
      // the line being heard (the output's delay taken off)
      const pos = positionIn(timeline, p - ((e.ctx as AudioContext & { outputLatency?: number }).outputLatency || e.ctx.baseLatency || 0));
      const sec = pos ? tree.sections.find((s) => s.id === pos.sectionId) : null;
      const line = sec && pos?.lineIndex !== null && pos?.lineIndex !== undefined ? sec.lines[pos.lineIndex] : null;
      setLive((prev) => {
        const next = line?.id ?? null;
        if (next && next !== prev && !tappingRef.current) followTo(document.getElementById(`line-${next}`));
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

  // ---------- your voice (the guide vocal: the lyrics rapped in your cloned voice, on your flow) ----------
  const [voice, setVoice] = useState<VoiceInfo | null | undefined>(undefined);
  const [voiceSheet, setVoiceSheet] = useState(false);
  const [withGuide, setWithGuide] = useState(false);
  const [guideBusy, setGuideBusy] = useState<string | null>(null);
  const [spoken, setSpoken] = useState<Set<string>>(new Set());
  useEffect(() => {
    fetch("/api/voice")
      .then((r) => r.json())
      .then((d: { voice?: VoiceInfo | null }) => setVoice(d.voice ?? null), () => setVoice(null));
  }, []);
  const textsKey = lyricLines.map((l) => l.id + l.text).join("|");
  useEffect(() => {
    if (!voice || !textsKey) return;
    spokenIds(pid, tree).then((ids) => setSpoken(new Set(ids)), () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the texts or the voice change
  }, [voice, textsKey, pid]);
  const unspoken = lyricLines.filter((l) => l.text.trim() && !spoken.has(l.id));
  const guide = async (ids: string[], busy: string) => {
    const e = engine.current;
    if (!e) return null;
    setGuideBusy(busy);
    try {
      const layers = await guideLayers(pid, tree, ids, e.ctx);
      setSpoken((prev) => new Set([...prev, ...ids]));
      return layers;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your voice could not speak the lyrics");
      return null;
    } finally {
      setGuideBusy(null);
    }
  };
  const hearLine = async (l: Line) => {
    if (!voice) return setVoiceSheet(true);
    if (playing) stopPlay();
    // the Mac speaks it (and plays it)
    if (controller) return playOnMac({ t: "songPlay", from: Math.max(0, (l.audio_at ?? 0) - 0.5), until: null, guide: [l.id] });
    const layers = await guide([l.id], l.id);
    if (!layers?.length) return;
    const g = layers[0];
    void play(Math.max(0, g.at - 0.5), g.at + g.buffer.duration + 0.3, { guide: layers, flow: false });
  };

  /** the whole part in your voice, on the flow set for it (each line's syllable times): 1 call per line not spoken yet */
  const hearPart = async (s: ProjectTree["sections"][number]) => {
    if (!voice) return setVoiceSheet(true);
    const ids = s.lines.filter((l) => l.kind === "lyric" && l.text.trim() && l.status !== "DECLINED").map((l) => l.id);
    if (!ids.length) return;
    const todo = ids.filter((id) => !spoken.has(id)).length;
    if (todo > 1 && !window.confirm(`Hear ${s.name} in your voice? ${todo} lines to speak · ${todo} calls`)) return;
    if (playing) stopPlay();
    if (controller) return playOnMac({ t: "songPlay", from: Math.max(0, partRange(s).start - Math.min(bar, 3)), until: null, guide: ids });
    const layers = await guide(ids, s.id);
    if (!layers?.length) return;
    const r = partRange(s);
    const first = Math.min(r.start, ...layers.map((g) => g.at));
    void play(Math.max(0, first - Math.min(bar, 3)), Math.max(r.end, ...layers.map((g) => g.at + g.buffer.duration)) + 0.3, { guide: layers, flow: false });
  };

  const play = async (
    from: number,
    until: number | null = null,
    /** noVoice: the lyrics in your voice not added (the phone decides that when it drives the Mac) */
    opts: { guide?: PlayLayer[]; flow?: boolean; clicks?: { at: number; accent: boolean }[]; noVoice?: boolean } = {},
  ) => {
    // the Mac is the main device: it plays (a flow being sung or tapped stays here)
    if (controller && !opts.clicks && !opts.guide) {
      if (withGuide && voice && unspoken.length && !window.confirm(`Hear the song in your voice? ${unspoken.length} line${unspoken.length === 1 ? "" : "s"} still to speak · ${unspoken.length} call${unspoken.length === 1 ? "" : "s"}`)) return;
      return playOnMac({ t: "songPlay", from, until, guide: withGuide && voice ? lyricLines.map((l) => l.id) : undefined, song: true });
    }
    const e = engine.current;
    if (!e || !beat.current) return;
    await e.ctx.resume();
    let guideL = opts.guide ?? [];
    if (!opts.guide && !opts.noVoice && withGuide && voice) {
      if (unspoken.length && !window.confirm(`Hear the song in your voice? ${unspoken.length} line${unspoken.length === 1 ? "" : "s"} still to speak · ${unspoken.length} call${unspoken.length === 1 ? "" : "s"}`))
        return;
      guideL = (await guide(lyricLines.map((l) => l.id), "all")) ?? [];
    }
    // your voice replaces your flow (two voices at once are hard to follow)
    const flowOn = (opts.flow ?? withFlow) && !guideL.length;
    if (flowOn) await loadFlow().catch(() => {});
    const flows = flowOn ? flowTakes.flatMap((t) => (flowBufs.current.has(t.id) ? [{ buffer: flowBufs.current.get(t.id)!, at: t.start_at, gain: 0.9, bus: "flow", clip: clipOf(t) }] : [])) : [];
    // your recorded takes (Record), unless muted; not with clicks (tapping / singing a flow)
    const takes = opts.clicks || opts.guide ? [] : await takeLayers().catch(() => []);
    const layers = [...flows, ...guideL.map((l) => ({ ...l, bus: "voice" })), ...takes];
    e.play(Math.max(0, from), { beat: beat.current, layers, beatGain: guideL.length ? 0.6 : 0.8, clicks: opts.clicks });
    stopAt.current = until;
    setPlaying(true);
  };
  // ---------- stems for Logic: each track from 0:00, as WAVs in a ZIP ----------
  const exportStems = async (o: ExportOptions, progress: (text: string) => void) => {
    const e = engine.current;
    const b = beat.current;
    if (!e || !b) throw new Error("The beat is still loading.");
    progress("Loading the takes…");
    const takes = await takeLayers();
    if (o.flow) await loadFlow().catch(() => {});
    const flows = o.flow ? flowTakes.flatMap((t) => (flowBufs.current.has(t.id) ? [{ buffer: flowBufs.current.get(t.id)!, at: t.start_at, gain: 1, clip: clipOf(t) }] : [])) : [];
    const lanes = lanesOf(tree).filter((l) => l !== "Flow");
    const vols = mixVolumes(tree.project.settings, lanes);
    const pans = mixPans(tree.project.settings, lanes);
    const ch = (key: string) => ({ vol: vols[key] ?? 1, pan: pans[key] ?? 0 });
    const stems: Stem[] = [{ name: "Beat", layers: [{ buffer: b, at: 0 }], channel: o.mixed ? ch("beat") : null, stereo: true }];
    if (flows.length) stems.push({ name: "Flow (guide)", layers: flows, channel: o.mixed ? ch("flow") : null, stereo: false });
    for (const l of lanes) {
      const layers = takes.filter((x) => x.bus === laneBus(l));
      if (layers.length) stems.push({ name: l, layers, channel: o.mixed ? ch(laneBus(l)) : null, stereo: false });
    }
    // the mix: as heard (the beat a little down, as it plays here)
    const mix = o.mixdown
      ? stems.map((s) => ({ ...s, layers: s.name === "Beat" ? [{ buffer: b, at: 0, gain: 0.8 }] : s.layers, channel: ch(s.name === "Beat" ? "beat" : s.name === "Flow (guide)" ? "flow" : laneBus(s.name)) }))
      : null;
    const zip = await exportStemsZip({
      song: tree.project.title,
      stems,
      mix,
      seconds: b.duration,
      sampleRate: b.sampleRate,
      withFx: o.mixed,
      bpm: tree.audio?.bpm ?? null,
      barOne: tree.audio?.beat_offset ?? 0,
      onProgress: (done, total, what) => progress(what === "ZIP" ? "Packing the ZIP…" : `Rendering ${what} · ${done + 1}/${total}`),
    });
    const url = URL.createObjectURL(zip);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tree.project.title.replace(/[\\/:*?"<>|]+/g, "-")} - stems.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const stopPlay = () => {
    if (controller) {
      sendRemote({ t: "songStop" });
      if (remoteEnd.current) clearTimeout(remoteEnd.current);
    }
    engine.current?.stop();
    setPlaying(false);
    setLive(null);
  };

  // ---------- undo / redo: one step per action ----------
  const history = tree.history ?? { undo: 0, redo: 0, undoLabel: null, redoLabel: null };
  const [undoing, setUndoing] = useState(false);
  const [toast, setToast] = useState<{ text: string; then: "undo" | "redo" } | null>(null);
  /** right after a new flow: take it back, or do it again */
  const [lastFlow, setLastFlow] = useState<{ label: string; again: () => void } | null>(null);
  const undoRedo = async (which: "undo" | "redo") => {
    if (undoing) return;
    if (playing) stopPlay();
    setUndoing(true);
    try {
      const res = await fetch(`/api/projects/${pid}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: which }) });
      const data = (await res.json().catch(() => ({}))) as ProjectTree & { error?: string };
      if (!res.ok) return setError(data.error ?? "Something went wrong");
      setTree(data);
      setLastFlow(null);
      const label = res.headers.get("x-undo-label");
      setToast(label ? { text: `${which === "undo" ? "Undone" : "Redone"}: ${decodeURIComponent(label)}`, then: which === "undo" ? "redo" : "undo" } : null);
    } finally {
      setUndoing(false);
    }
  };
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);
  // a computer: ⌘Z / Ctrl+Z undo, with ⇧ redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void undoRedo(e.shiftKey ? "redo" : "undo");
      }

    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------- recording the flow ----------
  // the same on this device as in Record: headphones or not, and the delay found by ear for each
  const [headphones, setHeadphones] = usePref("vf.studio.headphones", true);
  const [latencyRaw] = usePref<number | null>(`vf.studio.latency.${deviceKind()}`, null);
  const [latencyVp] = usePref<number | null>(`vf.studio.latency.vp.${deviceKind()}`, null);
  /** how late the microphone hears you (s): the delay set in Record, else what the browser reports */
  const recLatency = (e: StudioEngine) => {
    const ms = headphones ? latencyRaw : latencyVp;
    return ms !== null ? ms / 1000 : e.reportedLatency;
  };
  const [rec, setRec] = useState<null | "recording" | "tapping" | "processing">(null);
  const [source, setSource] = useState<"flow" | "tap" | "vocals">("flow");
  /** how the flow is set: sung into the mic, or tapped on the screen */
  const [flowMode, setFlowMode] = useState<"sing" | "tap" | "both">("sing");
  const tapsRef = useRef<number[]>([]);
  /** "next line" taps: the index of the first tap of each new line */
  const breaksRef = useRef<number[]>([]);
  const [tapCount, setTapCount] = useState(0);
  /** the line being tapped (1-based) and its syllables so far */
  const [tapLine, setTapLine] = useState({ n: 1, count: 0 });
  /** recording a flow for one part only (a part without vocals): its time range */
  const [part, setPart] = useState<{ sectionId: string; name: string; start: number; end: number } | null>(null);
  const bar = tree.audio?.bpm ? ((tree.audio.beats_per_bar ?? 4) * 60) / tree.audio.bpm : 2.5;
  const [level, setLevel] = useState(0);
  const [step, setStep] = useState<{ key: FlowStep; progress?: { done: number; total: number } } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const stopRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (rec !== "recording" && rec !== "tapping") return;
    const id = setInterval(() => {
      const e = engine.current;
      if (!e) return;
      setNow(e.position());
      if (rec === "recording") setLevel(e.level());
      const until = part ? part.end + 0.3 : tree.audio?.duration;
      if (until && e.position() >= until) void stopRef.current?.();
    }, 60);
    return () => clearInterval(id);
  }, [rec, tree.audio?.duration, part]);

  const startFlow = async () => {
    const e = engine.current;
    if (!e || !beat.current) return;
    const partHasText = part && tree.sections.find((s) => s.id === part.sectionId)?.lines.some((l) => l.text.trim());
    if (part ? partHasText && !window.confirm(`Record a new flow for ${part.name}? It replaces its lines (a version is saved first).`) : hasLines && !window.confirm("Record a new flow? It replaces the current draft (kept lines are saved as a version).")) return;
    setError(null);
    setNote(null);
    try {
      await e.arm(undefined, { voiceProcessing: !headphones });
    } catch (err) {
      setError(err instanceof Error ? `Microphone: ${err.message}` : "The microphone is not available.");
      return;
    }
    stopPlay();
    // a part: the beat starts a bar before it, to come in on time
    e.play(part ? Math.max(0, part.start - bar) : 0, { beat: beat.current });
    e.startRecording();
    setRec("recording");
  };

  const stopFlow = async () => {
    const e = engine.current;
    if (!e || rec !== "recording") return;
    setSource("flow");
    setRec("processing");
    const r = await e.stopRecording(recLatency(e), 0, 0);
    e.disarm();
    if (!r) {
      setError("Nothing was recorded.");
      setRec(null);
      return;
    }
    try {
      // one undo step: the whole new flow (the song before comes back)
      const out = await undoStep(part ? `Flow for ${part.name}` : "New flow for the song", () =>
        processFlow(pid, tree, r, (key, progress) => setStep({ key, progress }), setTree, part ?? undefined),
      );
      const again = part;
      setPart(null);
      setTree(out.tree);
      setLastFlow({ label: again ? `New flow · ${again.name}` : "New flow for the song", again: () => setView("flow") });
      if (out.wordsFailed) setNote(`Your words couldn't be recognised (${out.wordsFailed}) — the lyrics follow your rhythm only.`);
      // keep the fresh recording for playback
      const buf = e.ctx.createBuffer(1, r.samples.length, r.sampleRate);
      buf.copyToChannel(r.samples as Float32Array<ArrayBuffer>, 0);
      flowBufs.current.set(out.takeId, buf);
      setView("lyrics");
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setRec(null);
      setStep(null);
    }
  };

  // ---------- tapping the flow (no microphone): one tap per syllable while the beat plays ----------
  const startTapping = async () => {
    const e = engine.current;
    if (!e || !beat.current) return;
    const partHasText = part && tree.sections.find((s) => s.id === part.sectionId)?.lines.some((l) => l.text.trim());
    if (part ? partHasText && !window.confirm(`Tap a new flow for ${part.name}? It replaces its lines (a version is saved first).`) : hasLines && !window.confirm("Tap a new flow? It replaces the current draft (kept lines are saved as a version).")) return;
    setError(null);
    setNote(null);
    stopPlay();
    await e.ctx.resume();
    // sing + tap: the voice is recorded while you tap
    if (flowMode === "both") {
      try {
        await e.arm(undefined, { voiceProcessing: !headphones });
      } catch (err) {
        setError(err instanceof Error ? `Microphone: ${err.message}` : "The microphone is not available.");
        return;
      }
    }
    tapsRef.current = [];
    breaksRef.current = [];
    setTapCount(0);
    setTapLine({ n: 1, count: 0 });
    e.play(part ? Math.max(0, part.start - bar) : 0, { beat: beat.current });
    if (flowMode === "both") e.startRecording();
    setRec("tapping");
  };
  const tapNow = () => {
    const e = engine.current;
    if (!e) return;
    // the song time you hear (a tap answers what you hear: the output's delay comes off)
    const t = e.position() - ((e.ctx as AudioContext & { outputLatency?: number }).outputLatency || e.ctx.baseLatency || 0);
    if (part && t < part.start - 0.3) return; // the bar before the part is only for getting in
    tapsRef.current.push(t);
    setTapCount(tapsRef.current.length);
    setTapLine((x) => ({ ...x, count: x.count + 1 }));
    navigator.vibrate?.(8);
  };
  /** the second pad: the line is done, the next taps start a new one */
  const nextLine = () => {
    const n = tapsRef.current.length;
    const last = breaksRef.current[breaksRef.current.length - 1] ?? 0;
    if (n === last) return; // nothing tapped in this line yet
    breaksRef.current.push(n);
    setTapLine((x) => ({ n: x.n + 1, count: 0 }));
    navigator.vibrate?.([6, 40, 6]);
  };
  const finishTapping = async () => {
    const e = engine.current;
    if (!e || rec !== "tapping") return;
    const voice = e.armed ? await e.stopRecording(recLatency(e), 0, part ? Math.max(0, part.start - 0.3) : 0) : null;
    if (e.armed) e.disarm();
    e.stop();
    const taps = tapsRef.current;
    if (taps.length < 2) {
      setRec(null);
      setError("Tap once per syllable while the beat plays — at least a few taps.");
      return;
    }
    setSource(voice ? "flow" : "tap");
    setRec("processing");
    try {
      const out = await undoStep(part ? `Tapped flow for ${part.name}` : "Tapped flow for the song", () => processTaps(
        pid,
        tree,
        taps,
        (key, progress) => setStep({ key, progress }),
        setTree,
        part ?? undefined,
        breaksRef.current.length ? breaksRef.current : undefined,
        voice ?? undefined,
      ));
      setTree(out);
      setLastFlow({ label: part ? `Tapped flow · ${part.name}` : "Tapped flow for the song", again: () => setView("flow") });
      setPart(null);
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
    stopRef.current = rec === "tapping" ? finishTapping : stopFlow;
  });

  // ---------- the song's own vocals ----------
  /** auto: the check right after uploading — no lyrics in the track means it's a beat: record your flow */
  const readVocals = async (auto = false, base: ProjectTree = tree) => {
    if (!base.audio) return;
    if (!auto && hasLines && !window.confirm("Read the lyrics from the song? It replaces the current draft (a version is saved first).")) return;
    stopPlay();
    setError(null);
    setNote(null);
    setSource("vocals");
    setRec("processing");
    setView("flow");
    let latest = base;
    try {
      const out = await undoStep("Lyrics read from the song", () => processVocals(
        pid,
        base,
        (key, progress) => setStep({ key, progress }),
        (t) => {
          latest = t;
          setTree(t);
        },
        { auto },
      ));
      if (out) {
        latest = out;
        setTree(out);
      } else setNote("No vocals in this track — it's a beat. Record your flow over it to write the lyrics.");
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
    if (!autoDetect || autoStarted.current || hasLines || !tree.audio) return;
    autoStarted.current = true;
    router.replace(`/song/${pid}`);
    void readVocals(true);
  });

  // ---------- parts without vocals: written later, from a flow recorded just for them ----------
  const partRange = (s: ProjectTree["sections"][number]) => {
    const i = tree.sections.indexOf(s);
    const lyric = s.lines.filter((l) => l.kind === "lyric");
    const start = s.audio_start ?? lyric[0]?.audio_at ?? 0;
    const nextStart = tree.sections.slice(i + 1).find((x) => x.audio_start !== null)?.audio_start ?? null;
    return { start, end: nextStart ?? total };
  };
  const isEmptyPart = (s: ProjectTree["sections"][number]) => {
    const lyric = s.lines.filter((l) => l.kind === "lyric");
    return lyric.length > 0 && lyric.every((l) => !l.text.trim() && !l.flow);
  };

  // ---------- the parts bar: where you are, tap to jump ----------
  /** a part's name (Verse 1, Hook, Rap…) */
  const [partMenu, setPartMenu] = useState<string | null>(null);
  /** the part merges into the one before it: its lines move there (one undo step) */
  const mergePart = (id: string) => void call(`/api/sections/${id}`, { action: "mergePrevious" });
  /** the part made longer by some bars of its beat: empty lines to write (one undo step) */
  const extendPart = (id: string, bars: number) => void call(`/api/sections/${id}`, { action: "extend", bars });
  /** a part copied, to paste after another one */
  const [copied, setCopied] = useState<string | null>(null);
  const pastePart = (after: string) => {
    if (!copied) return;
    const id = copied;
    setCopied(null);
    void call(`/api/sections/${id}`, { action: "paste", after });
  };
  const renamePart = (s: ProjectTree["sections"][number]) => {
    const name = window.prompt("Name of this part:", s.name)?.trim();
    if (name && name !== s.name) void call(`/api/sections/${s.id}`, { name: name.slice(0, 60) }, "PATCH");
  };
  /** the part being worked on — the same in Flow, Lyrics and Record */
  const [activePart, setActivePart] = useState<string | null>(null);
  // the phone drives the Mac: this song, its tab and part go there (the app-wide link: components/RemoteFollow)
  useEffect(() => {
    if (controller) postNav(`/song/${pid}`, view, activePart);
  }, [controller, view, activePart, pid]);
  // this Mac follows the phone: its tab and part, and it plays what the phone plays
  const hostRun = useRef<(c: RemoteCmd) => void>(() => {});
  /** the play the phone asked for, waiting for the beat or the sound */
  const hostPending = useRef(0);
  useEffect(() => {
    hostRun.current = (c) => {
      if (c.t === "nav") {
        if (["flow", "lyrics", "record", "mix", "more"].includes(c.view)) setView(c.view as View);
        if (c.part) {
          setActivePart(c.part);
          setTimeout(() => document.getElementById(`part-${c.part}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 150);
        }
      } else if (c.t === "songStop") {
        hostPending.current = 0;
        stopPlay();
      }
      else if (c.t === "songPlay") {
        const asked = Date.now();
        hostPending.current = asked;
        void (async () => {
          // the song just opened (the phone switched part or song): its beat is still loading — and the sound
          // waits for a click on this Mac (a browser rule); it plays once both are there (within a minute)
          const ctx = engine.current?.ctx;
          while ((!beat.current || ctx?.state !== "running") && Date.now() - asked < 60_000) {
            if (hostPending.current !== asked) return;
            if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
            await new Promise((r) => setTimeout(r, 250));
          }
          if (hostPending.current !== asked || !beat.current) return;
          const layers = c.guide?.length ? await guide(c.guide, "remote") : null;
          if (c.guide?.length && !layers?.length) return;
          const until = c.until ?? (!c.song && layers ? Math.max(...layers.map((g) => g.at + g.buffer.duration)) + 0.3 : null);
          void play(c.from, until, layers ? { guide: layers, flow: false } : { noVoice: true });
        })();
      }
    };
  });
  // the Mac: the phone's tab and part in this song
  useEffect(() => {
    if (!remoteHost) return;
    const on = (e: Event) => {
      const d = (e as CustomEvent<NavDetail>).detail;
      if (d.path === `/song/${pid}`) hostRun.current({ t: "nav", view: d.view ?? view, part: d.part });
    };
    window.addEventListener(NAV_EVENT, on);
    return () => window.removeEventListener(NAV_EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the listener reads the tab it is in
  }, [remoteHost, pid]);
  // a browser plays sound only after a click on the page: until then the Mac asks for one (components/RemoteFollow)
  useEffect(() => {
    if (!remoteHost) return;
    let alive = true;
    (async () => {
      let after = -1;
      while (alive) {
        try {
          const r = (await fetch(`/api/projects/${pid}/remote?cmds&after=${after}`, { cache: "no-store" }).then((x) => x.json())) as {
            last: number;
            cmds: { id: number; cmd: RemoteCmd }[];
            recent?: { id: number; cmd: RemoteCmd }[];
          };
          if (!alive) break;
          after = r.last;
          // just opened: a play the phone asked for while this page was loading (if it wasn't stopped since)
          const asked = r.recent?.at(-1)?.cmd;
          if (asked?.t === "songPlay") hostRun.current(asked);
          for (const c of r.cmds) hostRun.current(c.cmd);
        } catch {
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [remoteHost, pid]);
  const activePartRef = useRef(activePart);
  useEffect(() => {
    activePartRef.current = activePart;
  });
  // opening Lyrics: straight to that part (the scroll doesn't pick another one meanwhile)
  const restoringPart = useRef(false);
  useEffect(() => {
    if (view !== "lyrics" || !activePartRef.current) return;
    restoringPart.current = true;
    document.getElementById(`part-${activePartRef.current}`)?.scrollIntoView({ block: "start" });
    const id = setTimeout(() => (restoringPart.current = false), 500);
    return () => clearTimeout(id);
  }, [view]);
  const partsRow = useRef<HTMLDivElement | null>(null);
  const liveSection = live ? (tree.sections.find((s) => s.lines.some((l) => l.id === live))?.id ?? null) : null;
  // while scrolling: the part at the top of the screen
  useEffect(() => {
    if (view !== "lyrics") return;
    const els = [...document.querySelectorAll<HTMLElement>("[data-part-section]")];
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top && !restoringPart.current) setActivePart((top.target as HTMLElement).dataset.partSection ?? null);
      },
      { rootMargin: "-170px 0px -55% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [view, tree.sections.length, hasLines]);
  // while playing: the part being sung
  const shownPart = playing && liveSection ? liveSection : activePart;
  useEffect(() => {
    const row = partsRow.current;
    const chip = row?.querySelector<HTMLElement>(`[data-part="${shownPart}"]`);
    if (row && chip) row.scrollTo({ left: chip.offsetLeft - row.clientWidth / 2 + chip.clientWidth / 2, behavior: "smooth" });
  }, [shownPart]);
  const goPart = (s: ProjectTree["sections"][number]) => {
    document.getElementById(`part-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActivePart(s.id);
    // a bar before the part (at most 3 s): you hear it coming
    const start = Math.max(0, partRange(s).start - Math.min(bar, 3));
    setNow(start);
    if (playing) void play(start);
  };

  // ---------- line actions ----------
  const [busyLine, setBusyLine] = useState<string | null>(null);
  /** the line whose flow grid is open */
  const [gridLine, setGridLine] = useState<string | null>(null);
  /** the line opened for its details and actions (one at a time) */
  const [openLine, setOpenLine] = useState<string | null>(null);
  useEffect(() => {
    tappingRef.current = gridLine !== null;
  }, [gridLine]);
  const beatGrid: BeatGrid | null = tree.audio?.bpm ? { bpm: tree.audio.bpm, beat_offset: tree.audio.beat_offset ?? 0, beats_per_bar: tree.audio.beats_per_bar ?? 4 } : null;
  /** tapping a flow: one bar to count in (clicks on its beats), then the line's bar(s); no recorded voices */
  const startTap = (g: FlowGridModel) => {
    if (playing) stopPlay();
    const beatLen = g.step * 4;
    const barLen = beatLen * (beatGrid?.beats_per_bar ?? 4);
    const from = g.start - barLen;
    const clicks = Array.from({ length: beatGrid?.beats_per_bar ?? 4 }, (_, k) => ({ at: from + k * beatLen, accent: k === 0 })).filter((c) => c.at >= 0);
    void play(Math.max(0, from), g.start + g.cells.length * g.step + 0.25, { guide: [], flow: false, clicks });
  };
  /** singing one line's bar: count-in, record the bar, find the syllables in it (on the phone, free) */
  const singLine = async (g: FlowGridModel): Promise<number[]> => {
    const e = engine.current;
    if (!e || !beat.current) return [];
    if (playing) stopPlay();
    await e.arm(undefined, { voiceProcessing: !headphones });
    const beatLen = g.step * 4;
    const from = Math.max(0, g.start - beatLen * (beatGrid?.beats_per_bar ?? 4));
    const end = g.start + g.cells.length * g.step;
    const clicks = Array.from({ length: beatGrid?.beats_per_bar ?? 4 }, (_, k) => ({ at: from + k * beatLen, accent: k === 0 }));
    e.play(from, { beat: beat.current, clicks });
    e.startRecording();
    await new Promise<void>((done) => {
      const id = setInterval(() => {
        if (e.position() >= end + 0.25) {
          clearInterval(id);
          done();
        }
      }, 50);
    });
    const r = await e.stopRecording(recLatency(e), 0, Math.max(0, g.start - 0.4));
    e.disarm();
    if (!r) return [];
    return detectSyllables(r.samples, r.sampleRate)
      .map((x) => x.t + r.startAt)
      .filter((t) => t >= g.start - 0.3 && t < end);
  };
  /** the song time being heard now (the output's delay taken off: a tap answers what you hear) */
  const songTime = useCallback(() => {
    const e = engine.current;
    if (!e) return 0;
    const out = (e.ctx as AudioContext & { outputLatency?: number }).outputLatency || e.ctx.baseLatency || 0;
    return e.position() - out;
  }, []);

  // ---------- flows: a part (or a stretch of it) follows a pattern of 2 or 4 lines ----------
  const [flowSheet, setFlowSheet] = useState<{ sectionId: string; fromLineId: string | null; flowId: string | null } | null>(null);
  const openFlowSheet = (v: { sectionId: string; fromLineId: string | null; flowId: string | null }) => {
    setFlowSheet(v);
    setActivePart(v.sectionId);
  };
  /** where a flow would apply: from the part's (or the line's) bar line to where the part — or the flow it follows — ends */
  const stretchOf = (s: ProjectTree["sections"][number], fromLineId: string | null) => {
    const lyric = s.lines.filter((l) => l.kind === "lyric");
    const r = partRange(s);
    const origin = tree.audio?.beat_offset ?? 0;
    const barLine = (t: number) => origin + Math.max(0, Math.round((t - origin) / bar)) * bar;
    const from = fromLineId ? Math.max(0, lyric.findIndex((l) => l.id === fromLineId)) : 0;
    const current = fromLineId ? lyric[from]?.flow?.flowId : undefined;
    const change = current ? lyric.findIndex((l, k) => k > from && l.flow?.flowId !== current) : -1;
    const start = barLine(fromLineId ? (lyric[from]?.audio_at ?? r.start) : r.start);
    const end = change > 0 ? barLine(lyric[change].audio_at ?? r.end) : r.end;
    return { start, end, lines: Math.max(1, Math.floor((end - start) / bar + 0.3)), lineNo: from + 1 };
  };
  const flowsUsed = tree.flows.map((f) => ({
    ...f,
    usedIn: tree.sections.filter((s) => s.lines.some((l) => l.flow?.flowId === f.id)).map((s) => s.name),
  }));
  /** the flow just sung in the flow sheet (to hear it back) */
  const sungTake = useRef<PlayLayer | null>(null);
  /** the flow just sung, being saved as a take: its id (to recognise the words in it) */
  const sungSave = useRef<Promise<string> | null>(null);
  const sheetAudio: SheetAudio = {
    ready: beatReady,
    play: (from, until, clicks, voice) => void play(from, until, { guide: voice && sungTake.current ? [sungTake.current] : [], flow: false, clicks }),
    stop: () => stopPlay(),
    songTime,
    armMic: async () => {
      await engine.current?.arm(undefined, { voiceProcessing: !headphones });
    },
    level: () => engine.current?.level() ?? 0,
    // the words sung in the take just recorded: 1 ElevenLabs call (logged), song time
    recognise: async () => {
      const takeId = sungSave.current ? await sungSave.current : null;
      const at = sungTake.current?.at;
      if (!takeId || at === undefined) throw new Error("Sing first — the take is still being saved.");
      const res = await fetch(`/api/projects/${pid}/flow`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "transcribe", takeId }) });
      const data = (await res.json().catch(() => ({}))) as { words?: { text: string; start: number; end: number }[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "The words could not be recognised");
      return dropSounds(data.words ?? []).map((w) => ({ ...w, start: w.start + at, end: w.end + at }));
    },
    headphones,
    setHeadphones,
    startRec: () => engine.current?.startRecording(),
    stopRec: async (keepFrom) => {
      // a new take: the last one's words must never be recognised for it
      sungSave.current = null;
      sungTake.current = null;
      const e = engine.current;
      if (!e?.armed) return [];
      const r = await e.stopRecording(recLatency(e), 0, keepFrom);
      e.disarm();
      if (!r) return [];
      // to hear it back right away (Listen), with a click on every syllable found
      const vb = e.ctx.createBuffer(1, r.samples.length, r.sampleRate);
      vb.copyToChannel(r.samples as Float32Array<ArrayBuffer>, 0);
      sungTake.current = { buffer: vb, at: r.startAt, gain: 1 };
      // kept as a take of the part (lane "Flow"): heard with the song, and there to check the recognition (free)
      const sectionId = flowSheet?.sectionId ?? null;
      const saved = saveFlowTake(pid, r, sectionId);
      saved.catch(() => {});
      sungSave.current = saved;
      return detectSyllables(r.samples, r.sampleRate).map((x) => ({ t: x.t + r.startAt, strength: x.strength, dur: x.dur }));
    },
  };
  type UseOpts = { write: boolean; brief: LyricsBrief | null };
  const useFlow = async (use: { flowId: string } | { pattern: import("@/lib/types").FlowPattern }, opts: UseOpts) => {
    if (!flowSheet) return;
    const sec0 = tree.sections.find((x) => x.id === flowSheet.sectionId);
    // the brief stays with the part: its lyrics now, and every rewrite later, follow it
    const briefs = { ...(tree.project.settings?.briefs ?? {}) };
    if (opts.brief) briefs[flowSheet.sectionId] = opts.brief;
    else delete briefs[flowSheet.sectionId];
    if (JSON.stringify(briefs) !== JSON.stringify(tree.project.settings?.briefs ?? {}))
      await call(`/api/projects/${pid}`, { settings: { ...(tree.project.settings ?? {}), briefs } }, "PATCH");
    // one undo step: the part's new lines and their lyrics
    const sheet = flowSheet;
    await undoStep(`New flow · ${sec0?.name ?? "part"}`, () => applyFlowSheet(use, opts));
    setLastFlow({ label: `New flow · ${sec0?.name ?? "part"}`, again: () => openFlowSheet({ ...sheet, flowId: null }) });
    // the result: the part's new lines (Lyrics opens on it)
    setView("lyrics");
  };
  const applyFlowSheet = async (use: { flowId: string } | { pattern: import("@/lib/types").FlowPattern }, opts: UseOpts) => {
    if (!flowSheet) return;
    const post = async <T,>(body: unknown): Promise<T> => {
      const res = await fetch(`/api/projects/${pid}/flows`, { method: "POST", headers: { "content-type": "application/json", ...undoHeaders() }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      return data;
    };
    let flowId = "flowId" in use ? use.flowId : null;
    if (!flowId) flowId = (await post<{ flow: { id: string } }>({ action: "create", pattern: (use as { pattern: unknown }).pattern })).flow.id;
    const out = await post<{ tree: ProjectTree; write: string[] }>({ action: "apply", flowId, sectionId: flowSheet.sectionId, fromLineId: flowSheet.fromLineId });
    setTree(out.tree);
    setFlowSheet(null);
    // the new lines without words: written in the flow (1 call per ~8 lines)
    const write = new Set(out.write);
    const sec = out.tree.sections.find((x) => x.id === flowSheet.sectionId);
    const todo = sec ? sec.lines.filter((l) => write.has(l.id)) : [];
    // "flow only, write later": the lines stay empty (✨ Write them any time — the brief is kept)
    if (todo.length && opts.write) {
      await lineAction(flowSheet.sectionId, async () => {
        for (const ids of chunkLines(todo)) await call(`/api/projects/${pid}/flow`, { action: "suggest", lineIds: ids });
      });
    }
  };

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** a change to a line (or a part): busy while it runs, one undo step with this label */
  const lineAction = async (id: string, fn: () => Promise<unknown>, label = "Change") => {
    setBusyLine(id);
    try {
      await undoStep(label, fn);
    } finally {
      setBusyLine(null);
    }
  };
  // empty lines outside the empty parts (those have their own buttons)
  /** 3 new options for a line, rhyming with the other line as it is (1 call) — the best rhyming one goes in */
  const newRhyming = (l: LyricLine, partner: LyricLine) =>
    lineAction(l.id, async () => {
      const t = await call(`/api/projects/${pid}/flow`, { action: "suggest", lineIds: [l.id] });
      const fresh = t?.sections.flatMap((s) => s.lines).find((x) => x.id === l.id) as LyricLine | undefined;
      if (!fresh || rhymeScore(partner.text, fresh.text, lang) >= RHYMES) return;
      const top = fresh.alternatives.map((x) => ({ x, score: rhymeScore(partner.text, x.text, lang) })).sort((p, q) => q.score - p.score)[0];
      if (top && top.score >= RHYMES) await call(`/api/alternatives/${top.x.id}`, { action: "swap" });
      else setNote("No rhyming option yet — try again, or edit the line.");
    }, "New rhyming options");
  /**
   * The whole couplet again: 3 new rhyming pairs for both lines (1 call), the best pair in. A kept line is
   * replaced only when the writer says so (it's un-kept first; the AI never changes a kept line).
   */
  const newCouplet = async (a: LyricLine, b: LyricLine) => {
    const kept = [a, b].filter(isKept);
    if (kept.length && !window.confirm(`Replace both lines? ${kept.map((l) => `“${l.text}”`).join(" and ")} ${kept.length === 1 ? "is" : "are"} kept.`)) return;
    await lineAction(a.id, async () => {
      for (const l of kept) await call(`/api/lines/${l.id}`, { status: "SUGGESTED", action: "unkeep" }, "PATCH");
      // in song order: the first line of the pair first
      const ids = [a, b].sort((x, y) => (x.audio_at ?? x.position) - (y.audio_at ?? y.position)).map((l) => l.id);
      const t = await call(`/api/projects/${pid}/flow`, { action: "suggest", lineIds: ids });
      // the call failed: the kept lines stay kept
      if (!t) {
        for (const l of kept) await call(`/api/lines/${l.id}`, { status: l.status, action: "approve" }, "PATCH");
        return;
      }
      // lines recorded in the song keep their words (the new ones come as options): the best new pair goes in
      const fresh = (id: string) => t?.sections.flatMap((s) => s.lines).find((x) => x.id === id) as LyricLine | undefined;
      const [fa, fb] = [fresh(a.id), fresh(b.id)];
      if (fa && fb && (fa.text === a.text || fb.text === b.text)) {
        const m = pairMoves(fa, fb, lang)[0];
        if (m) {
          await call(`/api/alternatives/${m.partnerAlt.id}`, { action: "swap" });
          await call(`/api/alternatives/${m.alt.id}`, { action: "swap" });
        }
      }
    }, "New couplet");
  };
  /** a rhyming couplet from the options: this line's option, and the other line's when it changes too (free) */
  const applyMove = (l: LyricLine, m: RhymeMove) =>
    lineAction(l.id, async () => {
      if (m.partnerAlt) await call(`/api/alternatives/${m.partnerAlt.id}`, { action: "swap" });
      await call(`/api/alternatives/${m.alt.id}`, { action: "swap" });
    }, m.partnerAlt ? "Next pair" : "Next option");
  /**
   * A couplet that doesn't rhyme: the 2nd line's next rhyming option (or a rhyming pair of options for both
   * lines), else the 1st line's option rhyming with the 2nd — free; none → 3 new options rhyming with the
   * other line (1 call). A kept line stays as it is.
   */
  const makeItRhyme = (a: LyricLine, b: LyricLine) =>
    undoStep("Make it rhyme", async () => {
      const [line, other] = isKept(b) && !isKept(a) ? [a, b] : [b, a];
      const mine = rhymeMoves(line, other, lang)[0];
      if (mine) return applyMove(line, mine);
      // the other line's option that rhymes with this one as it is
      const theirs = isKept(other) ? undefined : rhymeMoves(other, line, lang).find((m) => !m.partnerAlt);
      if (theirs) return applyMove(other, theirs);
      await newRhyming(line, other);
    });
  const missing = tree.sections
    .filter((s) => !isEmptyPart(s))
    .flatMap((s) => s.lines.filter((l) => l.kind === "lyric" && !l.text.trim()))
    .map((l) => l.id);
  const missingCalls = tree.sections.flatMap((s) => chunkLines(s.lines.filter((l) => l.kind === "lyric" && missing.includes(l.id)))).length;
  const kept = lyricLines.filter((l) => l.status === "APPROVED" || l.status === "APPROVED_EDITED").length;

  // a computer: space plays / stops the song (Record has its own: the part and its takes; not while
  // recording a flow, typing, or with a sheet open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.code !== "Space" || e.metaKey || e.ctrlKey || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return;
      if (view === "record" || rec !== null || flowSheet || voiceSheet || !tree.audio) return;
      e.preventDefault();
      // a focused button would also take the space as a click
      (document.activeElement as HTMLElement | null)?.blur?.();
      if (playing) stopPlay();
      else if (beatReady) void play(now >= (tree.audio.duration ?? 0) - 1 ? 0 : now);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------- screens ----------
  const total = tree.audio?.duration ?? 0;
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col bg-bg">
      {/* top bar */}
      <header className="sticky top-0 z-20 border-b border-line/70 bg-bg/90 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-xl">
        <div className="flex items-center gap-2 px-3">
          <Link href="/" className="flex h-9 w-9 items-center justify-center rounded-full text-muted active:bg-panel-2" aria-label="Back">
            <ChevronLeft className="h-6 w-6" />
          </Link>
          <h1 className="min-w-0 flex-1 truncate text-[17px] font-bold tracking-tight">{tree.project.title}</h1>
          {/* undo / redo: whole actions ("New couplet", "New flow · Part 2"…), as many as you like */}
          {rec === null && (
            <div className="flex shrink-0 items-center">
              <button
                className="flex h-9 items-center gap-0.5 rounded-full px-2 text-fg/70 active:bg-panel-2 disabled:opacity-30"
                disabled={!history.undo || undoing || recBusy || busyLine !== null}
                onClick={() => void undoRedo("undo")}
                title={history.undoLabel ? `Undo: ${history.undoLabel}` : "Nothing to undo"}
                aria-label={history.undoLabel ? `Undo ${history.undoLabel}` : "Undo"}
              >
                <Undo className="h-5 w-5" />
                {history.undo > 1 && <span className="text-[11px] font-semibold tabular-nums">{Math.min(history.undo, 99)}</span>}
              </button>
              <button
                className="flex h-9 items-center gap-0.5 rounded-full px-2 text-fg/70 active:bg-panel-2 disabled:opacity-30"
                disabled={!history.redo || undoing || recBusy || busyLine !== null}
                onClick={() => void undoRedo("redo")}
                title={history.redoLabel ? `Redo: ${history.redoLabel}` : "Nothing to redo"}
                aria-label={history.redoLabel ? `Redo ${history.redoLabel}` : "Redo"}
              >
                <Redo className="h-5 w-5" />
                {history.redo > 1 && <span className="text-[11px] font-semibold tabular-nums">{Math.min(history.redo, 99)}</span>}
              </button>
            </div>
          )}
          {view === "lyrics" && hasLines && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-panel-2 px-2.5 py-1 text-xs font-semibold text-muted" title="Lines kept">
              <Check className="h-3.5 w-3.5" />
              {kept}/{lyricLines.length}
            </span>
          )}
        </div>
        {/* player */}
        {view === "lyrics" && tree.audio && (
          <div className="mt-2 flex items-center gap-2.5 px-4">
            <button
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-md shadow-accent/30 active:scale-95 disabled:opacity-40"
              disabled={!beatReady}
              onClick={() => (playing ? stopPlay() : void play(now >= total - 1 ? 0 : now))}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
            </button>
            <div className="min-w-0 flex-1">
              <div
                className="relative h-1.5 cursor-pointer rounded-full bg-panel-2"
                onClick={(ev) => {
                  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                  const t = ((ev.clientX - r.left) / r.width) * total;
                  setNow(t);
                  if (playing) void play(t);
                }}
              >
                {/* where the parts start */}
                {total > 0 &&
                  tree.sections.map((s) => {
                    const at = s.audio_start;
                    return at && at > 0 ? <span key={s.id} className="absolute -top-0.5 h-2.5 w-px bg-muted/40" style={{ left: `${(at / total) * 100}%` }} /> : null;
                  })}
                <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${total ? (now / total) * 100 : 0}%` }} />
              </div>
              <div className="mt-1 flex justify-between font-mono text-[11px] tabular-nums text-muted">
                <span>{fmtTime(now)}</span>
                <span>{fmtTime(total)}</span>
              </div>
            </div>
            <button
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-panel-2 text-fg/80"
              onClick={() => setView("mix")}
              title="Mixer: the beat, the original vocals, your flow, your recordings"
              aria-label="Mixer"
            >
              <Sliders className="h-[18px] w-[18px]" />
            </button>
            {hasLines && (
              <button
                className={`relative flex h-9 shrink-0 items-center justify-center gap-1 rounded-full px-2.5 text-xs font-semibold ${withGuide ? "bg-accent text-white" : "bg-panel-2 text-muted"}`}
                onClick={() => {
                  if (!voice) return setVoiceSheet(true);
                  if (playing) stopPlay();
                  setWithGuide((v) => !v);
                }}
                aria-pressed={withGuide}
                title="Hear the lyrics rapped in your voice, on your flow"
              >
                {guideBusy === "all" ? (
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-r-transparent" />
                ) : (
                  <AudioLines className="h-[18px] w-[18px]" />
                )}
                {withGuide && unspoken.length > 0 && guideBusy !== "all" && <span className="font-normal opacity-80">{unspoken.length} calls</span>}
              </button>
            )}
          </div>
        )}
        {/* the parts: tap to jump there */}
        {view === "lyrics" && hasLines && tree.sections.length > 1 && (
          <div ref={partsRow} className="no-scrollbar mt-2 flex gap-1.5 overflow-x-auto px-4 pb-2.5">
            {tree.sections
              .filter((s) => s.lines.some((l) => l.kind === "lyric"))
              .map((s) => {
                const active = shownPart === s.id;
                const empty = isEmptyPart(s);
                const lyric = s.lines.filter((l) => l.kind === "lyric");
                const done = lyric.length > 0 && lyric.every((l) => l.status === "APPROVED" || l.status === "APPROVED_EDITED");
                return (
                  <button
                    key={s.id}
                    data-part={s.id}
                    onClick={() => goPart(s)}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold transition-colors ${
                      active ? "bg-fg text-bg" : empty ? "border border-dashed border-accent/50 text-accent" : "bg-panel-2 text-fg/80"
                    }`}
                  >
                    {done && <Check className="h-3.5 w-3.5" />}
                    {empty && <Plus className="h-3.5 w-3.5" />}
                    {s.name}
                    <span className={`font-mono text-[11px] font-normal ${active ? "opacity-70" : "text-muted"}`}>{fmtTime(partRange(s).start)}</span>
                  </button>
                );
              })}
          </div>
        )}
      </header>

      {error && (
        <p className="mx-4 mt-3 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      {note && rec === null && (view === "lyrics" || view === "flow") && (
        <p className="mx-4 mt-3 rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn" onClick={() => setNote(null)}>
          {note}
        </p>
      )}

      {toast && (
        <div className="fixed left-1/2 top-[calc(env(safe-area-inset-top)+4.25rem)] z-40 flex max-w-[92%] -translate-x-1/2 items-center gap-3 rounded-full bg-fg py-1.5 pl-4 pr-1.5 text-sm text-bg shadow-lg">
          <span className="truncate">{toast.text}</span>
          <button className="shrink-0 rounded-full bg-bg/15 px-3 py-1 text-xs font-semibold" onClick={() => void undoRedo(toast.then)}>
            {toast.then === "redo" ? "Redo" : "Undo"}
          </button>
        </div>
      )}
      {/* this Mac is driven by the phone */}
      {remoteHost && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-2xl bg-accent-soft px-3.5 py-2 text-sm">
          <span className="flex-1">
            <b>Your phone controls this Mac</b>
            <span className="block text-xs text-muted">It follows the phone&apos;s tab and part, and plays what the phone plays.</span>
          </span>
        </div>
      )}
      {/* a part copied: where to paste it */}
      {copied && !toast && (
        <div className="fixed left-1/2 top-[calc(env(safe-area-inset-top)+4.25rem)] z-40 flex max-w-[92%] -translate-x-1/2 items-center gap-3 rounded-full bg-accent py-1.5 pl-4 pr-1.5 text-sm text-white shadow-lg">
          <span className="truncate">“{tree.sections.find((x) => x.id === copied)?.name}” copied — tap a part&apos;s name to paste after it</span>
          <button className="shrink-0 rounded-full bg-white/20 px-3 py-1 text-xs font-semibold" onClick={() => setCopied(null)}>
            Cancel
          </button>
        </div>
      )}
      {/* right after a new flow: not happy? take it back, or do it again */}
      {lastFlow && rec === null && view === "lyrics" && (
        <div className="mx-4 mt-3 flex items-center gap-1.5 rounded-2xl bg-accent-soft py-1.5 pl-3.5 pr-1.5 text-sm">
          <span className="min-w-0 flex-1 truncate font-semibold text-accent">{lastFlow.label}</span>
          <button className="flex shrink-0 items-center gap-1 rounded-full bg-panel px-3 py-1.5 text-xs font-semibold" disabled={undoing} onClick={() => void undoRedo("undo")}>
            <Undo className="h-3.5 w-3.5" /> Undo
          </button>
          <button
            className="flex shrink-0 items-center gap-1 rounded-full bg-panel px-3 py-1.5 text-xs font-semibold"
            onClick={() => {
              const again = lastFlow.again;
              setLastFlow(null);
              again();
            }}
          >
            <Restart className="h-3.5 w-3.5" /> Again
          </button>
          <button className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted" onClick={() => setLastFlow(null)} aria-label="Close">
            ×
          </button>
        </div>
      )}

      <main className="flex-1 px-4 pb-32 pt-4">
        {/* ----- FLOW ----- */}
        {view === "flow" && !tree.audio && (
          <BeatUpload
            pid={pid}
            onDone={(t) => {
              setTree(t);
              // a new track: does it have lyrics?
              if (!hasLines) void readVocals(true, t);
            }}
          />
        )}
        {view === "flow" && tree.audio && (
          <div className="flex flex-col items-center text-center">
            {rec === null && (
              <>
                {/* the song's flow, part by part */}
                {!part && beatGrid && hasLines && (
                  <div className="mb-6 w-full text-left">
                    <p className="label">Flow part by part</p>
                    <div className="space-y-1.5">
                      {tree.sections
                        .filter((x) => x.lines.some((l) => l.kind === "lyric"))
                        .map((x) => {
                          const names = [...new Set(x.lines.map((l) => tree.flows.find((f) => f.id === l.flow?.flowId)?.name).filter(Boolean))] as string[];
                          return (
                            <button
                              key={x.id}
                              className={`flex w-full items-center gap-3 rounded-2xl px-4 py-2.5 text-left ring-1 ${x.id === activePart ? "bg-accent-soft ring-accent" : "bg-panel ring-line/60"}`}
                              onClick={() => openFlowSheet({ sectionId: x.id, fromLineId: null, flowId: x.lines.find((l) => l.flow?.flowId)?.flow?.flowId ?? null })}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm font-semibold">{x.name}</span>
                                <PartLength range={partRange(x)} bar={bar} />
                              </span>
                              <span className={`text-xs font-semibold ${names.length ? "text-accent" : "text-muted"}`}>{names.length ? names.join(" · ") : "no flow yet"}</span>
                              <ChevronRight className="h-4 w-4 text-muted" />
                            </button>
                          );
                        })}
                    </div>
                    <p className="label mt-6">Or record the whole song at once</p>
                  </div>
                )}
                {/* sing it or tap it */}
                <div className="mb-5 flex w-full rounded-full bg-panel-2 p-1" role="tablist">
                  {(
                    [
                      ["sing", Mic, "Sing"],
                      ["tap", Hand, "Tap"],
                      ["both", Hand, "Sing + tap"],
                    ] as const
                  ).map(([m, Icon, label]) => (
                    <button
                      key={m}
                      role="tab"
                      aria-selected={flowMode === m}
                      className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-sm font-semibold transition-colors ${flowMode === m ? "bg-accent text-white shadow-sm" : "text-muted"}`}
                      onClick={() => setFlowMode(m)}
                    >
                      <Icon className="h-4 w-4" /> {label}
                    </button>
                  ))}
                </div>
                <h2 className="text-2xl font-extrabold">
                  {flowMode === "tap" ? "Tap your flow" : flowMode === "both" ? "Sing and tap your flow" : "Record your flow"}
                  {part ? ` for ${part.name}` : ""}
                </h2>
                <p className="mt-2 max-w-sm text-sm text-muted">
                  {part
                    ? `${fmtTime(part.start)} – ${fmtTime(part.end)}. The beat starts one bar before the part — come in on it. The rest of the song stays. `
                    : "The beat plays from the start. "}
                  {flowMode === "tap"
                    ? "Tap once per syllable in your rhythm, and “Next line” where a line ends. No microphone needed."
                    : flowMode === "both"
                      ? "Sing or rap while you tap: your taps count the syllables and mark the lines; your voice fixes the timing and the stresses, and your words go into the lyrics."
                    : "Sing or rap anything over it — real words, “na-na”, anything. Your rhythm and your words become the lyrics."}
                </p>
                {part && (
                  <button className="mt-1 text-xs text-muted underline" onClick={() => setPart(null)}>
                    Do the whole song instead
                  </button>
                )}
                <ol className="mt-5 w-full space-y-2 text-left text-sm">
                  {flowMode !== "tap" && (
                    <li className="flex items-center gap-3 rounded-2xl bg-panel px-4 py-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"><Headphones className="h-4 w-4" /></span>
                      <span>Put on headphones (wired is best) so the mic only hears you.</span>
                    </li>
                  )}
                  {flowMode !== "sing" && (
                    <li className="flex items-center gap-3 rounded-2xl bg-panel px-4 py-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"><Hand className="h-4 w-4" /></span>
                      <span>Two pads: the big one (right) once per syllable, on the beat you hear — “Next line” (left) when a line is done.</span>
                    </li>
                  )}
                  <li className="flex items-center gap-3 rounded-2xl bg-panel px-4 py-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                      {flowMode === "tap" ? <Hand className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                    </span>
                    <span>{part ? "It stops by itself at the part's end." : "Go over the whole beat — stop whenever you like."}</span>
                  </li>
                  <li className="flex items-center gap-3 rounded-2xl bg-panel px-4 py-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"><Sparkles className="h-4 w-4" /></span>
                    <span>
                      {part ? "You get this part's lines with 3 options for every line." : "You get a first version of the song with 3 options for every line."}
                      <span className="block text-xs text-muted">{flowMode === "tap" ? "1 AI call per 8 lines" : "1 word recognition + 1 AI call per 8 lines"}</span>
                    </span>
                  </li>
                </ol>
                {flowMode !== "tap" && (
                  <>
                    <label className="mt-4 flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={headphones} onChange={(e) => setHeadphones(e.target.checked)} />
                      I&apos;m wearing headphones
                    </label>
                    {!headphones && <p className="mt-1 text-xs text-warn">Without headphones the beat is filtered out of the mic as well as possible.</p>}
                  </>
                )}
                {flowMode === "sing" ? (
                  <button
                    className="mt-8 flex h-28 w-28 items-center justify-center rounded-full bg-[#dc2626] text-white shadow-xl shadow-red-500/30 active:scale-95 disabled:opacity-40"
                    disabled={!beatReady}
                    onClick={() => void startFlow()}
                    aria-label="Record your flow"
                  >
                    <span className="h-10 w-10 rounded-full bg-white" />
                  </button>
                ) : (
                  <button
                    className="mt-8 flex h-28 w-28 items-center justify-center rounded-full bg-accent text-white shadow-xl shadow-accent/30 active:scale-95 disabled:opacity-40"
                    disabled={!beatReady}
                    onClick={() => void startTapping()}
                    aria-label={flowMode === "both" ? "Start singing and tapping" : "Start tapping"}
                  >
                    <Hand className="h-11 w-11" />
                  </button>
                )}
                <p className="mt-3 text-sm font-semibold">{beatReady ? (flowMode === "sing" ? "Tap to start" : "Start the beat") : "Loading the beat…"}</p>
                {!part && (
                <button className="mt-8 flex w-full items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3.5 text-left" onClick={() => void readVocals()}>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-panel-2 text-muted">
                    <Lyrics className="h-[18px] w-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">Read the lyrics from the track</span>
                    <span className="block text-xs text-muted">Done automatically when you upload — tap if vocals were missed · 1 AI call per 8 lines</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted" />
                </button>
                )}
              </>
            )}
            {rec === "recording" && (
              <>
                <p className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-[#dc2626]">
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[#dc2626]" />
                  Recording your flow
                </p>
                <p className="mt-2 font-mono text-4xl font-bold tabular-nums">{fmtTime(Math.max(0, now))}</p>
                <p className="text-sm text-muted">{part ? `${part.name} ends at ${fmtTime(part.end)}` : `of ${fmtTime(total)}`}</p>
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
                <p className="mt-2 text-xs text-muted">{level < 0.02 ? "Not hearing you yet — sing or rap!" : "Hearing you"}</p>
                <button
                  className="mt-8 flex h-28 w-28 items-center justify-center rounded-full bg-fg text-bg shadow-xl active:scale-95"
                  onClick={() => void stopFlow()}
                  aria-label="Stop"
                >
                  <span className="h-9 w-9 rounded-md bg-bg" />
                </button>
                <p className="mt-3 text-sm font-semibold">Tap to finish</p>
              </>
            )}
            {rec === "tapping" && (
              <>
                <p className="font-mono text-3xl font-bold tabular-nums">{fmtTime(Math.max(0, now))}</p>
                <p className="text-sm text-muted">{part ? (now < part.start ? `${part.name} starts at ${fmtTime(part.start)} — get ready` : `${part.name} ends at ${fmtTime(part.end)}`) : `of ${fmtTime(total)}`}</p>
                <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
                  <div className="h-full bg-accent" style={{ width: `${part ? Math.max(0, Math.min(1, (now - part.start) / (part.end - part.start))) * 100 : total ? (Math.max(0, now) / total) * 100 : 0}%` }} />
                </div>
                <p className="mt-5 flex items-center justify-center gap-2 text-sm font-semibold">
                  {flowMode === "both" && (
                    <span className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-[#dc2626]">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-[#dc2626]" /> Voice
                    </span>
                  )}
                  Line {tapLine.n} · {tapLine.count} syllable{tapLine.count === 1 ? "" : "s"}
                </p>
                {/* two pads: "next line" on the left, syllables on the right */}
                <div className="mt-3 flex w-full gap-2.5">
                  <button
                    className="flex h-72 flex-[2] touch-manipulation select-none flex-col items-center justify-center gap-3 rounded-[2rem] bg-accent text-white shadow-xl shadow-accent/30 active:bg-accent/85"
                    onPointerDown={(ev) => {
                      ev.preventDefault();
                      tapNow();
                    }}
                    aria-label="Syllable"
                  >
                    <Hand className="h-12 w-12" />
                    <span className="text-2xl font-extrabold">Tap!</span>
                    <span className="text-xs opacity-80">one per syllable</span>
                  </button>
                  <button
                    className="order-first flex h-72 flex-1 touch-manipulation select-none flex-col items-center justify-center gap-2 rounded-[2rem] bg-fg text-bg shadow-xl active:opacity-85"
                    onPointerDown={(ev) => {
                      ev.preventDefault();
                      nextLine();
                    }}
                    aria-label="Next line"
                  >
                    <LineBreak className="h-10 w-10" />
                    <span className="text-base font-bold leading-tight">
                      Next
                      <br />
                      line
                    </span>
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted">{tapCount} syllables in all — no “next line”? Your pauses start the lines.</p>
                <button className="btn mt-5 rounded-full border-0 bg-panel-2 px-6 py-3 text-[15px] font-semibold" onClick={() => void finishTapping()}>
                  <Check className="h-4 w-4" /> Done
                </button>
              </>
            )}
            {rec === "processing" && (
              <>
                <h2 className="text-2xl font-extrabold">{source === "vocals" ? "Reading your song…" : part ? `Writing ${part.name}…` : "Writing your song…"}</h2>
                <ul className="mt-6 w-full space-y-2 text-left">
                  {(source === "vocals" ? VOCAL_STEPS : source === "tap" ? TAP_STEPS : STEPS).map((s, i, steps) => {
                    const cur = steps.findIndex((x) => x.key === step?.key);
                    const state = i < cur ? "done" : i === cur ? "now" : "todo";
                    return (
                      <li key={s.key} className={`flex items-center gap-3 rounded-2xl px-4 py-3 ${state === "now" ? "bg-accent-soft" : "bg-panel"}`}>
                        <span className="w-5 text-center">
                          {state === "done" ? (
                            <Check className="h-4 w-4 text-ok" />
                          ) : state === "now" ? (
                            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent border-r-transparent" />
                          ) : (
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted/50" />
                          )}
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
              <Mic className="h-4 w-4" /> Record your flow
            </button>
          </div>
        )}
        {view === "lyrics" && hasLines && (
          <div className="space-y-6">
            {missing.length > 0 && (
              <button
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-accent-soft px-4 py-3 text-sm font-semibold text-accent disabled:opacity-50"
                disabled={busyLine === "missing"}
                onClick={() =>
                  void lineAction("missing", async () => {
                    for (const ids of chunkLines(lyricLines.filter((l) => missing.includes(l.id)))) await call(`/api/projects/${pid}/flow`, { action: "suggest", lineIds: ids });
                  }, "Missing lines written")
                }
              >
                <Sparkles className="h-4 w-4" />
                {busyLine === "missing"
                  ? "Writing…"
                  : `Write the ${missing.length} empty line${missing.length === 1 ? "" : "s"} · ${missingCalls} call${missingCalls === 1 ? "" : "s"}`}
              </button>
            )}
            {tree.sections.map((s) => {
              const lines = s.lines.filter((l) => l.kind === "lyric") as LyricLine[];
              if (!lines.length) return null;
              if (isEmptyPart(s)) {
                const r = partRange(s);
                const calls = chunkLines(lines).length;
                return (
                  <section key={s.id} id={`part-${s.id}`} data-part-section={s.id} className="scroll-mt-44">
                    <h3 className="mb-2 flex items-baseline gap-2 px-1">
                      <button
                      className="flex items-center gap-1 rounded-lg text-lg font-bold tracking-tight active:bg-panel-2"
                      onClick={() => setPartMenu(s.id)}
                      title="Rename or merge this part"
                    >
                      {s.name}
                      <Pencil className="h-3.5 w-3.5 text-muted" />
                    </button>
                      <PartLength range={r} bar={beatGrid ? bar : null} />
                      <span className="text-xs text-muted">no vocals yet</span>
                      {tree.audio && <PartVocals off={partVocalsOff(s.id)} busy={separating} onToggle={() => void togglePartVocals(s.id)} />}
                    </h3>
                    <div className="space-y-2.5 rounded-3xl border border-dashed border-accent/40 bg-accent-soft/30 p-4">
                      <p className="text-sm">
                        <b>{lines.length} lines to write</b>
                      </p>
                      <button
                        className="btn-primary w-full justify-center rounded-2xl py-3 text-[15px] disabled:opacity-50"
                        disabled={!beatGrid}
                        onClick={() => openFlowSheet({ sectionId: s.id, fromLineId: null, flowId: null })}
                      >
                        <AudioLines className="h-[18px] w-[18px]" /> Set the flow
                        <span className="text-xs font-normal opacity-80">write · sing · tap</span>
                      </button>
                      <div className="flex gap-2">
                        <button className="btn flex-1 justify-center rounded-2xl border-0 py-2.5 text-sm" disabled={!beatReady} onClick={() => void play(Math.max(0, r.start - bar), r.end)}>
                          <Play className="h-4 w-4" /> Listen
                        </button>
                        <button
                          className="btn flex-1 justify-center rounded-2xl border-0 py-2.5 text-sm disabled:opacity-50"
                          disabled={busyLine === s.id}
                          onClick={() =>
                            void lineAction(s.id, async () => {
                              for (const ids of chunkLines(lines)) await call(`/api/projects/${pid}/flow`, { action: "suggest", lineIds: ids });
                            }, `Lines for ${s.name}`)
                          }
                          title="Write the lines without a flow (free rhythm, fitting the song around them)"
                        >
                          <Sparkles className="h-4 w-4" />
                          {busyLine === s.id ? "Writing…" : `Write · ${calls} call${calls === 1 ? "" : "s"}`}
                        </button>
                      </div>
                    </div>
                  </section>
                );
              }
              return (
                <section key={s.id} id={`part-${s.id}`} data-part-section={s.id} className="scroll-mt-44">
                  <h3 className="mb-2 flex items-center gap-2 px-1">
                    <button
                      className="flex items-center gap-1 rounded-lg text-lg font-bold tracking-tight active:bg-panel-2"
                      onClick={() => setPartMenu(s.id)}
                      title="Rename or merge this part"
                    >
                      {s.name}
                      <Pencil className="h-3.5 w-3.5 text-muted" />
                    </button>
                    <PartLength range={partRange(s)} bar={beatGrid ? bar : null} />
                    {busyLine === s.id && (
                      <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-accent">
                        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-r-transparent" /> Writing lyrics…
                      </span>
                    )}
                    {tree.audio && <PartVocals off={partVocalsOff(s.id)} busy={separating} onToggle={() => void togglePartVocals(s.id)} />}
                    {tree.audio && (
                      <button
                        className="flex shrink-0 items-center gap-1 rounded-full bg-panel-2 px-2.5 py-1 text-xs font-semibold text-accent disabled:opacity-50"
                        disabled={!beatReady || guideBusy !== null}
                        onClick={() => void hearPart(s)}
                        title="The whole part in your voice, on its flow (1 call per line not spoken yet)"
                      >
                        <Headphones className="h-3.5 w-3.5" />
                        {guideBusy === s.id ? "Speaking…" : "Hear"}
                      </button>
                    )}
                    {beatGrid && (
                      <button
                        className="flex shrink-0 items-center gap-1 rounded-full bg-panel-2 px-2.5 py-1 text-xs font-semibold text-accent"
                        onClick={() => openFlowSheet({ sectionId: s.id, fromLineId: null, flowId: lines[0]?.flow?.flowId ?? null })}
                        title="The flow of this part: write, sing or tap it"
                      >
                        <AudioLines className="h-3.5 w-3.5" />
                        {[...new Set(lines.map((l) => tree.flows.find((f) => f.id === l.flow?.flowId)?.name).filter(Boolean))].map((n) => (n as string).replace("Flow ", "")).join(" · ") ? (
                          <>Flow {[...new Set(lines.map((l) => tree.flows.find((f) => f.id === l.flow?.flowId)?.name).filter(Boolean))].map((n) => (n as string).replace("Flow ", "")).join(" · ")}</>
                        ) : (
                          "Flow"
                        )}
                      </button>
                    )}
                  </h3>
                  <div className="space-y-2.5">
                    {rhymeGroups(lines).map(({ lines: group, pairs }) => {
                      const bad = pairs.find(([a, b]) => !rhymesWell(a.text, b.text, lang));
                      const off = !!bad;
                      const idx = lines.indexOf(group[0]);
                      // a new flow starts here (within the part)
                      const flowStart = idx > 0 && group[0].flow?.flowId && group[0].flow.flowId !== lines[idx - 1].flow?.flowId ? tree.flows.find((f) => f.id === group[0].flow?.flowId) : null;
                      return (
                      <div key={group[0].id}>
                      {flowStart && (
                        <button
                          className="mb-1.5 ml-1 flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-semibold text-accent"
                          onClick={() => openFlowSheet({ sectionId: s.id, fromLineId: group[0].id, flowId: flowStart.id })}
                          title="The flow changes here — tap to change it"
                        >
                          <AudioLines className="h-3 w-3" /> {flowStart.name} from here
                        </button>
                      )}
                      <div className={group.length > 1 ? `border-l-2 pl-1 ${off ? "border-warn/60" : "border-accent/30"}` : "pl-[6px]"} title={group.length > 1 ? (group.length === 4 ? "Lines 1+3 and 2+4 rhyme" : "A couplet: these two lines rhyme") : undefined}>
                        {group.map((l) => {
                          // the line it rhymes with, as it is now: options are picked to rhyme with it
                          const pr = pairs.find(([a, b]) => a.id === l.id || b.id === l.id);
                          const partner = pr ? ((pr[0].id === l.id ? pr[1] : pr[0]) as LyricLine) : null;
                          // ↻ gives the next couplet that rhymes (this line's option, or a pair of options for both lines)
                          const moves = partner?.text.trim() ? rhymeMoves(l, partner, lang) : [];
                          return (
                          <LineCard
                            key={l.id}
                            line={l}
                            lang={lang}
                            live={live === l.id}
                            pair={group.length > 1 ? 1 : 0}
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
                                isKept(l) ? "Unkeep" : "Keep",
                              )
                            }
                            rhymingCount={partner?.text.trim() ? moves.length : null}
                            couplet={
                              partner
                                ? {
                                    pairs: pairMoves(l, partner, lang).length,
                                    busy: busyLine === partner.id,
                                    onNext: () => {
                                      const m = pairMoves(l, partner, lang)[0];
                                      if (m) void applyMove(l, m);
                                    },
                                    onNew: () => void newCouplet(l, partner),
                                  }
                                : undefined
                            }
                            onNext={() => {
                              // no other line to rhyme with: the next option in line
                              if (!partner?.text.trim()) return void lineAction(l.id, () => call(`/api/alternatives/${l.alternatives[0].id}`, { action: "swap" }), "Next option");
                              // never a couplet that doesn't rhyme: none of the options does → 3 new ones that do (1 call)
                              if (moves.length) void applyMove(l, moves[0]);
                              else void newRhyming(l, partner);
                            }}
                            onNew={() => void lineAction(l.id, () => call(`/api/projects/${pid}/flow`, { action: "suggest", lineIds: [l.id] }), "New options")}
                            onEdit={() => {
                              setEditing(l.id);
                              // the line with its symbols (double-time, breaks, holds) to edit them along
                              setDraft(toNotation(l.text.trim(), marksFor(l)));
                            }}
                            onSave={() => {
                              setEditing(null);
                              const { text, marks } = parseNotation(draft);
                              if (!text) return;
                              const before = marksFor(l);
                              const changed = text !== l.text.trim();
                              // the marks set in the editor (accent, up…) stay while the words do
                              const items = [...marks, ...(changed ? [] : untyped(before))];
                              const key = (m: Mark[]) => JSON.stringify([...m].sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind)));
                              if (changed)
                                void lineAction(l.id, () => call(`/api/lines/${l.id}`, { text, marks: { items }, status: "APPROVED_EDITED", action: "edit" }, "PATCH"), "Edit");
                              else if (key(items) !== key(before))
                                void lineAction(l.id, () => call(`/api/lines/${l.id}`, { marks: { items }, action: "marks" }, "PATCH"), "Marks");
                            }}
                            onCancel={() => setEditing(null)}
                            beatGrid={beatGrid}
                            gridOpen={gridLine === l.id}
                            onGrid={() => {
                              if (playing) stopPlay();
                              setGridLine(gridLine === l.id ? null : l.id);
                            }}
                            onStartTap={startTap}
                            onSing={singLine}
                            songTime={songTime}
                            open={openLine === l.id}
                            onToggle={() => setOpenLine(openLine === l.id ? null : l.id)}
                            onFlowFromHere={beatGrid ? () => openFlowSheet({ sectionId: s.id, fromLineId: l.id, flowId: l.flow?.flowId ?? null }) : undefined}
                            onSaveMarks={(m) => void lineAction(l.id, () => call(`/api/lines/${l.id}`, { marks: { items: m }, action: "marks" }, "PATCH"), "Marks")}
                            onNewPart={
                              s.lines.findIndex((x) => x.id === l.id) > 0
                                ? () => {
                                    const name = window.prompt("Name of the new part (it starts with this line):", "Rap");
                                    if (!name?.trim()) return;
                                    void lineAction(
                                      l.id,
                                      async () => {
                                        const t = await call(`/api/lines/${l.id}`, { action: "splitSection", name: name.trim(), start: l.audio_at ?? null });
                                        const created = t?.sections.find((x) => x.lines.some((y) => y.id === l.id));
                                        if (created) {
                                          setActivePart(created.id);
                                          setTimeout(() => document.getElementById(`part-${created.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
                                        }
                                      },
                                      `New part “${name.trim()}”`,
                                    );
                                  }
                                : undefined
                            }
                            onSaveGrid={(flow, write) =>
                              void lineAction(l.id, async () => {
                                setGridLine(null);
                                await call(`/api/lines/${l.id}`, { flow, action: "flow" }, "PATCH");
                                if (write) await call(`/api/projects/${pid}/flow`, { action: "suggest", lineIds: [l.id] });
                              }, "Flow of a line")
                            }
                            voiceLabel={voice && !spoken.has(l.id) ? "1 call" : ""}
                            voiceBusy={guideBusy === l.id}
                            onVoice={() => void hearLine(l)}
                            onRemove={() => {
                              if (window.confirm("Remove this line?")) void lineAction(l.id, () => call(`/api/lines/${l.id}`, undefined, "DELETE"), "Remove line");
                            }}
                          />
                          );
                        })}
                        {/* a couplet that doesn't rhyme: a small hint at its end, tap to fix it */}
                        {bad && (
                          <div className="-mt-0.5 flex justify-end pr-2">
                            <button
                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold text-warn/90 active:bg-warn-soft disabled:opacity-50"
                              disabled={busyLine === bad[1].id}
                              onClick={() => void makeItRhyme(bad[0] as LyricLine, bad[1] as LyricLine)}
                              title={`“${lastWordOf(bad[0].text)}” and “${lastWordOf(bad[1].text)}” don't rhyme — tap to make it rhyme`}
                              aria-label={`“${lastWordOf(bad[0].text)}” and “${lastWordOf(bad[1].text)}” don't rhyme — make it rhyme`}
                            >
                              <Sparkles className="h-3 w-3" />
                              {busyLine === bad[1].id ? "rhyming…" : "no rhyme · fix"}
                            </button>
                          </div>
                        )}
                      </div>
                      </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}

        {/* ----- RECORD ----- */}
        {view === "record" &&
          (tree.audio ? (
            <RecordView
              muted={muted}
              onMix={() => setView("mix")}
              part={activePart}
              onPart={setActivePart}
              tree={tree}
              setTree={setTree}
              engine={engine}
              beat={beat}
              beatReady={beatReady}
              bar={bar}
              beatLength={tree.audio.bpm ? 60 / tree.audio.bpm : bar / 4}
              rangeOf={(id) => {
                const s = tree.sections.find((x) => x.id === id);
                return s ? partRange(s) : null;
              }}
              timeline={timeline}
              initialOn={recordOn}
              onBusy={setRecBusy}
            />
          ) : (
            <div className="mt-16 text-center">
              <p className="text-muted">Upload your beat first — then record your voice on it, part by part.</p>
              <button className="btn-primary mt-4 rounded-full px-5 py-2.5" onClick={() => setView("flow")}>
                Upload a beat
              </button>
            </div>
          ))}

        {/* ----- MIX: the mixer ----- */}
        {view === "mix" && (
          <Mixer
            tree={tree}
            lanes={lanesOf(tree).filter((l) => l !== "Flow")}
            parts={tree.sections.filter((x) => x.audio_start !== null).map((x) => ({ id: x.id, name: x.name, ...partRange(x) }))}
            total={total}
            playing={playing}
            now={now}
            onPlay={(from) => void play(from)}
            onStop={stopPlay}
            onSeek={(t) => (playing ? void play(t) : setNow(t))}
            setChannel={setChannel}
            setSound={async (lane, preset) => {
              await call(`/api/projects/${pid}`, { action: "setSound", lane, preset });
              // playing: heard with the new sound from here on
              if (playing && !controller) void play(engine.current?.position() ?? now, stopAt.current);
            }}
            hasFlow={flowTakes.length > 0}
            voice={withGuide && !!voice}
            vocals={instrumental ? { on: vocalsOff !== "all" && vocalsOff.length === 0, toggle: () => setVocalsOff(vocalsOff !== "all" && vocalsOff.length === 0 ? "all" : []) } : null}
            onSeparate={() => void separate()}
            separating={separating}
            call={call}
            onExport={beatReady ? exportStems : null}
            liveTake={(id, m) => {
              if (m.gain !== undefined) engine.current?.setLayerGain(id, m.gain);
              if (m.pan !== undefined) engine.current?.setLayerPan(id, m.pan);
            }}
          />
        )}

        {/* ----- MORE ----- */}
        {view === "more" && (
          <MoreView
            tree={tree}
            voice={voice ?? null}
            onVoice={() => setVoiceSheet(true)}
            onRename={(title) => void call(`/api/projects/${pid}`, { title }, "PATCH")}
            onLanguage={(language) => void call(`/api/projects/${pid}`, { language }, "PATCH")}
            vocals={{ split: !!instrumental, off: vocalsOff, set: setVocalsOff, separate: () => void separate(), busy: separating }}
            onDelete={async () => {
              if (!window.confirm(`Delete “${tree.project.title}” for good?`)) return;
              await fetch(`/api/projects/${pid}`, { method: "DELETE" });
              router.push("/");
            }}
          />
        )}
      </main>

      {flowSheet &&
        beatGrid &&
        (() => {
          const sec = tree.sections.find((x) => x.id === flowSheet.sectionId);
          if (!sec) return null;
          const st = stretchOf(sec, flowSheet.fromLineId);
          return (
            <FlowSheet
              title={sec.name}
              scope={flowSheet.fromLineId ? `line ${st.lineNo} on` : "the whole part"}
              flows={flowsUsed}
              initialFlowId={flowSheet.flowId}
              lang={lang}
              bar={bar}
              barStart={st.start}
              linesInStretch={st.lines}
              stretchSeconds={st.end - st.start}
              brief={tree.project.settings?.briefs?.[sec.id] ?? null}
              audio={sheetAudio}
              onUse={useFlow}
              onClose={() => {
                stopPlay();
                setFlowSheet(null);
              }}
            />
          );
        })()}
      {partMenu &&
        (() => {
          const i = tree.sections.findIndex((x) => x.id === partMenu);
          const sec = tree.sections[i];
          if (!sec) return null;
          return (
            <PartMenu
              name={sec.name}
              prev={tree.sections[i - 1]?.name ?? null}
              next={tree.sections[i + 1]?.name ?? null}
              onRename={() => renamePart(sec)}
              onMergePrev={() => mergePart(sec.id)}
              onMergeNext={() => mergePart(tree.sections[i + 1].id)}
              onExtend={tree.audio?.bpm && partRange(sec).end > partRange(sec).start ? (bars) => extendPart(sec.id, bars) : null}
              onCopy={tree.audio?.bpm && sec.audio_start !== null ? () => setCopied(sec.id) : null}
              pasting={copied ? (tree.sections.find((x) => x.id === copied)?.name ?? null) : null}
              onPaste={() => pastePart(sec.id)}
              onClose={() => setPartMenu(null)}
            />
          );
        })()}
      {voiceSheet && (
        <VoiceSheet
          engine={engine}
          lang={lang}
          current={voice ?? null}
          onClose={() => setVoiceSheet(false)}
          onDone={(v) => {
            setVoice(v);
            setSpoken(new Set());
            setVoiceSheet(false);
            if (!v) setWithGuide(false);
          }}
        />
      )}

      {/* tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-lg border-t border-line/70 bg-panel/90 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
        {(
          [
            ["flow", Waveform, "Flow"],
            ["lyrics", Lyrics, "Lyrics"],
            ["record", Mic, "Record"],
            ["mix", Sliders, "Mix"],
            ["more", Ellipsis, "More"],
          ] as const
        ).map(([v, Icon, label]) => (
          <button
            key={v}
            disabled={rec !== null || recBusy}
            className={`flex flex-1 flex-col items-center gap-1 pb-2 pt-2.5 text-[11px] font-semibold transition-colors ${view === v ? "text-accent" : "text-muted"}`}
            onClick={() => {
              if (playing) stopPlay();
              setView(v);
            }}
          >
            <span className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors ${view === v ? "bg-accent-soft" : ""}`}>
              <Icon className="h-[22px] w-[22px]" />
            </span>
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
  /** 1 / 2: first / second line of a rhyming couplet — its last word is the rhyme */
  pair?: 0 | 1 | 2;
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
  voiceLabel: string;
  voiceBusy: boolean;
  onVoice: () => void;
  beatGrid: BeatGrid | null;
  gridOpen: boolean;
  onGrid: () => void;
  onStartTap: (g: FlowGridModel) => void;
  onSing: (g: FlowGridModel) => Promise<number[]>;
  songTime: () => number;
  onSaveGrid: (f: NonNullable<Line["flow"]>, write: boolean) => void;
  /** options rhyming with the couplet's other line (null: no partner) */
  rhymingCount: number | null;
  /** the whole couplet (this line and the one it rhymes with): the next rhyming pair of options (free), or a new pair (1 call) */
  couplet?: { pairs: number; onNext: () => void; onNew: () => void; busy: boolean };
  /** opened: its flow, details and actions show (one line at a time) */
  open: boolean;
  /** a new flow from this line on (for the rest of the part, or of the flow it follows) */
  onFlowFromHere?: () => void;
  /** this line starts a new part (e.g. "Rap"); not on a part's first line */
  onNewPart?: () => void;
  /** notes for recording on the words */
  onSaveMarks: (marks: Mark[]) => void;
  onToggle: () => void;
}) {
  const { line: l, lang } = props;
  const kept = l.status === "APPROVED" || l.status === "APPROVED_EDITED";
  // notes for recording on the words (pause, double-time…)
  const marks = marksFor(l);
  const [marking, setMarking] = useState(false);
  // the symbol bar while writing: a symbol where the cursor is (double-time joins the words around it)
  const editBox = useRef<HTMLTextAreaElement | null>(null);
  const insertSymbol = (sym: string) => {
    const el = editBox.current;
    const v = props.draft;
    let a = el?.selectionStart ?? v.length;
    let b = el?.selectionEnd ?? v.length;
    let out: string;
    if (sym === "_") {
      // words selected: all joined; else the space next to the cursor becomes the join
      if (b > a) {
        out = v.slice(0, a) + v.slice(a, b).trim().replace(/\s+/g, "_") + v.slice(b);
        b = a + v.slice(a, b).trim().length;
      } else {
        // the gap the cursor is in (or the next one): the words around it joined, a break in it kept ("ci/_divide")
        const gap = /[\s/|~^]/;
        let l = a;
        if (!gap.test(v[l - 1] ?? "") && !gap.test(v[l] ?? "")) while (l < v.length && !gap.test(v[l])) l++;
        while (l > 0 && gap.test(v[l - 1])) l--;
        let r = l;
        while (r < v.length && gap.test(v[r])) r++;
        if (l === 0 || r >= v.length) return;
        const syms = v.slice(l, r).replace(/\s+/g, "");
        out = v.slice(0, l) + syms + "_" + v.slice(r);
        b = l + syms.length + 1;
      }
    } else {
      // after the word the cursor is in or after
      while (a < v.length && /\S/.test(v[a]) && !/[/|~^]/.test(v[a])) a++;
      const ins = sym.startsWith(" ") && v[a - 1] === " " ? sym.trimStart() : sym;
      out = v.slice(0, a) + ins + v.slice(a).replace(/^ /, ins.endsWith(" ") ? "" : " ");
      b = a + ins.length;
    }
    props.setDraft(out.replace(/ {2,}/g, " "));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(b, b);
    });
  };
  const target = l.flow?.syllables ?? null;
  const syl = l.text.trim() ? prosody(l.text, lang).syllables : 0;
  const fits = target !== null && syl > 0 ? Math.abs(syl - target) <= 1 : null;
  const lineText = (
    <span className={`text-[17px] leading-snug ${l.text.trim() ? "" : "italic text-muted"}`}>
      {l.text.trim() ? (
        untyped(marks).length ? (
          <MarkedText text={l.text.trim()} marks={marks} />
        ) : (
          <FlowText text={l.text.trim()} lang={lang} flow={l.flow} rhyme={!!props.pair} marks={marks} />
        )
      ) : props.busy ? (
        "Writing…"
      ) : l.flow?.syllables ? (
        `e.g. “${exampleWords(l.flow.syllables, l.flow.stress, lang, l.position)}”`
      ) : (
        "…"
      )}
    </span>
  );
  // closed: just the text — the lyrics read like a sheet; tap to open the line
  if (!props.open && !props.editing && !props.gridOpen) {
    return (
      <button
        id={`line-${l.id}`}
        onClick={props.onToggle}
        className={`flex w-full items-start gap-2 rounded-2xl px-3 py-1 text-left transition-colors ${props.live ? "bg-accent-soft" : "active:bg-panel-2"}`}
      >
        <span className="min-w-0 flex-1">{lineText}</span>
        {props.busy ? (
          <span className="mt-2 inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent border-r-transparent" />
        ) : (
          kept && <Check className="mt-2 h-4 w-4 shrink-0 text-ok" aria-label="kept" />
        )}
      </button>
    );
  }
  return (
    <div
      id={`line-${l.id}`}
      className={`my-1 rounded-3xl px-4 py-3 shadow-[0_2px_10px_rgba(0,0,0,0.06)] ring-1 transition-colors ${
        props.live ? "bg-accent-soft ring-accent" : kept ? "bg-panel ring-ok/40" : "bg-panel ring-line/70"
      }`}
    >
      {props.editing ? (
        <div className="space-y-2">
          <textarea
            ref={editBox}
            className="input min-h-16 text-[17px]"
            autoFocus
            value={props.draft}
            onChange={(e) => props.setDraft(e.target.value.replace(/\n/g, " "))}
          />
          {/* symbols for recording: kept with the line, out of its text (rhymes and the AI don't see them) */}
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            {NOTATION_KEYS.map((k) => (
              <button
                key={k.kind}
                className="flex shrink-0 items-center gap-1 rounded-full bg-panel-2 px-2.5 py-1.5 text-xs font-semibold text-fg/80 active:bg-accent-soft"
                // the keyboard stays open
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertSymbol(k.insert)}
              >
                <span className="font-mono font-bold text-accent">{k.insert.trim()}</span>
                {k.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted">
            <b className="font-mono text-accent">_</b> joins words in double-time · <b className="font-mono text-accent">/</b> short break · <b className="font-mono text-accent">{"//"}</b> long break ·{" "}
            <b className="font-mono text-accent">~</b> hold · <b className="font-mono text-accent">^</b> breath — Hear and the karaoke follow them.
          </p>
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
          <button className="block w-full text-left" onClick={props.onToggle} title="Close">
            {lineText}
          </button>
          {props.beatGrid && (l.flow || l.audio_at !== null) ? (
            <button className="group mt-1.5 flex items-center gap-2" onClick={props.onGrid} title="Set this line's flow: sing it or tap it" aria-expanded={props.gridOpen}>
              {l.flow?.syllables ? <Pattern flow={l.flow} /> : null}
              <span className={`mt-1.5 flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-semibold ${props.gridOpen ? "bg-accent text-white" : "bg-panel-2 text-accent group-active:bg-accent-soft"}`}>
                <Hand className="h-3.5 w-3.5" /> {l.flow?.syllables ? "Flow" : "Set the flow"}
              </span>
            </button>
          ) : (
            l.flow && <Pattern flow={l.flow} />
          )}
          {props.gridOpen && props.beatGrid && (
            <TapFor
              line={l}
              lang={lang}
              beatGrid={props.beatGrid}
              onStart={props.onStartTap}
              onSing={props.onSing}
              songTime={props.songTime}
              onSave={props.onSaveGrid}
              onCancel={props.onGrid}
            />
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            <button
              className="flex shrink-0 items-center gap-1 rounded-full bg-panel-2 px-2.5 py-1 font-semibold text-fg/80"
              onClick={props.onPlay}
              title="Play this bar"
            >
              <Play className="h-3 w-3" /> Play
            </button>
            {props.onFlowFromHere && (
              <button
                className="flex shrink-0 items-center gap-1 rounded-full bg-panel-2 px-2.5 py-1 font-semibold text-accent"
                onClick={props.onFlowFromHere}
                title="A new flow from this line on"
              >
                <AudioLines className="h-3 w-3" /> Flow from here
              </button>
            )}
            {l.text.trim() && (
              <button
                className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 font-semibold ${marking || marks.length ? "bg-accent-soft text-accent" : "bg-panel-2 text-fg/80"}`}
                onClick={() => setMarking((m) => !m)}
                title="Notes for recording on the words: pause, breath, double-time, stretch…"
              >
                <span className="font-bold">‖</span> Marks{marks.length ? ` · ${marks.length}` : ""}
              </button>
            )}
            {props.onNewPart && (
              <button
                className="flex shrink-0 items-center gap-1 rounded-full bg-panel-2 px-2.5 py-1 font-semibold text-fg/80"
                onClick={props.onNewPart}
                title="A new part starts with this line (e.g. Rap, Hook, Bridge)"
              >
                <Plus className="h-3 w-3" /> New part here
              </button>
            )}
            {target !== null && (
              <span className={fits === false ? "text-warn" : fits ? "text-ok" : ""} title={`You sang ${target} syllables here`}>
                {syl || "–"}/{target} syl
              </span>
            )}
            {l.flow?.source === "vocals" ? (
              l.text.trim() === l.flow.words.trim() ? (
                <span className="flex items-center gap-1 font-semibold text-accent">
                  · <Mic className="h-3 w-3" /> your recording
                </span>
              ) : (
                <span className="min-w-0 truncate">· recorded “{l.flow.words}”</span>
              )
            ) : (
              l.flow?.words && <span className="min-w-0 truncate">· you sang “{l.flow.words}”</span>
            )}
            {l.text.trim() && (
              <button
                className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent disabled:opacity-50"
                disabled={props.voiceBusy}
                onClick={props.onVoice}
                title="Hear this line rapped in your voice, on your flow"
              >
                {props.voiceBusy ? (
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-r-transparent" />
                ) : (
                  <AudioLines className="h-3.5 w-3.5" />
                )}{" "}
                Hear
                {props.voiceLabel && <span className="font-normal text-muted">· {props.voiceLabel}</span>}
              </button>
            )}
          </div>
          {marking && (
            <MarksEditor
              text={l.text.trim()}
              marks={marks}
              onCancel={() => setMarking(false)}
              onSave={(m) => {
                setMarking(false);
                props.onSaveMarks(m);
              }}
            />
          )}
          <div className="mt-3 flex items-center gap-1.5">
            <button
              className={`flex h-10 flex-[1.4] items-center justify-center gap-1.5 rounded-2xl text-sm font-semibold transition-colors ${kept ? "bg-ok text-white" : "bg-ok-soft text-ok"}`}
              disabled={props.busy || !l.text.trim()}
              onClick={props.onKeep}
            >
              <Check className="h-4 w-4" />
              {kept ? "Kept" : "Keep"}
            </button>
            <button
              className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-2xl bg-panel-2 text-sm font-semibold text-fg/80 disabled:opacity-40"
              disabled={props.busy || (l.alternatives.length === 0 && props.rhymingCount === null)}
              onClick={props.onNext}
              title={
                props.rhymingCount === null
                  ? "Next option (free)"
                  : props.rhymingCount
                    ? `Next couplet that rhymes (${props.rhymingCount}) — free`
                    : "None of the options rhymes with the other line — 3 new ones that do (1 AI call)"
              }
              aria-label={props.rhymingCount === 0 ? "New rhyming options, 1 call" : "Next option"}
            >
              <Shuffle className="h-4 w-4" />
              {props.rhymingCount !== null ? (
                <span className="flex flex-col items-start leading-none">
                  <span>{props.rhymingCount || "New"}</span>
                  <span className={`text-[9px] font-medium ${props.rhymingCount ? "text-ok" : "text-warn"}`}>{props.rhymingCount ? "rhyme" : "1 call"}</span>
                </span>
              ) : (
                l.alternatives.length || ""
              )}
            </button>
            <button
              className="flex h-10 flex-1 items-center justify-center gap-1 rounded-2xl bg-panel-2 text-sm font-semibold text-accent disabled:opacity-40"
              disabled={props.busy}
              onClick={props.onNew}
              title="3 new options for this bar (1 AI call)"
              aria-label="3 new options, 1 call"
            >
              {props.busy ? (
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent border-r-transparent" />
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  <span className="text-[10px] font-medium text-muted">1 call</span>
                </>
              )}
            </button>
            <button className="flex h-10 w-10 items-center justify-center rounded-2xl bg-panel-2 text-fg/70" onClick={props.onEdit} aria-label="Edit">
              <Pencil className="h-4 w-4" />
            </button>
            <button className="flex h-10 w-10 items-center justify-center rounded-2xl bg-panel-2 text-bad/80" onClick={props.onRemove} aria-label="Remove">
              <Trash className="h-4 w-4" />
            </button>
          </div>
          {props.couplet && (
            <div className="mt-2 flex items-center gap-1.5">
              <span className="flex-1 whitespace-nowrap pl-1 text-xs font-semibold text-muted">Both lines</span>
              <button
                className="flex h-9 items-center gap-1.5 rounded-2xl bg-panel-2 px-3 text-[13px] font-semibold text-fg/80 disabled:opacity-40"
                disabled={props.busy || props.couplet.busy || !props.couplet.pairs}
                onClick={props.couplet.onNext}
                title={props.couplet.pairs ? `The next rhyming pair from the options (${props.couplet.pairs}) — free` : "No other rhyming pair in the options yet"}
              >
                <Shuffle className="h-4 w-4" />
                Next pair
                {props.couplet.pairs > 0 && <span className="text-[10px] font-medium text-ok">{props.couplet.pairs}</span>}
              </button>
              <button
                className="flex h-9 items-center gap-1.5 rounded-2xl bg-accent-soft px-3 text-[13px] font-semibold text-accent disabled:opacity-40"
                disabled={props.busy || props.couplet.busy}
                onClick={props.couplet.onNew}
                title="Write the couplet again: 3 new rhyming pairs for both lines (1 AI call)"
                aria-label="New couplet, 1 call"
              >
                {props.couplet.busy ? (
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent border-r-transparent" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                New couplet
                <span className="text-[10px] font-medium text-muted">1 call</span>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** lines in their couplets (as sung: flow.pair) — the two lines of a couplet are shown together */
/**
 * Lines grouped as they rhyme, in their order: a couplet (2 lines), a crossed ABAB stanza (4 lines),
 * or a line on its own — with the rhyme pairs inside each group (every line has a partner when it can).
 */
function rhymeGroups<T extends Line>(lines: T[]): { lines: T[]; pairs: [T, T][] }[] {
  const pairs = coupletsOf(lines);
  const at = new Map(lines.map((l, i) => [l.id, i]));
  const groups: { from: number; to: number; pairs: [T, T][] }[] = [];
  for (const pr of pairs) {
    const [x, y] = [at.get(pr[0].id)!, at.get(pr[1].id)!].sort((a, b) => a - b);
    const g = groups.find((g) => x <= g.to && y >= g.from);
    if (g) {
      g.from = Math.min(g.from, x);
      g.to = Math.max(g.to, y);
      g.pairs.push(pr);
    } else groups.push({ from: x, to: y, pairs: [pr] });
  }
  const out: { lines: T[]; pairs: [T, T][] }[] = [];
  for (let i = 0; i < lines.length; ) {
    const g = groups.find((g) => g.from === i);
    if (g) {
      out.push({ lines: lines.slice(g.from, g.to + 1), pairs: g.pairs });
      i = g.to + 1;
    } else out.push({ lines: [lines[i++]], pairs: [] });
  }
  return out;
}

/** from this score on two line endings count as a rhyme (assonance or better) */
const RHYMES = 0.55;
// the same word twice (sei / sei) is no rhyme: options ending on it don't count as rhyming
const rhymeScore = (x: string, y: string, lang: string) => {
  if (!x.trim() || !y.trim()) return 0;
  const c = compareLines(analyzeLine(x, lang), analyzeLine(y, lang));
  return c.quality === "identical" ? Math.min(c.score, 0.3) : c.score;
};
const isKept = (l: Line) => l.status === "APPROVED" || l.status === "APPROVED_EDITED";
type Option = LyricLine["alternatives"][number];
type RhymeMove = { alt: Option; partnerAlt?: Option };
/**
 * The rhyming couplets ↻ on a line goes through, in turn: its options that rhyme with the other line as it is;
 * then (the other line not kept) its options paired with the other line's option that rhymes best with them —
 * the options of a couplet were written in rhyming pairs. Swapped-out texts go to the back, so it cycles.
 */
/** "Next pair": both lines change — each option of this line with the other line's option that rhymes best with it */
function pairMoves(l: LyricLine, partner: LyricLine, lang: string): Required<RhymeMove>[] {
  if (isKept(l) || isKept(partner)) return [];
  return l.alternatives.flatMap((alt) => {
    const best = partner.alternatives.map((y) => ({ y, score: rhymeScore(y.text, alt.text, lang) })).sort((p, q) => q.score - p.score)[0];
    return best && best.score >= RHYMES ? [{ alt, partnerAlt: best.y }] : [];
  });
}
function rhymeMoves(l: LyricLine, partner: LyricLine, lang: string): RhymeMove[] {
  const own = l.alternatives.filter((x) => rhymeScore(partner.text, x.text, lang) >= RHYMES).map((alt) => ({ alt }));
  if (isKept(partner)) return own;
  const pairs = l.alternatives.flatMap((alt) => {
    if (own.some((m) => m.alt.id === alt.id)) return [];
    const best = partner.alternatives.map((y) => ({ y, score: rhymeScore(y.text, alt.text, lang) })).sort((p, q) => q.score - p.score)[0];
    return best && best.score >= RHYMES ? [{ alt, partnerAlt: best.y }] : [];
  });
  return [...own, ...pairs];
}
/** both lines written and their endings don't rhyme */
const rhymesWell = (x: string, y: string, lang: string) => !x.trim() || !y.trim() || rhymeScore(x, y, lang) >= RHYMES;
const lastWordOf = (t: string) => t.trim().split(/\s+/).pop()?.replace(/[^\p{L}\p{N}']+/gu, "") ?? "";

/** where a part starts and how long it is: "1:14 · 27 s · 10 bars" */
function PartLength({ range, bar }: { range: { start: number; end: number }; bar: number | null }) {
  const len = Math.max(0, range.end - range.start);
  const bars = bar ? Math.round(len / bar) : null;
  return (
    <span className="flex-1 truncate font-mono text-xs text-muted">
      {fmtTime(range.start)} · {len < 60 ? `${Math.round(len)} s` : fmtTime(len)}
      {bars ? ` · ${bars} bar${bars === 1 ? "" : "s"}` : ""}
    </span>
  );
}


/** tapping a line's flow (its bar on the beat taken once, when opened) */
function TapFor({
  line,
  lang,
  beatGrid,
  onStart,
  onSing,
  songTime,
  onSave,
  onCancel,
}: {
  line: Line;
  lang: string;
  beatGrid: BeatGrid;
  onStart: (g: FlowGridModel) => void;
  onSing: (g: FlowGridModel) => Promise<number[]>;
  songTime: () => number;
  onSave: (f: NonNullable<Line["flow"]>, write: boolean) => void;
  onCancel: () => void;
}) {
  const [win] = useState(() => gridFor(line.flow, line.audio_at, beatGrid));
  if (!win) return null;
  return (
    <TapFlow window={win} flow={line.flow} lang={lang} onStart={() => onStart(win)} onSing={() => onSing(win)} songTime={songTime} onSave={onSave} onCancel={onCancel} />
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
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white"><Music className="h-7 w-7" /></span>
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
  voice,
  onVoice,
  onRename,
  onLanguage,
  onDelete,
  vocals,
}: {
  vocals: { split: boolean; off: "all" | string[]; set: (off: "all" | string[]) => void; separate: () => void; busy: boolean };
  tree: ProjectTree;
  voice: VoiceInfo | null;
  onVoice: () => void;
  onRename: (t: string) => void;
  onLanguage: (l: string) => void;
  onDelete: () => void;
}) {
  const pid = tree.project.id;
  const [copied, setCopied] = useState(false);
  /** "Choose parts" open (before a part is picked) */
  const [choosing, setChoosing] = useState(false);
  const text = fullText(tree);
  const slug = tree.project.title.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase() || "lyrics";
  const row = "flex w-full items-center gap-3 rounded-2xl bg-panel px-4 py-3 text-left ring-1 ring-line/60";
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
      {tree.audio && (
        <div className="space-y-2">
          <p className="label">The song&apos;s vocals</p>
          {vocals.split ? (
            <>
              <div className="flex rounded-full bg-panel-2 p-1" role="radiogroup" aria-label="Play the song">
                {(
                  [
                    ["all", "Music only"],
                    ["none", "With vocals"],
                    ["parts", "Choose parts"],
                  ] as const
                ).map(([k, label]) => {
                  const mode = vocals.off === "all" ? "all" : vocals.off.length === 0 ? "none" : "parts";
                  const on = mode === k || (k === "parts" && choosing && mode !== "all");
                  return (
                    <button
                      key={k}
                      role="radio"
                      aria-checked={on}
                      className={`flex-1 rounded-full py-2 text-[13px] font-semibold transition-colors ${on ? "bg-panel text-fg shadow-sm" : "text-muted"}`}
                      onClick={() => {
                        setChoosing(k === "parts");
                        if (k === "all") vocals.set("all");
                        else if (k === "none") vocals.set([]);
                        else if (vocals.off === "all") vocals.set([]);
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {(choosing || (vocals.off !== "all" && vocals.off.length > 0)) && (
                <div className="space-y-1.5">
                  {tree.sections.map((x) => {
                    const off = vocals.off !== "all" && vocals.off.includes(x.id);
                    return (
                      <button
                        key={x.id}
                        className="flex w-full items-center gap-3 rounded-2xl bg-panel px-4 py-2.5 text-left ring-1 ring-line/60"
                        onClick={() => {
                          const cur = vocals.off === "all" ? [] : vocals.off;
                          vocals.set(off ? cur.filter((id) => id !== x.id) : [...cur, x.id]);
                        }}
                        role="switch"
                        aria-checked={off}
                      >
                        <span className="flex-1 text-sm font-semibold">{x.name}</span>
                        <span className={`text-xs ${off ? "font-semibold text-accent" : "text-muted"}`}>{off ? "vocals removed" : "original vocals"}</span>
                        <span className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${off ? "bg-accent" : "bg-line"}`}>
                          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${off ? "left-[18px]" : "left-0.5"}`} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <button className={row} disabled={vocals.busy} onClick={vocals.separate}>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-panel-2 text-accent">
                {vocals.busy ? <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent border-r-transparent" /> : <Mic className="h-[18px] w-[18px]" />}
              </span>
              <span className="flex-1">
                {vocals.busy ? "Removing the vocals… (about a minute)" : "Remove the vocals"}
                <span className="block text-xs text-muted">The music alone, for your own flow, lyrics and takes · 1 call</span>
              </span>
            </button>
          )}
          {vocals.split && <p className="px-1 text-xs text-muted">Playing, recording and flows use what you choose here, part by part. The vocals are still read for lyrics and flow.</p>}
        </div>
      )}
      {/* yours, not the song's: recording, timing, your voice, ElevenLabs, appearance */}
      <Link href="/settings" className={row}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-panel-2 "><Sliders className="h-[18px] w-[18px]" /></span>
        <span className="flex-1">
          Your settings
          <span className="block text-xs text-muted">Recording, timing, your voice, ElevenLabs, appearance — the same in every song</span>
        </span>
        <ChevronRight className="h-4 w-4 text-muted" />
      </Link>
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
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-panel-2 "><Copy className="h-[18px] w-[18px]" /></span>
          <span className="flex-1">{copied ? "Copied" : "Copy the lyrics"}</span>
        </button>
        <button className={row} disabled={!text} onClick={() => download(`${slug}.txt`, `${tree.project.title}\n\n${text}`)}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-panel-2 "><Download className="h-[18px] w-[18px]" /></span>
          <span className="flex-1">Download the lyrics (.txt)</span>
        </button>
      </div>
      <button className={row} onClick={onVoice}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-panel-2 text-accent"><User className="h-[18px] w-[18px]" /></span>
        <span className="flex-1">
          My voice
          <span className="block text-xs text-muted">
            {voice ? `${voice.name} · raps your lyrics on your flow` : "Record a minute of your voice once — it raps your lyrics on your flow"}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 text-muted" />
      </button>
      <div className="space-y-2">
        <p className="label">Advanced</p>
        <Link href={`/p/${pid}`} className={row}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-panel-2 "><Pencil className="h-[18px] w-[18px]" /></span>
          <span className="flex-1">
            Full editor
            <span className="block text-xs text-muted">sections, rhymes, patterns, performers, history</span>
          </span>
          <ChevronRight className="h-4 w-4 text-muted" />
        </Link>
      </div>
      <button className={`${row} text-bad`} onClick={onDelete}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-panel-2 text-bad"><Trash className="h-[18px] w-[18px]" /></span>
        <span className="flex-1">Delete this song</span>
      </button>
    </div>
  );
}

/**
 * The song with its vocals taken out where asked: the music without vocals in those stretches, the original
 * elsewhere, with a short crossfade at each edge.
 */
function withoutVocals(ctx: BaseAudioContext, full: AudioBuffer, music: AudioBuffer, off: { start: number; end: number | null }[]): AudioBuffer {
  if (!off.length) return full;
  const sr = full.sampleRate;
  const n = full.length;
  const out = ctx.createBuffer(full.numberOfChannels, n, sr);
  const fade = Math.round(0.05 * sr);
  const mix = new Float32Array(n);
  for (const r of off) {
    const a = Math.max(0, Math.round(r.start * sr));
    const b = Math.min(n, r.end === null || !Number.isFinite(r.end) ? n : Math.round(r.end * sr));
    for (let i = a; i < b; i++) mix[i] = Math.max(mix[i], Math.min(1, (i - a) / fade + (a === 0 ? 1 : 0), (b - i) / fade + (b === n ? 1 : 0)));
  }
  for (let c = 0; c < full.numberOfChannels; c++) {
    const f = full.getChannelData(c);
    const m = music.getChannelData(Math.min(c, music.numberOfChannels - 1));
    const o = out.getChannelData(c);
    for (let i = 0; i < n; i++) o[i] = mix[i] ? f[i] * (1 - mix[i]) + (m[i] ?? 0) * mix[i] : f[i];
  }
  return out;
}

/**
 * What you hear: the song's original vocals (once removed: on / off), your recorded flow, and each recording
 * layer (Lead, Double, Ad-libs…). Saved on this device; the vocals choice with the song.
 */
/** the original vocals in one part: on / off (not split yet: removing them is 1 call) */
function PartVocals({ off, busy, onToggle }: { off: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <button
      className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold disabled:opacity-50 ${off ? "bg-panel-2 text-muted" : "bg-accent-soft text-accent"}`}
      onClick={onToggle}
      disabled={busy}
      role="switch"
      aria-checked={!off}
      aria-label={off ? "Original vocals off in this part — turn them on" : "Original vocals on in this part — turn them off"}
      title={off ? "The original vocals are off here: you hear the music alone" : "The original vocals play here"}
    >
      <Mic className="h-3.5 w-3.5" />
      <span className={off ? "line-through" : ""}>{busy ? "Removing…" : "Vocals"}</span>
    </button>
  );
}

/** a part: rename it, or merge it with the part before / after (one undo step) */
function PartMenu(props: {
  name: string;
  prev: string | null;
  next: string | null;
  onRename: () => void;
  onMergePrev: () => void;
  onMergeNext: () => void;
  /** null: the part has no place on the beat */
  onExtend: ((bars: number) => void) | null;
  onCopy: (() => void) | null;
  /** the name of the part copied (to paste after this one) */
  pasting: string | null;
  onPaste: () => void;
  onClose: () => void;
}) {
  const act = (f: () => void) => () => {
    props.onClose();
    f();
  };
  const item = "flex w-full items-center gap-3 rounded-2xl bg-panel-2/70 px-4 py-3 text-left text-[15px] font-semibold";
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={props.onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg space-y-2.5 rounded-t-3xl bg-panel px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
        <h2 className="text-xl font-bold">{props.name}</h2>
        {props.pasting && (
          <button className={`${item} bg-accent-soft text-accent`} onClick={act(props.onPaste)}>
            <Copy className="h-4 w-4" />
            <span className="flex-1">
              Paste “{props.pasting}” after this part
              <span className="block text-xs font-normal text-muted">its bars of the beat, lines and flow — the rest of the song moves later</span>
            </span>
          </button>
        )}
        <button className={item} onClick={act(props.onRename)}>
          <Pencil className="h-4 w-4 text-muted" /> Rename
        </button>
        {props.onCopy && (
          <button className={item} onClick={act(props.onCopy)}>
            <Copy className="h-4 w-4 text-muted" />
            <span className="flex-1">
              Copy
              <span className="block text-xs font-normal text-muted">then open another part and paste it after that one</span>
            </span>
          </button>
        )}
        {props.prev && (
          <button className={item} onClick={act(props.onMergePrev)}>
            <span className="w-4 text-center text-muted">↑</span>
            <span className="flex-1">
              Merge with “{props.prev}”
              <span className="block text-xs font-normal text-muted">one part: “{props.prev}” with the lines of both</span>
            </span>
          </button>
        )}
        {props.next && (
          <button className={item} onClick={act(props.onMergeNext)}>
            <span className="w-4 text-center text-muted">↓</span>
            <span className="flex-1">
              Merge with “{props.next}”
              <span className="block text-xs font-normal text-muted">one part: “{props.name}” with the lines of both</span>
            </span>
          </button>
        )}
        {props.onExtend && (
          <div className="rounded-2xl bg-panel-2/70 px-4 py-3">
            <p className="text-[15px] font-semibold">Make it longer</p>
            <p className="mb-2 text-xs text-muted">Its last bars of the beat come again, the rest of the song moves later — new empty lines to write.</p>
            <div className="flex gap-2">
              {[2, 4, 8].map((n) => (
                <button key={n} className="flex-1 rounded-full bg-panel py-2 text-sm font-semibold text-accent ring-1 ring-line" onClick={act(() => props.onExtend!(n))}>
                  +{n} bars
                </button>
              ))}
            </div>
          </div>
        )}
        <p className="px-1 text-xs text-muted">To split a part: open a line → “New part here”. Undo brings a merge or a longer part back.</p>
        <button className="w-full rounded-2xl py-3 text-sm font-semibold text-muted" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
