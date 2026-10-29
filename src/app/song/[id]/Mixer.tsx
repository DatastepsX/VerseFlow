"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Download, Pause, Play } from "@/components/icons";
import { VolumeSlider } from "@/components/VolumeSlider";
import { fmtTime } from "@/lib/audio/song-map";
import { FX_CATEGORIES, FX_PRESETS, layerPreset } from "@/lib/fx/presets";
import { channelOf, laneBus, louderGain, panLabel, TAKE_MAX, type ChannelPatch } from "@/lib/studio/mix";
import type { ProjectTree, Take } from "@/lib/types";

/**
 * The mixer — the song's studio desk: every track in one overview along the song (the beat with its parts,
 * your flow, each recording layer with its takes), and a channel strip for each — volume, pan, mute, solo,
 * its sound. Everything is heard at once while the song plays and kept with the song. A take has its own
 * volume and pan on top (tap it in the overview).
 */

const COLORS = ["#8b5cf6", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4", "#ef4444", "#84cc16"];

export interface MixerProps {
  tree: ProjectTree;
  /** the recording layers (Lead, Double, Ad-libs…) */
  lanes: string[];
  /** where each part sits in the song */
  parts: { id: string; name: string; start: number; end: number }[];
  total: number;
  playing: boolean;
  now: number;
  onPlay: (from: number) => void;
  onStop: () => void;
  onSeek: (t: number) => void;
  setChannel: (key: string, patch: ChannelPatch) => void;
  setSound: (lane: string, preset: string) => void;
  /** your recorded flow exists */
  hasFlow: boolean;
  /** the lyrics in your voice (Hear) play along */
  voice: boolean;
  /** the song's original vocals: split from the music (null: not yet — removing them is 1 call) */
  vocals: { on: boolean; toggle: () => void } | null;
  onSeparate: () => void;
  separating: boolean;
  /** the API (returns the song) */
  call: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  /** a take's volume / pan heard at once while it plays */
  liveTake: (id: string, mix: { gain?: number; pan?: number }) => void;
  /** the stems as WAVs in a ZIP (null: the beat isn't loaded yet) */
  onExport: ((o: ExportOptions, progress: (text: string) => void) => Promise<string | void>) | null;
}

export interface ExportOptions {
  /** the stems as WAVs in a ZIP, the mix as one MP3, or both online behind a link (no account needed) */
  kind: "zip" | "mp3" | "share";
  /** a share link: how long it works */
  days: number;
  /** with the mixer's volume, pan and effects (else dry, as recorded) */
  mixed: boolean;
  /** your recorded flow as a stem too */
  flow: boolean;
  /** the whole mix as one more file */
  mixdown: boolean;
}

export function Mixer(p: MixerProps) {
  const s = p.tree.project.settings;
  const color = (lane: string) => COLORS[Math.max(0, p.lanes.indexOf(lane)) % COLORS.length];
  const [takeOf, setTakeOf] = useState<{ lane: string; sectionId: string | null } | null>(null);
  const tracks: { key: string; name: string; color: string; lane?: string }[] = [
    { key: "beat", name: "Beat", color: "#94a3b8" },
    ...(p.hasFlow ? [{ key: "flow", name: "Your flow", color: "#60a5fa" }] : []),
    ...(p.voice ? [{ key: "voice", name: "Your voice (Hear)", color: "#f472b6" }] : []),
    ...p.lanes.map((l) => ({ key: laneBus(l), name: l, color: color(l), lane: l })),
  ];
  const soloing = tracks.some((t) => channelOf(s, t.key).solo);

  return (
    <div className="space-y-5 px-4 pb-32 pt-3">
      <Transport {...p} />
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <p className="label">Tracks</p>
          <p className="text-[11px] text-muted">tap a take: its volume, pan, which take plays</p>
        </div>
        <Arrangement {...p} tracks={tracks} onTake={(lane, sectionId) => setTakeOf({ lane, sectionId })} />
      </section>
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <p className="label">Channels</p>
          {soloing && (
            <button className="text-[11px] font-semibold text-accent" onClick={() => tracks.forEach((t) => channelOf(s, t.key).solo && p.setChannel(t.key, { solo: false }))}>
              Solo off
            </button>
          )}
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {tracks.map((t) => (
            <Strip key={t.key} {...p} track={t} dimmed={soloing && !channelOf(s, t.key).solo}>
              {t.key === "beat" &&
                (p.vocals ? (
                  <button
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${p.vocals.on ? "bg-accent-soft text-accent" : "bg-panel text-muted line-through"}`}
                    onClick={p.vocals.toggle}
                    title="The song's original vocals in the beat"
                  >
                    Vocals
                  </button>
                ) : (
                  <button className="rounded-full bg-panel px-2.5 py-1 text-[11px] font-semibold text-accent disabled:opacity-50" disabled={p.separating} onClick={p.onSeparate}>
                    {p.separating ? "Removing…" : "Remove vocals · 1 call"}
                  </button>
                ))}
            </Strip>
          ))}
        </div>
        {!p.lanes.length && <p className="px-1 text-xs text-muted">Your recordings (Lead, Double, Ad-libs…) get a channel each once you record them.</p>}
      </section>
      {takeOf && <TakeSheet {...p} lane={takeOf.lane} sectionId={takeOf.sectionId} onClose={() => setTakeOf(null)} />}
    </div>
  );
}

function Transport(p: MixerProps) {
  const [exporting, setExporting] = useState(false);
  return (
    <div className="flex items-center gap-3">
      <button
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30"
        onClick={() => (p.playing ? p.onStop() : p.onPlay(p.now >= p.total - 1 ? 0 : p.now))}
        aria-label={p.playing ? "Pause" : "Play"}
      >
        {p.playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
      </button>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-lg tabular-nums">
          {fmtTime(p.now)} <span className="text-sm text-muted">/ {fmtTime(p.total)}</span>
        </p>
        <p className="truncate text-xs text-muted">{p.parts.find((x) => p.now >= x.start && p.now < x.end)?.name ?? "—"}</p>
      </div>
      <button className="flex shrink-0 items-center gap-1.5 rounded-full bg-panel-2 px-3.5 py-2 text-sm font-semibold disabled:opacity-50" disabled={!p.onExport} onClick={() => setExporting(true)}>
        <Download className="h-4 w-4" /> Export
      </button>
      {exporting && p.onExport && <ExportSheet {...p} onExport={p.onExport} onClose={() => setExporting(false)} />}
    </div>
  );
}

/** stems for Logic: what goes in, and the ZIP */
function ExportSheet(p: MixerProps & { onExport: NonNullable<MixerProps["onExport"]>; onClose: () => void }) {
  const [o, setO] = useState<ExportOptions>({ kind: "zip", mixed: false, flow: false, mixdown: true, days: 30 });
  const mp3 = o.kind === "mp3";
  const share = o.kind === "share";
  /** the link just made */
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const seg = (on: boolean) => `flex-1 rounded-full py-2 text-sm font-semibold ${on ? "bg-panel text-fg shadow-sm" : "text-muted"}`;
  const layers = p.lanes.filter((l) => p.tree.takes.some((t) => t.lane === l && t.chosen));
  const files = 1 + layers.length + (o.flow && p.hasFlow ? 1 : 0) + (o.mixdown ? 1 : 0);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={() => !busy && p.onClose()}>
      <div onClick={(e) => e.stopPropagation()} className="max-h-[92dvh] w-full max-w-lg space-y-4 overflow-auto rounded-t-3xl bg-panel px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
        <div>
          <h2 className="text-xl font-bold">Export</h2>
        </div>
        <div className="flex rounded-full bg-panel-2 p-1">
          <button className={seg(!mp3)} onClick={() => setO({ ...o, kind: "zip" })}>
            Stems · WAV · ZIP
          </button>
          <button className={seg(mp3)} onClick={() => setO({ ...o, kind: "mp3" })}>
            Mix · MP3
          </button>
          <button className={seg(share)} onClick={() => setO({ ...o, kind: "share" })}>
            Share link
          </button>
        </div>
        <p className="text-xs text-muted">
          {mp3
            ? "The song as you hear it here — every channel's volume, pan and effect — in one MP3 (256 kbps, stereo): to listen to, or to send."
            : share
              ? "The stems (WAV) and the mix (MP3) online, behind a link: whoever has it can download them — single files or all as a ZIP — without an account. You can turn it off any time."
              : "Every track as its own WAV (24-bit), all from 0:00 to the end — they line up when you drop them at bar 1 in Logic. In one ZIP, with a note on the tempo."}
        </p>
        {!mp3 && (
        <div className="space-y-1.5">
          <p className="label">Sound</p>
          <div className="flex rounded-full bg-panel-2 p-1">
            <button className={seg(!o.mixed)} onClick={() => setO({ ...o, mixed: false })}>
              Dry
            </button>
            <button className={seg(o.mixed)} onClick={() => setO({ ...o, mixed: true })}>
              As mixed here
            </button>
          </div>
          <p className="text-[11px] text-muted">
            {o.mixed ? "With each channel's volume, pan and effect." : "As recorded (each take's cut and own volume kept) — to mix and add effects in Logic."}
          </p>
        </div>
        )}
        <div className="space-y-2 text-sm">
          <p className="label">{mp3 ? "In the mix" : "Files"}</p>
          <p className="flex justify-between">
            <span>Beat{layers.length ? ` · ${layers.join(" · ")}` : ""}</span>
            <span className="text-muted">{mp3 ? "as in the mixer" : "always"}</span>
          </p>
          {p.hasFlow && (
            <label className="flex items-center justify-between gap-3">
              Your recorded flow (guide)
              <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={o.flow} onChange={(e) => setO({ ...o, flow: e.target.checked })} />
            </label>
          )}
          {share && (
            <div className="flex items-center justify-between gap-3">
              Link works for
              <div className="flex rounded-full bg-panel-2 p-1">
                {[7, 30].map((d) => (
                  <button key={d} className={`rounded-full px-3 py-1 text-xs font-semibold ${o.days === d ? "bg-panel text-fg shadow-sm" : "text-muted"}`} onClick={() => setO({ ...o, days: d })}>
                    {d} days
                  </button>
                ))}
              </div>
            </div>
          )}
          {o.kind === "zip" && (
            <label className="flex items-center justify-between gap-3">
              The whole mix as one file
              <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={o.mixdown} onChange={(e) => setO({ ...o, mixdown: e.target.checked })} />
            </label>
          )}
        </div>
        {!mp3 && (
          <p className="text-[11px] text-muted">
            Stems as WAV only: an MP3 starts a few milliseconds late (the encoder adds silence), so MP3 stems would drift out of sync in Logic.
          </p>
        )}
        {err && <p className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad">{err}</p>}
        {link && <ShareLink link={link} title={p.tree.project.title} />}
        {share && <Shares pid={p.tree.project.id} fresh={link} />}
        {!link && (
        <button
          className="btn-primary w-full justify-center rounded-2xl py-3 disabled:opacity-60"
          disabled={!!busy}
          onClick={async () => {
            setErr(null);
            setBusy("Preparing…");
            try {
              const made = await p.onExport(o, setBusy);
              if (typeof made === "string") setLink(made);
              else p.onClose();
            } catch (e) {
              setErr(e instanceof Error ? e.message : "The export failed.");
            } finally {
              setBusy(null);
            }
          }}
        >
          <Download className="h-4 w-4" /> {busy ?? (mp3 ? "Export the mix · MP3" : share ? `Make a link · ${files - (o.mixdown ? 1 : 0)} WAV${files === 1 ? "" : "s"} + the mix` : `Export ${files} WAV${files === 1 ? "" : "s"} · ZIP`)}
        </button>
        )}
      </div>
    </div>
  );
}

/** every track along the song: the parts on top, each layer's takes where they play */
function Arrangement(p: MixerProps & { tracks: { key: string; name: string; color: string; lane?: string }[]; onTake: (lane: string, sectionId: string | null) => void }) {
  const [pps, setPps] = useState(6);
  const width = Math.max(320, p.total * pps);
  const box = useRef<HTMLDivElement | null>(null);
  const s = p.tree.project.settings;
  // playing: the playhead stays in view
  useEffect(() => {
    const el = box.current;
    if (!el || !p.playing) return;
    const x = p.now * pps;
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 40) el.scrollTo({ left: Math.max(0, x - 60), behavior: "smooth" });
  }, [p.now, p.playing, pps]);
  const rowH = 40;
  const flowTakes = p.tree.takes.filter((t) => t.lane === "Flow" && t.chosen);
  return (
    <div className="rounded-2xl bg-panel ring-1 ring-line/60">
      <div className="flex">
        {/* the track names stay put */}
        <div className="w-24 shrink-0 border-r border-line/60">
          <div className="h-7" />
          {p.tracks.map((t) => {
            const c = channelOf(s, t.key);
            return (
              <div key={t.key} className="flex items-center gap-1.5 truncate px-2 text-xs font-semibold" style={{ height: rowH }}>
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.color }} />
                <span className={`truncate ${c.mute ? "text-muted line-through" : ""}`}>{t.name}</span>
              </div>
            );
          })}
        </div>
        <div ref={box} className="min-w-0 flex-1 overflow-x-auto">
          <div className="relative" style={{ width }}>
            {/* the parts: tap to go there */}
            <div className="relative h-7 border-b border-line/60">
              {p.parts.map((x, i) => (
                <button
                  key={x.id}
                  className={`absolute top-0 h-full truncate border-l border-line/60 px-1.5 text-left text-[10px] font-semibold ${i % 2 ? "bg-panel-2/40" : ""}`}
                  style={{ left: x.start * pps, width: Math.max(8, (x.end - x.start) * pps) }}
                  onClick={() => p.onSeek(x.start)}
                  title={`${x.name} · ${fmtTime(x.start)}`}
                >
                  {x.name}
                </button>
              ))}
            </div>
            {p.tracks.map((t) => {
              const c = channelOf(s, t.key);
              const takes = t.lane ? p.tree.takes.filter((x) => x.lane === t.lane) : t.key === "flow" ? flowTakes : [];
              const chosen = takes.filter((x) => x.chosen);
              return (
                <div key={t.key} className={`relative border-b border-line/40 ${c.mute ? "opacity-40" : ""}`} style={{ height: rowH }}>
                  {t.key === "beat" &&
                    p.parts.map((x) => (
                      <div key={x.id} className="absolute inset-y-1.5 rounded-md" style={{ left: x.start * pps + 1, width: Math.max(2, (x.end - x.start) * pps - 2), background: "color-mix(in srgb, #94a3b8 30%, transparent)" }} />
                    ))}
                  {t.key === "voice" &&
                    p.parts.map((x) => (
                      <div key={x.id} className="absolute inset-y-3 rounded-md" style={{ left: x.start * pps + 1, width: Math.max(2, (x.end - x.start) * pps - 2), background: "color-mix(in srgb, #f472b6 25%, transparent)" }} />
                    ))}
                  {chosen.map((x) => {
                    const from = x.start_at + (x.trim_in ?? 0);
                    const len = (x.trim_out ?? x.duration) - (x.trim_in ?? 0);
                    const others = takes.filter((y) => y.section_id === x.section_id).length;
                    return (
                      <button
                        key={x.id}
                        className="absolute inset-y-1 overflow-hidden rounded-md text-left ring-1 ring-black/10"
                        style={{ left: from * pps, width: Math.max(6, len * pps), background: `color-mix(in srgb, ${t.color} 35%, transparent)` }}
                        onClick={() => t.lane && p.onTake(t.lane, x.section_id)}
                        disabled={!t.lane}
                        aria-label={`${t.name} take ${x.take_no}`}
                      >
                        <Peaks peaks={x.peaks ?? []} color={t.color} />
                        <span className="absolute left-1 top-0.5 text-[9px] font-bold text-fg/80">
                          {x.take_no}
                          {others > 1 ? `/${others}` : ""}
                          {(x.gain ?? 1) !== 1 ? ` · ${Math.round((x.gain ?? 1) * 100)}%` : ""}
                          {Math.abs(x.pan ?? 0) >= 0.02 ? ` · ${panLabel(x.pan ?? 0)}` : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {/* the playhead */}
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-[#dc2626]" style={{ left: p.now * pps }} />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1 border-t border-line/60 px-2 py-1">
        <span className="mr-1 text-[10px] text-muted">Zoom</span>
        {[3, 6, 12, 24].map((z) => (
          <button key={z} className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${pps === z ? "bg-accent-soft text-accent" : "text-muted"}`} onClick={() => setPps(z)}>
            {z / 6}×
          </button>
        ))}
      </div>
    </div>
  );
}

function Peaks({ peaks, color }: { peaks: number[]; color: string }) {
  if (!peaks.length) return null;
  return (
    <svg viewBox={`0 0 ${peaks.length} 20`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
      {peaks.map((v, i) => (
        <rect key={i} x={i} y={10 - Math.max(0.3, v * 9)} width={0.7} height={Math.max(0.6, v * 18)} fill={color} />
      ))}
    </svg>
  );
}

/** one channel: mute, solo, its sound (a layer), volume, pan */
function Strip(p: MixerProps & { track: { key: string; name: string; color: string; lane?: string }; dimmed: boolean; children?: ReactNode }) {
  const c = channelOf(p.tree.project.settings, p.track.key);
  const toggle = (on: boolean, label: string, onClick: () => void, cls: string) => (
    <button className={`h-8 w-8 shrink-0 rounded-lg text-xs font-bold ${on ? cls : "bg-panel text-muted ring-1 ring-line/60"}`} onClick={onClick} aria-pressed={on} aria-label={`${label} ${p.track.name}`}>
      {label[0]}
    </button>
  );
  return (
    <div className={`rounded-2xl bg-panel-2/70 px-3.5 py-3 ${c.mute || p.dimmed ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2">
        <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: p.track.color }} />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{p.track.name}</span>
        {p.children}
        {toggle(c.mute, "Mute", () => p.setChannel(p.track.key, { mute: !c.mute }), "bg-warn text-white")}
        {toggle(c.solo, "Solo", () => p.setChannel(p.track.key, { solo: !c.solo }), "bg-accent text-white")}
      </div>
      {p.track.lane && (
        <label className="mt-2 flex items-center gap-2 text-xs text-muted">
          Sound
          <select
            className="min-w-0 flex-1 truncate rounded-full bg-panel px-2.5 py-1.5 text-xs font-semibold text-accent ring-1 ring-line/60"
            value={layerPreset(p.tree.project.settings?.fx, p.track.lane).id}
            onChange={(e) => p.setSound(p.track.lane!, e.target.value)}
            aria-label={`${p.track.name} effect`}
          >
            {FX_CATEGORIES.map((cat) => (
              <optgroup key={cat} label={cat}>
                {FX_PRESETS.filter((x) => x.category === cat).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}
      <VolumeSlider value={c.vol} label={p.track.name} onValue={(v) => p.setChannel(p.track.key, { vol: Math.round(v * 100) / 100 })} />
      <PanSlider value={c.pan} label={p.track.name} onValue={(v) => p.setChannel(p.track.key, { pan: v })} />
    </div>
  );
}

/** left … centre … right; tap the value for the centre again */
export function PanSlider({ value, onValue, label }: { value: number; onValue: (v: number) => void; label: string }) {
  const left = Math.min(50, 50 + value * 50);
  const right = Math.max(50, 50 + value * 50);
  return (
    <div className="mt-1 flex items-center gap-3">
      <span className="text-[10px] font-bold text-muted">L</span>
      <div className="relative flex-1">
        <span className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-px -translate-y-1/2 bg-muted/50" />
        <input
          type="range"
          min={-1}
          max={1}
          step={0.02}
          value={value}
          onChange={(e) => onValue(Math.abs(Number(e.target.value)) < 0.03 ? 0 : Number(e.target.value))}
          className="vf-pan relative w-full"
          aria-label={`${label} pan`}
          style={{ ["--from" as string]: `${left}%`, ["--to" as string]: `${right}%` }}
        />
      </div>
      <span className="text-[10px] font-bold text-muted">R</span>
      <button className={`w-11 shrink-0 rounded-full py-1 text-right font-mono text-xs tabular-nums ${Math.abs(value) < 0.02 ? "text-muted" : "font-semibold text-accent"}`} onClick={() => onValue(0)} aria-label={`${label} pan to the centre`}>
        {panLabel(value)}
      </button>
    </div>
  );
}

/** a part's takes on a layer: which one plays, and its own volume and pan */
function TakeSheet(p: MixerProps & { lane: string; sectionId: string | null; onClose: () => void }) {
  const takes = p.tree.takes.filter((t) => t.lane === p.lane && t.section_id === p.sectionId).sort((a, b) => a.take_no - b.take_no);
  const chosen = takes.find((t) => t.chosen) ?? takes[takes.length - 1];
  const [sel, setSel] = useState(chosen?.id ?? null);
  const t = takes.find((x) => x.id === sel) ?? chosen;
  const part = p.parts.find((x) => x.id === p.sectionId);
  const [mix, setMix] = useState({ gain: t?.gain ?? 1, pan: t?.pan ?? 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // the changes not saved yet (volume and pan together)
  const pending = useRef<{ id: string; gain?: number; pan?: number } | null>(null);
  if (!t) return null;
  const flush = () => {
    const x = pending.current;
    pending.current = null;
    if (timer.current) clearTimeout(timer.current);
    if (x) void p.call(`/api/takes/${x.id}`, { gain: x.gain, pan: x.pan }, "PATCH");
  };
  const change = (patch: { gain?: number; pan?: number }) => {
    setMix((m) => ({ ...m, ...patch }));
    p.liveTake(t.id, patch);
    if (pending.current && pending.current.id !== t.id) flush();
    pending.current = { ...(pending.current ?? { id: t.id }), ...patch };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  };
  const pick = (x: Take) => {
    flush();
    setSel(x.id);
    setMix({ gain: x.gain ?? 1, pan: x.pan ?? 0 });
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40"
      onClick={() => {
        flush();
        p.onClose();
      }}
    >
      <div onClick={(e) => e.stopPropagation()} className="max-h-[92dvh] w-full max-w-lg space-y-3 overflow-auto rounded-t-3xl bg-panel px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
        <div>
          <h2 className="text-xl font-bold">
            {p.lane}
            {part ? ` · ${part.name}` : ""}
          </h2>
          <p className="text-xs text-muted">The take that plays is marked. Its cut: Record → ✂ on the take.</p>
        </div>
        <div className="space-y-1.5">
          {takes.map((x) => (
            <div key={x.id} className={`flex items-center gap-2 rounded-2xl px-3 py-2 ${x.id === t.id ? "bg-accent-soft" : "bg-panel-2/70"}`}>
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => pick(x)}>
                <span className="text-sm font-semibold">Take {x.take_no}</span>
                <span className="font-mono text-[11px] text-muted">{fmtTime(x.start_at + (x.trim_in ?? 0))}</span>
                {x.chosen && <span className="text-[11px] font-semibold text-accent">plays</span>}
              </button>
              <button
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-panel"
                onClick={() => {
                  pick(x);
                  p.onPlay(Math.max(0, x.start_at + (x.trim_in ?? 0) - 1));
                }}
                aria-label={`Play take ${x.take_no}`}
              >
                <Play className="ml-0.5 h-3.5 w-3.5" />
              </button>
              {!x.chosen && (
                <button className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-panel px-3 text-xs font-semibold" onClick={() => void p.call(`/api/takes/${x.id}`, {}, "PATCH")}>
                  <Check className="h-3.5 w-3.5" /> Use
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="rounded-2xl bg-panel-2/70 px-4 py-3">
          <p className="text-sm font-semibold">Take {t.take_no} on its own</p>
          <VolumeSlider value={mix.gain} max={TAKE_MAX} label={`Take ${t.take_no}`} onValue={(v) => change({ gain: Math.round(v * 100) / 100 })} />
          {louderGain(t.peaks ?? []) !== null && Math.abs((louderGain(t.peaks ?? []) ?? 1) - mix.gain) > 0.05 && (
            <button className="mt-1 rounded-full bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent" onClick={() => change({ gain: louderGain(t.peaks ?? [])! })}>
              {louderGain(t.peaks ?? [])! > mix.gain ? "Louder" : "Softer"} · as loud as it can be ({Math.round(louderGain(t.peaks ?? [])! * 100)}%)
            </button>
          )}
          <PanSlider value={mix.pan} label={`Take ${t.take_no}`} onValue={(v) => change({ pan: v })} />
          <p className="mt-1 text-[11px] text-muted">On top of the {p.lane} channel. Only the take that plays is heard in the song.</p>
        </div>
        <button
          className="btn-primary w-full justify-center rounded-2xl py-3"
          onClick={() => {
            flush();
            p.onClose();
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

/** the link just made: copy it, or send it (the phone's share sheet) */
function ShareLink({ link, title }: { link: string; title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-2xl bg-ok-soft px-4 py-3">
      <p className="text-sm font-semibold text-ok">The link is ready</p>
      <p className="break-all rounded-xl bg-panel px-3 py-2 font-mono text-xs">{link}</p>
      <div className="flex gap-2">
        <button
          className="btn flex-1 justify-center rounded-xl border-0 bg-panel py-2 text-sm"
          onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true), () => {})}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {typeof navigator !== "undefined" && "share" in navigator && (
          <button className="btn-primary flex-1 justify-center rounded-xl py-2 text-sm" onClick={() => void navigator.share({ title, text: `${title} — the stems and the mix`, url: link }).catch(() => {})}>
            Share…
          </button>
        )}
      </div>
    </div>
  );
}

/** the song's links that still work: until when, turn one off */
function Shares({ pid, fresh }: { pid: string; fresh: string | null }) {
  const [list, setList] = useState<{ token: string; files: number; bytes: number; expires_at: string }[] | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let gone = false;
    void fetch(`/api/projects/${pid}/shares`)
      .then((r) => r.json())
      .then((r: { shares?: { token: string; files: number; bytes: number; expires_at: string }[] }) => !gone && setList(r.shares ?? []))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [pid, fresh, n]);
  if (!list?.length) return null;
  return (
    <div className="space-y-1.5">
      <p className="label">Links that work now</p>
      {list.map((s) => (
        <div key={s.token} className="flex items-center gap-2 rounded-xl bg-panel-2/70 px-3 py-2 text-xs">
          <a className="min-w-0 flex-1 truncate font-mono text-accent" href={`/s/${s.token}`} target="_blank" rel="noreferrer">
            /s/{s.token.slice(0, 10)}…
          </a>
          <span className="shrink-0 text-muted">
            {s.files} files · until {new Date(s.expires_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
          </span>
          <button
            className="shrink-0 rounded-full bg-panel px-2.5 py-1 font-semibold text-bad"
            onClick={async () => {
              if (!window.confirm("Turn this link off? Its files are deleted; whoever has it can't download any more.")) return;
              await fetch(`/api/projects/${pid}/shares?token=${s.token}`, { method: "DELETE" });
              setN((x) => x + 1);
            }}
          >
            Turn off
          </button>
        </div>
      ))}
    </div>
  );
}
