"use client";

import { deviceKind } from "@/lib/client/profile";
import { usePref } from "@/lib/client/usePref";
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { positionIn, type Timeline } from "@/lib/audio/timeline";
import type { PlayLayer, StudioEngine } from "@/lib/studio/engine";
import { lastTake, type RemoteCmd, type RemoteState, type RemoteTake } from "@/lib/studio/remote";
import { leadOf, syncTakes } from "@/lib/studio/sync";
import { takeWindow } from "@/lib/studio/timing";
import { encodeWav, peaksOf } from "@/lib/studio/wav";
import type { ProjectSettings, ProjectTree, Take } from "@/lib/types";
import { buildChain } from "@/lib/fx/chain";
import { channelOf, clipOf, laneBus } from "@/lib/studio/mix";
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
  /** the meter: the loudest of the last moment, and a clip just now (this device) */
  meter: { hold: number; clip: boolean };
  lanes: string[];
  /** takes of the part, of the layers */
  takes: RecTake[];
  takeCount: (sectionId: string) => number;
  countIn: number;
  setCountIn: (bars: number) => void;
  /** the metronome during the take (on or off at any time, even while recording) */
  clicks: boolean;
  setClicks: (on: boolean) => void;
  error: string | null;
  clearError: () => void;
  /** what the phone just asked this device to do */
  note: string | null;
  /** remote: the device that records ("Mac") */
  device: string | null;
  /** the microphone recording (its name), once on */
  mic: string | null;
  record: (lane: string) => void;
  stop: () => void;
  /** throw the take being recorded away and start it again */
  restart: () => void;
  play: () => void;
  playTake: (id: string) => void;
  /** hear a take on its own stretch of the beat: the whole recording (clip null) or a cut not saved yet */
  previewTake: (id: string, clip: { from: number; to: number | null } | null, gain?: number) => void;
  /** a take's volume, heard at once (on the device that plays) */
  takeGain: (id: string, gain: number) => void;
  choose: (id: string) => void;
  remove: (id: string) => void;
  /** a take earlier (−) / later (+) on the beat, in seconds; on this device later takes follow (the delay setting) */
  shift: (id: string, by: number) => void;
  addLane: (name: string) => void;
  /** each layer's sound (effect preset id; none: raw) */
  sounds: Record<string, string>;
  /** the song's key for autotune: chosen or found in the beat (null: not looked for yet) */
  songKey: ProjectSettings["songKey"] | null;
  /** a layer gets this sound — heard at once on its take in this part (`part`: in this part only) */
  trySound: (lane: string, preset: string, part?: boolean) => void;
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
  /** a double / ad-lib take follows the part's Lead by itself once saved (a synced copy; the take stays) */
  followLead: boolean;
  setFollowLead: (on: boolean) => void;
  headphones: boolean;
  setHeadphones: (on: boolean) => void;
  latencyMs: number;
  calibrated: boolean;
  setLatencyMs: (ms: number | null) => void;
  /** "clicks": hold the headphones to the mic; "claps": clap along (with or without headphones) */
  calibrate: (how?: "clicks" | "claps") => void;
  /** the delay set for the other setting (with / without headphones), null: estimated */
  otherLatencyMs: number | null;
  /** the microphone's gain in dB (kept for each microphone on this device) */
  gainDb: number;
  setGainDb: (db: number) => void;
  /** hear yourself in the headphones */
  monitor: boolean;
  /** how late you hear yourself (ms), as the device reports it; null: not known */
  monitorDelayMs: number | null;
  setMonitor: (on: boolean) => void;
  /** sing for a few seconds: the gain (and the input the microphone is on) set by itself */
  autoLevel: () => void;
  /** seconds left while it listens; null: not listening */
  leveling: number | null;
  /** what the last auto level found */
  levelNote: string | null;
}

export const GAIN_MIN = -12;
export const GAIN_MAX = 36;

