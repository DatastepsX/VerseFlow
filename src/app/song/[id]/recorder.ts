"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { positionIn, type Timeline } from "@/lib/audio/timeline";
import type { PlayLayer, StudioEngine } from "@/lib/studio/engine";
import { lastTake, type RemoteCmd, type RemoteState, type RemoteTake } from "@/lib/studio/remote";
import { takeWindow } from "@/lib/studio/timing";
import { encodeWav, peaksOf } from "@/lib/studio/wav";
import type { ProjectSettings, ProjectTree, Take } from "@/lib/types";
import { buildChain } from "@/lib/fx/chain";
import { detectKey } from "@/lib/fx/key";
import { layerPreset, presetById, type FxPreset } from "@/lib/fx/presets";
import { retune, type MusicKey } from "@/lib/fx/tune";

/**
 * Recording vocals per part (Lead, Double, Ad-libs…), on this device or on
 * the Mac with the phone as its remote. Both give the Record screen the same
 * `Recorder`: on this device it drives the audio engine; as a remote it sends
 * commands to the Mac and shows the Mac's state.
 */

export const DEFAULT_LANES = ["Lead", "Double", "Ad-libs"];
export const lanesOf = (tree: ProjectTree) => (tree.project.settings?.lanes?.length ? tree.project.settings.lanes : DEFAULT_LANES);

export type RecStatus = "idle" | "playing" | "countin" | "recording" | "saving" | "calibrating";
export type RecTake = RemoteTake & { peaks: number[] };

export interface Recorder {
  remote: boolean;
  /** the device that records answers (always, on this device) */
  connected: boolean;
  /** the microphone is on */
  armed: boolean;
  beatReady: boolean;
  sectionId: string | null;
  select: (id: string) => void;
  lane: string;
  setLane: (lane: string) => void;
  status: RecStatus;
  statusLane: string | null;
  /** the take being recorded */
  takeNo: number | null;
  /** a take is about to start (the microphone is switched on) */
  starting: boolean;
  playingTake: string | null;
  beatsLeft: number | null;
  /** the line being sung (index in the part's lines) */
  lineIndex: number | null;
  /** the song position being heard now (on this device; the remote has none) — the lyrics follow it syllable by syllable */
  clock: (() => number) | null;
  level: number;
  lanes: string[];
  /** takes of the part, of the layers */
  takes: RecTake[];
  takeCount: (sectionId: string) => number;
  countIn: number;
  setCountIn: (bars: number) => void;
  error: string | null;
  clearError: () => void;
  /** what the phone just asked this device to do */
  note: string | null;
  /** remote: the device that records ("Mac") */
  device: string | null;
  record: (lane: string) => void;
  stop: () => void;
  /** throw the take being recorded away and start it again */
  restart: () => void;
  play: () => void;
  playTake: (id: string) => void;
  choose: (id: string) => void;
  remove: (id: string) => void;
  addLane: (name: string) => void;
  /** each layer's sound (effect preset id; none: raw) */
  sounds: Record<string, string>;
  /** the song's key for autotune: chosen or found in the beat (null: not looked for yet) */
  songKey: ProjectSettings["songKey"] | null;
  /** a layer gets this sound — heard at once on its take in this part */
  trySound: (lane: string, preset: string) => void;
  setKey: (key: NonNullable<ProjectSettings["songKey"]>) => void;
  /** a voice is being tuned (autotune / pitch) */
  tuning: boolean;
  /** turn the microphone on (on this device) */
  arm: () => void;
  /** on this device only */
  settings: LocalSettings | null;
}

export interface LocalSettings {
  inputs: { id: string; label: string }[];
  deviceId: string;
  setDeviceId: (id: string) => void;
  channel: number;
  setChannel: (c: number) => void;
  metronome: boolean;
  setMetronome: (on: boolean) => void;
  headphones: boolean;
  setHeadphones: (on: boolean) => void;
  latencyMs: number;
  calibrated: boolean;
  setLatencyMs: (ms: number | null) => void;
  calibrate: () => void;
}