export { usePref };

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
  const [clicks, setClicksPref] = usePref("vf.studio.clicks", false);
  // the engine follows the setting at once — even in the middle of a take
  useEffect(() => {
    engine.current?.setTakeClicks(clicks);
  }, [clicks, engine]);
  const setClicks = (on: boolean) => {
    setClicksPref(on);
    engine.current?.setTakeClicks(on);
  };
  const [metronome, setMetronome] = usePref("vf.studio.metronome", true);
  const [followLead, setFollowLead] = usePref("vf.studio.followLead", true);
  const [headphones, setHeadphones] = usePref("vf.studio.headphones", true);
  // the microphone's gain: each microphone of this device its own (a USB microphone often comes in quiet)
  const [gains, setGains] = usePref<Record<string, number>>("vf.studio.ingains", {});
  const [monitor, setMonitor] = usePref("vf.studio.monitor", false);
  // the delay differs with echo cancellation (no headphones): one setting each
  // kept with your profile, one per kind of device (iPhone, Mac…): each has its own delay
  const kind = deviceKind();
  const [latencyRaw, setLatencyRaw] = usePref<number | null>(`vf.studio.latency.${kind}`, null);
  const [latencyVp, setLatencyVp] = usePref<number | null>(`vf.studio.latency.vp.${kind}`, null);
  const latencyMs = headphones ? latencyRaw : latencyVp;
  const setLatencyMs = headphones ? setLatencyRaw : setLatencyVp;
  const [reported, setReported] = useState(0);
  const latency = (latencyMs ?? reported * 1000) / 1000;

  const buffers = useRef(new Map<string, AudioBuffer>());
  const [armed, setArmed] = useState(false);
  const [mic, setMic] = useState<string | null>(null);
  const gainDb = gains[mic ?? ""] ?? 0;
  const setGainDb = (db: number) => setGains({ ...gains, [mic ?? ""]: Math.round(Math.max(GAIN_MIN, Math.min(GAIN_MAX, db)) * 2) / 2 });
  useEffect(() => {
    engine.current?.setInputGain(10 ** (gainDb / 20));
  }, [engine, gainDb, armed]);
  // hearing yourself: in headphones only (from a speaker it would feed back)
  const [monitorDelayMs, setMonitorDelayMs] = useState<number | null>(null);
  useEffect(() => {
    const e = engine.current;
    e?.setMonitor(monitor && headphones && armed);
    // the device's delay, once the microphone and the sound run (it settles a moment after)
    if (!e || !armed) return;
    const read = () => setMonitorDelayMs(e.monitorDelay().total > 0 ? Math.round(e.monitorDelay().total * 1000) : null);
    read();
    const id = setTimeout(read, 1500);
    return () => clearTimeout(id);
  }, [engine, monitor, headphones, armed]);
  const [leveling, setLeveling] = useState<number | null>(null);
  const [levelNote, setLevelNote] = useState<string | null>(null);
  const [inputs, setInputs] = useState<{ id: string; label: string }[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [meter, setMeter] = useState({ hold: 0, clip: false });
  const holdRef = useRef({ v: 0, at: 0 });
  const clipAt = useRef(-1e9);
  const [lineIndex, setLineIndex] = useState<number | null>(null);
  /** a short message (the phone's commands, a double synced…) */
  const [note, setNote] = useState<string | null>(null);
  const [beatsLeft, setBeatsLeft] = useState<number | null>(null);
  /** the microphone is being switched on for the first take */
  const [starting, setStarting] = useState(false);
  const stopAt = useRef<number | null>(null);
  /** the loudest the level meter showed during the take */
  const maxLevel = useRef(0);
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
    // a layer off in the mix plays on its silent channel (turned on: heard at once)
    const takes = only
      ? [only, ...tree.takes.filter((t) => t.chosen && lanes.includes(t.lane) && t.lane !== only.lane && t.start_at < to && t.start_at + t.duration > from)]
      : tree.takes.filter((t) => t.chosen && lanes.includes(t.lane) && t.lane !== skipLane && t.start_at < to && t.start_at + t.duration > from);
    const off = lanes.filter((l) => channelOf(tree.project.settings, laneBus(l)).mute);
    await loadTakes(takes);
    const out: PlayLayer[] = [];
    for (const t of takes) {
      const p = trying?.lane === t.lane && t.section_id === sectionId ? presetById(trying.preset) : layerPreset(sounds, t.lane, t.section_id);
      const buffer = await voiced(t, p);
      // the take played on its own is heard even when its layer is off
      const bus = t === only && off.includes(t.lane) ? undefined : laneBus(t.lane);
      if (buffer) out.push({ buffer, at: t.start_at, gain: t.gain ?? 1, pan: t.pan ?? 0, bus, id: t.id, fx: p.id === "raw" ? undefined : (ctx) => buildChain(ctx, p, bpm), clip: clipOf(t) });
    }
    return out;
  };

  /** quiet: switched on by itself — a message showing stays */
  const arm = async (quiet = false) => {
    const e = engine.current;
    if (!e) return false;
    if (!quiet) setError(null);
    try {
      setMic(await e.arm(deviceId || undefined, { voiceProcessing: !headphones }));
      setArmed(true);
      setReported(e.reportedLatency);
      setInputs(await e.inputs());
      return true;
    } catch (err) {
      setError(err instanceof Error ? `Microphone: ${err.message}` : "The microphone is not available.");
      return false;
    }
  };
  // a computer (the studio): the microphone comes back on by itself — when the browser already allows it (it was
  // allowed before), or at the first click anywhere on the page; no "Allow microphone" each time you come back
  const autoArming = useRef(false);
  useEffect(() => {
    if (!o.host || armed) return;
    let gone = false;
    const tryArm = () => {
      if (gone || autoArming.current || engine.current?.armed) return;
      autoArming.current = true;
      void arm(true).finally(() => (autoArming.current = false));
    };
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((p) => p.state === "granted" && tryArm())
      .catch(() => {});
    window.addEventListener("pointerdown", tryArm, { capture: true, once: true });
    return () => {
      gone = true;
      window.removeEventListener("pointerdown", tryArm, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- arm reads the current settings
  }, [o.host, armed]);
  // another microphone, or headphones on / off: the microphone is set up again
  const armedWith = useRef("");
  useEffect(() => {
    const key = `${deviceId}|${headphones}`;
    if (armed && !busy && armedWith.current && armedWith.current !== key) void arm();
    if (armed) armedWith.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, headphones, armed]);

  /** the count-in's clicks (when the metronome is on for it), then the take's (heard while `clicks` is on) */
  const clicksFor = (from: number, to: number, takeTo?: number) => {
    const perBar = Math.max(1, Math.round(bar / o.beatLength));
    const out: { at: number; accent: boolean; take?: boolean }[] = [];
    const end = takeTo ?? to;
    for (let k = 0; from + k * o.beatLength < end - 0.01; k++) {
      const at = from + k * o.beatLength;
      const take = at >= to - 0.01;
      if (take || metronome) out.push({ at, accent: k % perBar === 0, ...(take ? { take: true } : {}) });
    }
    return out;
  };

  /** again: right after a take was thrown away (this render still sees it recording) */
  const record = async (l: string, again = false) => {
    const e = engine.current;
    if (!e || !beat.current || !range || !sectionId || (busy && !again) || starting) return;
    setStarting(true);
    try {
      // a microphone the browser ended or muted meanwhile: switched on again first
      if (!e.inputAlive && !(await arm())) return;
      await start(e, l);
    } finally {
      setStarting(false);
    }
  };
  const start = async (e: StudioEngine, l: string) => {
    if (!range) return;
    setError(null);
    // the sound must run (the beat to sing on, and the recorder): a browser starts it only after a click on the page
    if (!(await e.readyToRecord())) {
      setError(
        o.host
          ? `This ${deviceName()} can't play sound yet — click once anywhere on the VerseFlow page on it, then record again.`
          : "The sound can't start yet — tap the page once, then record again.",
      );
      return;
    }
    maxLevel.current = 0;
    const w = takeWindow(range, bar, countIn);
    const layers = await layersFor(w.from, w.to, l);
    e.setTakeClicks(clicks);
    e.play(Math.max(0, w.from), { beat: beat.current, layers, clicks: clicksFor(w.from, range.start, w.to) });
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
    let peak = -1;
    try {
      const w = takeWindow(range, bar, countIn);
      const rec = await e.stopRecording(latency, channel, w.from);
      if (rec) for (const v of rec.samples) peak = Math.max(peak, Math.abs(v));
      if (!rec || rec.samples.length < rec.sampleRate * 0.3) throw new Error("Nothing was recorded.");
      // pure silence (every sample 0): the browser gave a dead microphone — not saved; the microphone goes on again
      if (rec.samples.every((v) => v === 0)) {
        e.disarm();
        setArmed(false);
        throw new Error(
          `The ${deviceName()}'s microphone sent no sound, so the take wasn't kept. It is being switched on again — record once more.${o.host ? " Keep the VerseFlow tab open (not in the background) on it." : ""}${!headphones ? " With a USB microphone, turn “I wear headphones” on: the phone's voice processing can silence it." : ""}`,
        );
      }
      const wav = encodeWav([rec.samples], rec.sampleRate, 24);
      const { data: up } = await api(`/api/projects/${pid}/takes`, { action: "uploadUrl" });
      const { path, signedUrl } = up as unknown as { path: string; signedUrl: string };
      const fd = new FormData();
      fd.append("cacheControl", "3600");
      fd.append("", new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }), "take.wav");
      const put = await fetch(signedUrl, { method: "PUT", body: fd, headers: { "x-upsert": "false" } });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      const { res, data: saved } = await api(`/api/projects/${pid}/takes`, {
        action: "save",
        path,
        section_id: sectionId,
        lane: l,
        start_at: Math.round(rec.startAt * 100000) / 100000,
        duration: rec.samples.length / rec.sampleRate,
        sample_rate: rec.sampleRate,
        peaks: peaksOf(rec.samples, 160),
      });
      // kept, but hardly a voice in it: most likely another microphone than the one sung into
      if (peak < 0.05)
        setError(`Take kept, but it is very quiet — almost nothing reached “${mic ?? "the microphone"}”. Is it the one you sing into? Choose it in Record → Settings, or check the input in your computer's sound settings.`);
      // kept for playing it back at once
      const id = res.headers.get("x-take-id");
      if (id) {
        const buf = e.ctx.createBuffer(1, rec.samples.length, rec.sampleRate);
        buf.copyToChannel(rec.samples as Float32Array<ArrayBuffer>, 0);
        buffers.current.set(id, buf);
      }
      // a double sung along with the Lead lands a little late (you follow what you hear): it follows the Lead by itself
      const fresh = saved as unknown as ProjectTree;
      const lead = leadOf(fresh, sectionId);
      const take = fresh.takes?.find((t) => t.id === id);
      if (followLead && id && take && lead && lead.id !== id && l !== "Lead" && l !== "Flow") {
        setNote(`${l}: following Lead ${lead.take_no}…`);
        void syncTakes(fresh, [{ take, mode: { to: "lead" } }], () => {})
          .then((out) => {
            setTree(out.tree);
            setNote(`${l} ${take.take_no}: ${out.done[0]?.replace(/^[^:]+:\s*/, "") ?? "in time"} — the take as sung stays (Takes)`);
            setTimeout(() => setNote(null), 5000);
          })
          .catch((err) => {
            setNote(null);
            failed(err);
          });
      }
    } catch (err) {
      failed(err);
    }
    // what this device saw (to find out why a take fails): the microphone, the sound, what was recorded
    void fetch("/api/diag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ diag: { ua: navigator.userAgent.slice(0, 160), host: o.host, headphones, channel, deviceId: deviceId ? "chosen" : "default", meterMax: Math.round(maxLevel.current * 1000) / 1000, peak: Math.round(peak * 10000) / 10000, ...e.info() } }),
    }).catch(() => {});
    setStatus({ kind: "idle" });
  };

  const restart = async () => {
    const l = recLane.current;
    if (!l) return;
    await stop({ discard: true });
    await record(l, true);
  };

  /** `clip`: the take on its own stretch, the whole recording (null) or this cut (not saved yet) */
  const play = async (take?: Take, trying?: { lane: string; preset: string }, clip?: { from: number; to: number | null } | null, gain?: number) => {
    const e = engine.current;
    // playing already: starts again (another take)
    if (!e || !beat.current || (!range && clip === undefined) || (busy && status.kind !== "playing")) return;
    await e.ctx.resume();
    const c0 = clip?.from ?? 0;
    const c1 = clip?.to ?? take?.duration ?? 0;
    const w = take && clip !== undefined ? { from: take.start_at + c0 - 0.4, to: take.start_at + c1 + 0.3 } : takeWindow(range!, bar, Math.max(1, countIn));
    try {
      const layers = (await layersFor(w.from, w.to, undefined, take, trying)).map((l) => (take && clip !== undefined && l.id === take.id ? { ...l, clip: clip ?? undefined, gain: gain ?? l.gain } : l));
      e.play(Math.max(0, w.from), { beat: beat.current, layers });
      stopAt.current = w.to;
      setStatus({ kind: "playing", take: take?.id ?? null });
    } catch (err) {
      failed(err);
    }
  };

  const calibrate = async (how: "clicks" | "claps" = "clicks") => {
    const e = engine.current;
    if (!e || busy) return;
    if (!e.armed && !(await arm())) return;
    setStatus({ kind: "calibrating" });
    try {
      if (how === "claps") {
        const r = await e.calibrateClaps(channel);
        if (r === null) setError("The claps weren't clear — clap (or say “ta”) right on each of the 8 clicks after the 4 count-in clicks, close to the microphone, and try again.");
        else setLatencyMs(Math.round(Math.max(0, r.delay) * 1000 * 10) / 10);
      } else {
        const l = await e.calibrate(channel);
        if (l === null) setError("The clicks weren't heard — hold the headphones to the microphone (or turn the volume up) and try again.");
        else setLatencyMs(Math.round(l * 1000 * 10) / 10);
      }
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
      if (e.armed) {
        const lv = e.level();
        setLevel(Math.round(lv * 1000) / 1000);
        // the meter: the loudest of the last moment stays a while; a clip lights up for 2 s
        const t = performance.now();
        const h = holdRef.current;
        if (lv >= h.v || t - h.at > 1500) holdRef.current = { v: lv, at: t };
        if (lv >= 0.99) clipAt.current = t;
        setMeter((m) => {
          const next = { hold: Math.round(holdRef.current.v * 1000) / 1000, clip: t - clipAt.current < 2000 };
          return m.hold === next.hold && m.clip === next.clip ? m : next;
        });
        if (status.kind === "recording" || status.kind === "countin") maxLevel.current = Math.max(maxLevel.current, lv);
      }
    };
  });

  /**
   * Auto level: you sing (or rap) your loudest part for 5 seconds; the gain is set so its peaks land at about
   * −6 dB — loud, with room before it clips — and the input the microphone is on is chosen.
   */
  const autoLevel = async () => {
    const e = engine.current;
    if (!e || busy || leveling !== null) return;
    if (!e.inputAlive && !(await arm())) return;
    setLevelNote(null);
    const secs = 5;
    setLeveling(secs);
    const tick = setInterval(() => setLeveling((x) => (x && x > 1 ? x - 1 : x)), 1000);
    try {
      const m = await e.measureInput(secs);
      if (!m) return setLevelNote("Nothing was heard — tap the page once, then try again.");
      const k = m.peaks.length > 1 && m.peaks[1] > 4 * m.peaks[0] ? 1 : 0;
      const peak = m.peaks[k];
      if (peak < 0.002) return setLevelNote(`Almost nothing reached “${mic ?? "the microphone"}”. Is it the one you sing into, and is it switched on?`);
      // the gain it was measured with, taken out: what the microphone gives as it comes
      const raw = peak / 10 ** (gainDb / 20);
      const db = Math.round(Math.max(GAIN_MIN, Math.min(GAIN_MAX, 20 * Math.log10(0.5 / raw))) * 2) / 2;
      setGainDb(db);
      if (m.peaks.length > 1 && k !== channel && channel >= 0 && m.peaks[channel] < m.peaks[k] / 4) setChannel(k);
      setLevelNote(
        db >= GAIN_MAX
          ? `Gain set to +${db} dB, the most there is — the microphone is very quiet: sing closer to it, or turn it up on the microphone itself.`
          : `Gain set to ${db > 0 ? "+" : ""}${db} dB: your loudest is at about −6 dB.${k !== channel && channel >= 0 ? ` The microphone is on input ${k + 1}: chosen.` : ""}`,
      );
    } finally {
      clearInterval(tick);
      setLeveling(null);
    }
  };

  // one function for the page's life: the lyrics' animation keeps running with it
  const [clock] = useState(() => clockOf(engine));
  const choose = (id: string) => void api(`/api/takes/${id}`, undefined, "PATCH").catch(failed);
  const remove = (id: string) => void api(`/api/takes/${id}`, undefined, "DELETE").catch(failed);
  const shift = (id: string, by: number) => {
    void api(`/api/takes/${id}`, { shift: by }, "PATCH").catch(failed);
    // a take that sat late was recorded with too little delay compensation: the next ones get more
    setLatencyMs(Math.max(0, Math.round((latency * 1000 - by * 1000) * 10) / 10));
  };
  /** a layer's sound: saved for the song (or for this part only), and heard at once on the layer's take in this part */
  const trySound = (lane: string, preset: string, part?: boolean) => {
    if (busy && status.kind !== "playing") return;
    void api(`/api/projects/${pid}`, { action: "setSound", lane, preset, sectionId, part: !!part }).catch(failed);
    const take = sectionTakes.find((t) => t.lane === lane && t.chosen) ?? sectionTakes.filter((t) => t.lane === lane).pop();
    // "inherit": the part goes back to the song's sound
    const heard = preset === "inherit" ? (sounds[lane] ?? "raw") : preset;
    if (take) void play(take, { lane, preset: heard });
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
  const run = useRef<(c: RemoteCmd) => Promise<void>>(async () => {});
  useEffect(() => {
    run.current = async (c: RemoteCmd) => {
      const label: Partial<Record<RemoteCmd["t"], string>> = { select: "Part", record: "Record", retake: "Again", stop: "Stop", play: "Play", playTake: "Play take", choose: "Use take", delete: "Delete take", addLane: "New layer", countIn: "Count-in", clicks: "Metronome", sound: "Sound", key: "Key" };
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
        case "shift":
          shift(c.takeId, c.by);
          break;
        case "delete":
          if (!busy) remove(c.takeId);
          break;
        case "play":
          await play();
          break;
        case "playTake": {
          const t = tree.takes.find((x) => x.id === c.takeId);
          if (t) await play(t, undefined, c.clip, c.gain);
          break;
        }
        case "stop":
          if (busy) await stop();
          break;
        case "addLane":
          addLane(c.name);
          break;
        case "sound":
          trySound(c.lane, c.preset, c.part);
          break;
        case "key":
          setKey(c.key);
          break;
        case "clicks":
          setClicks(!!c.on);
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
    clicks,
    error,
    mic,
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
    meter,
    lanes,
    takes: sectionTakes.map((t) => ({ ...t, peaks: t.peaks ?? [] })),
    takeCount: (id) => tree.takes.filter((t) => t.section_id === id && lanes.includes(t.lane)).length,
    countIn,
    setCountIn,
    clicks,
    setClicks,
    error,
    clearError: () => setError(null),
    note,
    device: null,
    mic,
    record: (l) => void record(l),
    stop: () => void stop(),
    restart: () => void restart(),
    play: () => void play(),
    playTake: (id) => {
      const t = tree.takes.find((x) => x.id === id);
      if (t) void play(t);
    },
    previewTake: (id, clip, gain) => {
      const t = tree.takes.find((x) => x.id === id);
      if (t) void play(t, undefined, clip, gain);
    },
    takeGain: (id, gain) => engine.current?.setLayerGain(id, gain),
    choose,
    remove,
    shift,
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
      followLead,
      setFollowLead,
      headphones,
      setHeadphones,
      latencyMs: Math.round(latency * 1000 * 10) / 10,
      calibrated: latencyMs !== null,
      setLatencyMs,
      calibrate: (how) => void calibrate(how),
      otherLatencyMs: headphones ? latencyVp : latencyRaw,
      gainDb,
      setGainDb,
      monitor,
      monitorDelayMs,
      setMonitor,
      autoLevel: () => void autoLevel(),
      leveling,
      levelNote,
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
    meter: { hold: 0, clip: false },
    lanes,
    takes: here ? state.takes.map((t) => ({ ...t, peaks: t.peaks ?? [] })) : [],
    takeCount: (id) => (connected ? (state.sections.find((s) => s.id === id)?.takes ?? 0) : 0),
    countIn: connected ? state.countIn : 1,
    setCountIn: (bars) => send({ t: "countIn", bars }),
    clicks: connected ? !!state.clicks : false,
    setClicks: (on) => send({ t: "clicks", on }),
    error: connected ? state.error : null,
    clearError: () => {},
    note: null,
    device: connected ? (state.device ?? "Mac") : null,
    mic: connected ? (state.mic ?? null) : null,
    record: (l) => {
      setLane(l);
      send({ t: "record", lane: l });
    },
    stop: () => send({ t: "stop" }),
    restart: () => send({ t: "retake", lane: state?.statusLane ?? lane }),
    play: () => send({ t: "play" }),
    playTake: (takeId) => send({ t: "playTake", takeId }),
    previewTake: (takeId, clip, gain) => send({ t: "playTake", takeId, clip, gain }),
    // the Mac hears it once the volume is saved (the song syncs)
    takeGain: () => {},
    choose: (takeId) => send({ t: "choose", takeId }),
    remove: (takeId) => send({ t: "delete", takeId }),
    shift: (takeId, by) => send({ t: "shift", takeId, by }),
    addLane: (name) => {
      setLane(name.trim());
      send({ t: "addLane", name });
    },
    sounds: connected ? (state.sounds ?? {}) : (o.tree.project.settings?.fx ?? {}),
    songKey: connected ? (state.songKey ?? null) : (o.tree.project.settings?.songKey ?? null),
    trySound: (lane, preset, part) => send({ t: "sound", lane, preset, part }),
    setKey: (key) => send({ t: "key", key }),
    tuning: connected && !!state.tuning,
    arm: () => {},
    settings: null,
  };
}