/** a setting saved on this device (read after the first render: the server doesn't know it) */
export function usePref<T>(key: string, initial: T, override?: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(override ?? initial);
  useEffect(() => {
    try {
      if (override !== undefined) {
        localStorage.setItem(key, JSON.stringify(override));
        return;
      }
      const raw = localStorage.getItem(key);
      // restoring a saved preference from browser storage after hydration
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw !== null) setV(JSON.parse(raw) as T);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
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

/** a phone or a tablet (touch screen): it can be the remote for the Mac */
export function useIsPhone() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia("(pointer: coarse)");
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia("(pointer: coarse)").matches,
    () => false,
  );
}

const small = (peaks: number[] | null) => {
  const p = peaks ?? [];
  const step = Math.max(1, Math.floor(p.length / 40));
  return p.filter((_, i) => i % step === 0).slice(0, 40).map((x) => Math.round(x * 100) / 100);
};

/** how much later the speakers / headphones play what the engine schedules */
const outDelay = (e: StudioEngine) => (e.ctx as AudioContext & { outputLatency?: number }).outputLatency || e.ctx.baseLatency || 0;

/** the song position being heard on this device */
const clockOf = (engine: RefObject<StudioEngine | null>) => () => {
  const e = engine.current;
  return e ? e.position() - outDelay(e) : 0;
};

const deviceName = () => {
  const ua = navigator.userAgent;
  return /iPhone|Android/.test(ua) ? "phone" : /iPad/.test(ua) ? "iPad" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "PC" : "computer";
};

type Status =
  | { kind: "idle" }
  | { kind: "playing"; take: string | null }
  | { kind: "countin"; lane: string }
  | { kind: "recording"; lane: string; take: number }
  | { kind: "saving"; lane: string }
  | { kind: "calibrating" };

/** recording on this device; `host`: the phone can drive it (a computer) */
export function useLocalRecorder(o: {
  tree: ProjectTree;
  setTree: (t: ProjectTree) => void;
  engine: RefObject<StudioEngine | null>;
  beat: RefObject<AudioBuffer | null>;
  beatReady: boolean;
  bar: number;
  beatLength: number;
  rangeOf: (sectionId: string) => { start: number; end: number } | null;
  timeline: Timeline;
  section: [string | null, (id: string) => void];
  host: boolean;
}): Recorder {
  const { tree, setTree, engine, beat, bar } = o;
  const pid = tree.project.id;
  const lanes = lanesOf(tree);
  const [sectionId, setSectionId] = o.section;
  const range = sectionId ? o.rangeOf(sectionId) : null;
  const [lane, setLaneState] = useState(lanes[0]);
  const curLane = lanes.includes(lane) ? lane : lanes[0];

  // settings on this device (the studio's: a calibrated Mac keeps its latency)
  const [deviceId, setDeviceId] = usePref("vf.studio.device", "");
  const [channel, setChannel] = usePref("vf.studio.channel", 0);
  const [countIn, setCountIn] = usePref("vf.studio.countin", 1);
  const [metronome, setMetronome] = usePref("vf.studio.metronome", true);
  const [latencyMs, setLatencyMs] = usePref<number | null>("vf.studio.latency", null);
  const [headphones, setHeadphones] = usePref("vf.studio.headphones", true);
  const [reported, setReported] = useState(0);
  const latency = (latencyMs ?? reported * 1000) / 1000;

  const buffers = useRef(new Map<string, AudioBuffer>());
  const [armed, setArmed] = useState(false);
  const [inputs, setInputs] = useState<{ id: string; label: string }[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [lineIndex, setLineIndex] = useState<number | null>(null);
  const [beatsLeft, setBeatsLeft] = useState<number | null>(null);
  /** the microphone is being switched on for the first take */
  const [starting, setStarting] = useState(false);
  const stopAt = useRef<number | null>(null);
  const recLane = useRef<string | null>(null);
  const busy = status.kind !== "idle";

  // takes recorded elsewhere (the Mac, another session): fresh on opening
  useEffect(() => {
    fetch(`/api/projects/${pid}`)
      .then((r) => r.json())
      .then((t: ProjectTree) => t?.project && setTree(t), () => {});
  }, [pid, setTree]);
  // leaving: playback stops, the microphone goes off
  useEffect(
    () => () => {
      const e = engine.current;
      e?.stop();
      e?.disarm();
    },
    [engine],
  );

  const api = async (path: string, body?: unknown, method = "POST") => {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as ProjectTree & { error?: string };
    if (!res.ok) throw new Error(data.error ?? "Something went wrong");
    if (data.project && data.sections) setTree(data);
    return { res, data };
  };
  const failed = (err: unknown) => setError(err instanceof Error ? err.message : "Something went wrong");

  const sectionTakes = tree.takes.filter((t) => t.section_id === sectionId && lanes.includes(t.lane));
  const takesOf = (l: string) => sectionTakes.filter((t) => t.lane === l);

  /** decoded audio of takes (downloaded once) */
  const loadTakes = async (takes: Take[]) => {
    const e = engine.current;
    const missing = takes.filter((t) => !buffers.current.has(t.id));
    if (!e || !missing.length) return;
    const { data } = await api(`/api/projects/${pid}/takes?ids=${missing.map((t) => t.id).join(",")}`, undefined, "GET");
    const urls = (data as unknown as { urls: Record<string, string> }).urls ?? {};
    await Promise.all(
      missing.map(async (t) => {
        if (urls[t.id]) buffers.current.set(t.id, await e.decode(await fetch(urls[t.id]).then((r) => r.arrayBuffer())));
      }),
    );
  };
  // ---- each layer's sound: an effect chain, after autotune / pitch where the preset has it ----
  const sounds = tree.project.settings?.fx ?? {};
  const bpm = tree.audio?.bpm ?? 60 / o.beatLength;
  const tunedBufs = useRef(new Map<string, AudioBuffer>());
  const [tuning, setTuning] = useState(false);
  /** the song's key for autotune: chosen, or found in the beat the first time (and kept) */
  const foundKey = useRef<MusicKey | null | undefined>(undefined);
  const songKey = async (): Promise<MusicKey | null> => {
    const k = tree.project.settings?.songKey;
    if (k === "chromatic") return null;
    if (k) return k;
    if (foundKey.current !== undefined) return foundKey.current;
    const b = beat.current;
    if (!b) return null;
    const mono = new Float32Array(b.length);
    for (let c = 0; c < b.numberOfChannels; c++) b.getChannelData(c).forEach((v, i) => (mono[i] += v / b.numberOfChannels));
    const found = detectKey(mono, b.sampleRate);
    foundKey.current = found;
    void api(`/api/projects/${pid}`, { action: "setSound", key: found ?? "chromatic" }).catch(() => {});
    return found;
  };
  /** the take as the preset sings it: tuned / shifted once, then kept */
  const voiced = async (t: Take, p: FxPreset) => {
    const raw = buffers.current.get(t.id);
    const e = engine.current;
    if (!raw || !e || (!p.tune && !p.shift)) return raw;
    const key = p.tune ? await songKey() : null;
    const id = `${t.id}|${p.id}|${key ? `${key.root}${key.minor ? "m" : ""}` : "-"}`;
    const hit = tunedBufs.current.get(id);
    if (hit) return hit;
    setTuning(true);
    // let "Tuning…" show before the work
    await new Promise((r) => setTimeout(r, 30));
    try {
      const y = retune(raw.getChannelData(0), raw.sampleRate, { key, tune: !!p.tune, speed: p.tune?.speed, shift: p.shift });
      const buf = e.ctx.createBuffer(1, y.length, raw.sampleRate);
      buf.copyToChannel(y as Float32Array<ArrayBuffer>, 0);
      tunedBufs.current.set(id, buf);
      return buf;
    } finally {
      setTuning(false);
    }
  };
  /**
   * The takes used in the song that sound in the window (other layers than the one recorded), each with
   * its layer's sound — `trying`: a sound being tried on a layer before the song knows it
   */
  const layersFor = async (from: number, to: number, skipLane?: string, only?: Take, trying?: { lane: string; preset: string }) => {
    const takes = only
      ? [only, ...tree.takes.filter((t) => t.chosen && lanes.includes(t.lane) && t.lane !== only.lane && t.start_at < to && t.start_at + t.duration > from)]
      : tree.takes.filter((t) => t.chosen && lanes.includes(t.lane) && t.lane !== skipLane && t.start_at < to && t.start_at + t.duration > from);
    await loadTakes(takes);
    const out: PlayLayer[] = [];
    for (const t of takes) {
      const p = trying?.lane === t.lane ? presetById(trying.preset) : layerPreset(sounds, t.lane);
      const buffer = await voiced(t, p);
      if (buffer) out.push({ buffer, at: t.start_at, fx: p.id === "raw" ? undefined : (ctx) => buildChain(ctx, p, bpm) });
    }
    return out;
  };

  const arm = async () => {
    const e = engine.current;
    if (!e) return false;
    setError(null);
    try {
      await e.arm(deviceId || undefined, { voiceProcessing: !headphones });
      setArmed(true);
      setReported(e.reportedLatency);
      setInputs(await e.inputs());
      return true;
    } catch (err) {
      setError(err instanceof Error ? `Microphone: ${err.message}` : "The microphone is not available.");
      return false;
    }
  };
  // another microphone, or headphones on / off: the microphone is set up again
  const armedWith = useRef("");
  useEffect(() => {
    const key = `${deviceId}|${headphones}`;
    if (armed && !busy && armedWith.current && armedWith.current !== key) void arm();
    if (armed) armedWith.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, headphones, armed]);

  const clicksFor = (from: number, to: number) => {
    if (!metronome) return [];
    const perBar = Math.max(1, Math.round(bar / o.beatLength));
    const out: { at: number; accent: boolean }[] = [];
    for (let k = 0; from + k * o.beatLength < to - 0.01; k++) out.push({ at: from + k * o.beatLength, accent: k % perBar === 0 });
    return out;
  };

  /** again: right after a take was thrown away (this render still sees it recording) */
  const record = async (l: string, again = false) => {
    const e = engine.current;
    if (!e || !beat.current || !range || !sectionId || (busy && !again) || starting) return;
    setStarting(true);
    try {
      if (!e.armed && !(await arm())) return;
      await start(e, l);
    } finally {
      setStarting(false);
    }
  };
  const start = async (e: StudioEngine, l: string) => {
    if (!range) return;
    setError(null);
    await e.ctx.resume();
    const w = takeWindow(range, bar, countIn);
    const layers = await layersFor(w.from, w.to, l);
    e.play(Math.max(0, w.from), { beat: beat.current, layers, clicks: clicksFor(w.from, range.start) });
    e.startRecording();
    recLane.current = l;
    stopAt.current = w.to;
    setLaneState(l);
    setStatus(countIn > 0 && range.start > 0.05 ? { kind: "countin", lane: l } : { kind: "recording", lane: l, take: takesOf(l).length + 1 });
  };

  /** stops; a take being recorded is saved (or thrown away) */
  const stop = async (opts: { discard?: boolean } = {}) => {
    const e = engine.current;
    if (!e) return;
    stopAt.current = null;
    setLineIndex(null);
    setBeatsLeft(null);
    const l = recLane.current;
    recLane.current = null;
    // a stop during the count-in: nothing to keep
    if (l && (opts.discard || status.kind === "countin")) {
      await e.stopRecording(latency, channel, 0);
      setStatus({ kind: "idle" });
      return;
    }
    if (!l || !range || !sectionId) {
      e.stop();
      setStatus({ kind: "idle" });
      return;
    }
    setStatus({ kind: "saving", lane: l });
    try {
      const w = takeWindow(range, bar, countIn);
      const rec = await e.stopRecording(latency, channel, w.from);
      if (!rec || rec.samples.length < rec.sampleRate * 0.3) throw new Error("Nothing was recorded.");
      const wav = encodeWav([rec.samples], rec.sampleRate, 24);
      const { data: up } = await api(`/api/projects/${pid}/takes`, { action: "uploadUrl" });
      const { path, signedUrl } = up as unknown as { path: string; signedUrl: string };
      const fd = new FormData();
      fd.append("cacheControl", "3600");
      fd.append("", new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }), "take.wav");
      const put = await fetch(signedUrl, { method: "PUT", body: fd, headers: { "x-upsert": "false" } });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      const { res } = await api(`/api/projects/${pid}/takes`, {
        action: "save",
        path,
        section_id: sectionId,
        lane: l,
        start_at: Math.round(rec.startAt * 100000) / 100000,
        duration: rec.samples.length / rec.sampleRate,
        sample_rate: rec.sampleRate,
        peaks: peaksOf(rec.samples, 160),
      });
      // kept for playing it back at once
      const id = res.headers.get("x-take-id");
      if (id) {
        const buf = e.ctx.createBuffer(1, rec.samples.length, rec.sampleRate);
        buf.copyToChannel(rec.samples as Float32Array<ArrayBuffer>, 0);
        buffers.current.set(id, buf);
      }
    } catch (err) {
      failed(err);
    }
    setStatus({ kind: "idle" });
  };

  const restart = async () => {
    const l = recLane.current;
    if (!l) return;
    await stop({ discard: true });
    await record(l, true);
  };

  const play = async (take?: Take, trying?: { lane: string; preset: string }) => {
    const e = engine.current;
    // playing already: starts again (another take)
    if (!e || !beat.current || !range || (busy && status.kind !== "playing")) return;
    await e.ctx.resume();
    const w = takeWindow(range, bar, Math.max(1, countIn));
    try {
      const layers = await layersFor(w.from, w.to, undefined, take, trying);
      e.play(Math.max(0, w.from), { beat: beat.current, layers });
      stopAt.current = w.to;
      setStatus({ kind: "playing", take: take?.id ?? null });
    } catch (err) {
      failed(err);
    }
  };

  const calibrate = async () => {
    const e = engine.current;
    if (!e || busy) return;
    if (!e.armed && !(await arm())) return;
    setStatus({ kind: "calibrating" });
    try {
      const l = await e.calibrate(channel);
      if (l === null) setError("The clicks weren't heard — hold the headphones to the microphone (or turn the volume up) and try again.");
      else setLatencyMs(Math.round(l * 1000 * 10) / 10);
    } finally {
      setStatus({ kind: "idle" });
    }
  };

  // the clock: lyrics follow, count-in, auto-stop, input level. A timer, not animation frames: it keeps
  // running while the window is in the background (the phone drives the Mac)
  const tickRef = useRef<() => void>(() => {});
  useEffect(() => {
    const id = setInterval(() => tickRef.current(), 50);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    tickRef.current = () => {
      const e = engine.current;
      if (!e) return;
      if (status.kind === "playing" || status.kind === "countin" || status.kind === "recording") {
        const p = e.position();
        // the lyrics follow what is heard (the output's delay taken off)
        const pos = positionIn(o.timeline, p - outDelay(e));
        setLineIndex(pos && pos.sectionId === sectionId ? pos.lineIndex : null);
        if (status.kind === "countin" && range) {
          const left = Math.ceil((range.start - p) / o.beatLength - 0.05);
          setBeatsLeft(left > 0 ? left : null);
          if (p >= range.start - 0.02) setStatus({ kind: "recording", lane: status.lane, take: takesOf(status.lane).length + 1 });
        }
        if (stopAt.current !== null && p >= stopAt.current) {
          stopAt.current = null;
          void stop();
        }
      }
      if (e.armed) setLevel(Math.round(e.level() * 50) / 50);
    };
  });

  // one function for the page's life: the lyrics' animation keeps running with it
  const [clock] = useState(() => clockOf(engine));
  const choose = (id: string) => void api(`/api/takes/${id}`, undefined, "PATCH").catch(failed);
  const remove = (id: string) => void api(`/api/takes/${id}`, undefined, "DELETE").catch(failed);
  /** a layer's sound: saved for the song, and heard at once on the layer's take in this part */
  const trySound = (lane: string, preset: string) => {
    if (busy && status.kind !== "playing") return;
    void api(`/api/projects/${pid}`, { action: "setSound", lane, preset }).catch(failed);
    const take = sectionTakes.find((t) => t.lane === lane && t.chosen) ?? sectionTakes.filter((t) => t.lane === lane).pop();
    if (take) void play(take, { lane, preset });
  };
  const setKey = (key: NonNullable<ProjectSettings["songKey"]>) => void api(`/api/projects/${pid}`, { action: "setSound", key }).catch(failed);
  const addLane = (name: string) => {
    const n = name.trim().slice(0, 30);
    if (!n || lanes.includes(n)) return;
    setLaneState(n);
    void api(`/api/projects/${pid}`, { action: "setLanes", lanes: [...lanes, n] }).catch(failed);
  };
  const select = (id: string) => {
    if (busy) return;
    setSectionId(id);
  };

  // ---- the phone as remote: run its commands, publish this device's state ----
  const [note, setNote] = useState<string | null>(null);
  const run = useRef<(c: RemoteCmd) => Promise<void>>(async () => {});
  useEffect(() => {
    run.current = async (c: RemoteCmd) => {
      const label: Partial<Record<RemoteCmd["t"], string>> = { select: "Part", record: "Record", retake: "Again", stop: "Stop", play: "Play", playTake: "Play take", choose: "Use take", delete: "Delete take", addLane: "New layer", countIn: "Count-in", sound: "Sound", key: "Key" };
      setNote(`Phone: ${label[c.t] ?? c.t}`);
      setTimeout(() => setNote(null), 2500);
      switch (c.t) {
        case "select":
          if (tree.sections.some((s) => s.id === c.sectionId)) select(c.sectionId);
          break;
        case "record":
          await record(c.lane);
          break;
        case "retake":
          if (recLane.current) await restart();
          else await record(c.lane);
          break;
        case "discardLast": {
          const last = busy ? null : lastTake(sectionTakes, c.lane);
          if (last) remove(last.id);
          break;
        }
        case "choose":
          choose(c.takeId);
          break;
        case "delete":
          if (!busy) remove(c.takeId);
          break;
        case "play":
          await play();
          break;
        case "playTake": {
          const t = tree.takes.find((x) => x.id === c.takeId);
          if (t) await play(t);
          break;
        }
        case "stop":
          if (busy) await stop();
          break;
        case "addLane":
          addLane(c.name);
          break;
        case "sound":
          trySound(c.lane, c.preset);
          break;
        case "key":
          setKey(c.key);
          break;
        case "countIn":
          setCountIn(Math.max(0, Math.min(2, Math.round(c.bars))));
          break;
      }
    };
  });
  useEffect(() => {
    if (!o.host) return;
    let alive = true;
    let after = -1;
    (async () => {
      while (alive) {
        try {
          const r = (await fetch(`/api/projects/${pid}/remote?cmds&after=${after}`).then((x) => x.json())) as { last?: number; cmds?: { id: number; cmd: RemoteCmd }[] };
          if (typeof r.last === "number") after = r.last;
          for (const c of r.cmds ?? []) if (alive) await run.current(c.cmd);
        } catch {
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [pid, o.host]);

  const recording = status.kind === "recording" ? status : null;
  const state: RemoteState = {
    armed,
    beatReady: o.beatReady,
    sectionId,
    status: status.kind,
    statusLane: "lane" in status ? status.lane : null,
    statusLabel: recording ? `take ${recording.take}` : "",
    lineIndex,
    sections: tree.sections.map((s) => ({ id: s.id, name: s.name, takes: tree.takes.filter((t) => t.section_id === s.id && lanes.includes(t.lane)).length })),
    lanes,
    takes: sectionTakes.map((t) => ({ id: t.id, lane: t.lane, take_no: t.take_no, chosen: t.chosen, duration: t.duration, peaks: small(t.peaks) })),
    countIn,
    error,
    playingTake: status.kind === "playing" ? status.take : null,
    beatsLeft,
    sounds,
    songKey: tree.project.settings?.songKey ?? null,
    tuning,
  };
  const stateJson = JSON.stringify(state);
  const lastSent = useRef("");
  const hostId = useRef("");
  useEffect(() => {
    if (!o.host) return;
    if (!hostId.current) hostId.current = Math.random().toString(36).slice(2);
    // changes go out at once; the same state again every 3 s, so the phone knows this device is there
    const send = () => {
      lastSent.current = stateJson;
      const body = `{"state":${JSON.stringify({ ...(JSON.parse(stateJson) as RemoteState), host: hostId.current, device: deviceName() })}}`;
      void fetch(`/api/projects/${pid}/remote`, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => {});
    };
    if (stateJson !== lastSent.current) send();
    const id = setInterval(send, 3000);
    return () => clearInterval(id);
  }, [stateJson, pid, o.host]);

  return {
    remote: false,
    connected: true,
    armed,
    beatReady: o.beatReady,
    sectionId,
    select,
    lane: curLane,
    setLane: (l) => !busy && setLaneState(l),
    status: status.kind,
    statusLane: "lane" in status ? status.lane : null,
    takeNo: recording ? recording.take : null,
    starting,
    playingTake: status.kind === "playing" ? status.take : null,
    beatsLeft,
    lineIndex,
    clock: status.kind === "playing" || status.kind === "recording" || status.kind === "countin" ? clock : null,
    level,
    lanes,
    takes: sectionTakes.map((t) => ({ ...t, peaks: t.peaks ?? [] })),
    takeCount: (id) => tree.takes.filter((t) => t.section_id === id && lanes.includes(t.lane)).length,
    countIn,
    setCountIn,
    error,
    clearError: () => setError(null),
    note,
    device: null,
    record: (l) => void record(l),
    stop: () => void stop(),
    restart: () => void restart(),
    play: () => void play(),
    playTake: (id) => {
      const t = tree.takes.find((x) => x.id === id);
      if (t) void play(t);
    },
    choose,
    remove,
    addLane,
    sounds,
    songKey: tree.project.settings?.songKey ?? null,
    trySound,
    setKey,
    tuning,
    arm: () => void arm(),
    settings: {
      inputs,
      deviceId,
      setDeviceId,
      channel,
      setChannel,
      metronome,
      setMetronome,
      headphones,
      setHeadphones,
      latencyMs: Math.round(latency * 1000 * 10) / 10,
      calibrated: latencyMs !== null,
      setLatencyMs,
      calibrate: () => void calibrate(),
    },
  };
}

/** this phone as the remote for the Mac: the Mac records, the phone shows its state and sends commands */
export function useRemoteRecorder(o: { tree: ProjectTree; section: [string | null, (id: string) => void] }): Recorder {
  const pid = o.tree.project.id;
  const [mine, setMine] = o.section;
  const [state, setState] = useState<RemoteState | null>(null);
  const [age, setAge] = useState<number | null>(null);
  const [want, setWant] = useState<string | null>(null);
  const [lane, setLane] = useState(lanesOf(o.tree)[0]);

  useEffect(() => {
    let alive = true;
    let after = 0;
    (async () => {
      while (alive) {
        try {
          const r = (await fetch(`/api/projects/${pid}/remote?state&after=${after}`).then((x) => x.json())) as { state: RemoteState | null; at: number; age: number | null };
          if (!alive) break;
          if (r.state && r.at > after) {
            after = r.at;
            const s = r.state;
            setState(s);
            setWant((w) => (w && w === s.sectionId ? null : w));
          }
          setAge(r.age);
        } catch {
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
    })();
    // between answers the last sign of life gets older (the Mac sends it every 3 s)
    const tick = setInterval(() => setAge((a) => (a === null ? a : a + 1000)), 1000);
    return () => {
      alive = false;
      clearInterval(tick);
    };
  }, [pid]);

  const send = (cmd: RemoteCmd) =>
    void fetch(`/api/projects/${pid}/remote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd }) }).catch(() => {});

  const connected = !!state && age !== null && age < 9000;
  const sectionId = connected ? (want ?? state.sectionId ?? mine) : mine;
  const lanes = connected && state.lanes?.length ? state.lanes : lanesOf(o.tree);
  const status = (connected ? state.status : "idle") as RecStatus;
  const here = connected && state.sectionId === sectionId;
  return {
    remote: true,
    connected,
    armed: connected && state.armed,
    beatReady: connected && state.beatReady,
    sectionId,
    select: (id) => {
      setMine(id);
      if (!connected) return;
      setWant(id);
      setTimeout(() => setWant((w) => (w === id ? null : w)), 4000);
      send({ t: "select", sectionId: id });
    },
    lane: lanes.includes(lane) ? lane : lanes[0],
    setLane,
    status,
    statusLane: connected ? state.statusLane : null,
    takeNo: connected && state.status === "recording" ? Number(state.statusLabel.replace(/\D/g, "")) || null : null,
    starting: false,
    playingTake: connected ? (state.playingTake ?? null) : null,
    beatsLeft: connected ? (state.beatsLeft ?? null) : null,
    lineIndex: here ? state.lineIndex : null,
    clock: null,
    level: 0,
    lanes,
    takes: here ? state.takes.map((t) => ({ ...t, peaks: t.peaks ?? [] })) : [],
    takeCount: (id) => (connected ? (state.sections.find((s) => s.id === id)?.takes ?? 0) : 0),
    countIn: connected ? state.countIn : 1,
    setCountIn: (bars) => send({ t: "countIn", bars }),
    error: connected ? state.error : null,
    clearError: () => {},
    note: null,
    device: connected ? (state.device ?? "Mac") : null,
    record: (l) => {
      setLane(l);
      send({ t: "record", lane: l });
    },
    stop: () => send({ t: "stop" }),
    restart: () => send({ t: "retake", lane: state?.statusLane ?? lane }),
    play: () => send({ t: "play" }),
    playTake: (takeId) => send({ t: "playTake", takeId }),
    choose: (takeId) => send({ t: "choose", takeId }),
    remove: (takeId) => send({ t: "delete", takeId }),
    addLane: (name) => {
      setLane(name.trim());
      send({ t: "addLane", name });
    },
    sounds: connected ? (state.sounds ?? {}) : (o.tree.project.settings?.fx ?? {}),
    songKey: connected ? (state.songKey ?? null) : (o.tree.project.settings?.songKey ?? null),
    trySound: (lane, preset) => send({ t: "sound", lane, preset }),
    setKey: (key) => send({ t: "key", key }),
    tuning: connected && !!state.tuning,
    arm: () => {},
    settings: null,
  };
}
