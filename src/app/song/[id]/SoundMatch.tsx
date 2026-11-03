"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Trash } from "@/components/icons";
import { matchSound, monoOf, type SoundMatch } from "@/lib/fx/match";
import { FX_PRESETS, registerFx, type FxPreset } from "@/lib/fx/presets";
import type { ProjectTree } from "@/lib/types";

/**
 * The sound library beyond the built-in sounds — my sounds, the ones shared with everyone, the ones this song
 * uses — and making a sound from a voice: a song's vocals, a file or a take is listened to and the effect chain
 * that sounds like it is found (lib/fx/match: no AI call, nothing uploaded).
 */

type LibrarySound = FxPreset & { by?: string | null; byName?: string | null; mayEdit?: boolean };
interface Library {
  mine: LibrarySound[];
  shared: LibrarySound[];
}

/** the library, loaded once and kept up to date; its sounds are playable once loaded */
export function useSoundLibrary() {
  const [lib, setLib] = useState<Library | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const apply = useCallback((l: Library) => {
    registerFx([...l.mine, ...l.shared]);
    setLib({ mine: l.mine, shared: l.shared });
  }, []);
  useEffect(() => {
    let gone = false;
    void fetch("/api/fx", { cache: "no-store" })
      .then((r) => r.json())
      .then((l: Library) => {
        if (!gone && l.mine) apply(l);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [apply]);
  const call = async (method: string, payload?: unknown, query = "") => {
    setErr(null);
    const res = await fetch(`/api/fx${query}`, { method, headers: payload ? { "content-type": "application/json" } : undefined, body: payload ? JSON.stringify(payload) : undefined });
    const data = (await res.json().catch(() => ({}))) as Library & { error?: string; id?: string };
    if (!res.ok) {
      setErr(data.error ?? "Something went wrong");
      return null;
    }
    apply(data);
    return data;
  };
  return {
    lib,
    err,
    save: (preset: FxPreset, scope: "mine" | "shared") => call("POST", { preset, scope }),
    rename: (id: string, name: string) => call("PATCH", { id, name }),
    remove: (id: string) => call("DELETE", undefined, `?id=${encodeURIComponent(id)}`),
  };
}

export type SoundLibraryApi = ReturnType<typeof useSoundLibrary>;

/** My sounds · Shared sounds · In this song — tap one to use it (as the built-in ones), ⋯ to rename, share or remove */
export function LibrarySounds({ api, tree, current, onPick, disabled }: { api: SoundLibraryApi; tree: ProjectTree; current: string; onPick: (id: string) => void; disabled: boolean }) {
  const [menu, setMenu] = useState<string | null>(null);
  const { lib } = api;
  const inLib = new Set([...(lib?.mine ?? []), ...(lib?.shared ?? [])].map((s) => s.id));
  const songOnly = Object.values(tree.project.settings?.customFx ?? {}).filter((s) => !inLib.has(s.id) && !FX_PRESETS.some((p) => p.id === s.id));
  const group = (title: string, list: LibrarySound[], kind: "mine" | "shared" | "song") =>
    list.length > 0 && (
      <div key={title}>
        <p className="label">{title}</p>
        <div className="grid grid-cols-2 gap-2">
          {list.map((p) => {
            const on = p.id === current;
            const editable = kind === "mine" || (kind === "shared" && p.mayEdit);
            return (
              <div key={p.id} className={`relative rounded-2xl ring-1 ${on ? "bg-accent-soft ring-accent" : "bg-panel-2 ring-transparent"}`}>
                <button className="w-full p-3 pr-8 text-left disabled:opacity-50" disabled={disabled} onClick={() => onPick(p.id)} aria-pressed={on}>
                  <span className="flex items-center gap-1 text-sm font-bold">
                    {on && <Check className="h-3.5 w-3.5 text-accent" />}
                    {p.name}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-muted">{p.about}</span>
                  {kind === "shared" && p.byName && <span className="mt-0.5 block text-[10px] text-muted">by {p.byName}</span>}
                </button>
                <button className="absolute right-1.5 top-1.5 rounded-full px-1.5 text-sm font-bold text-muted" onClick={() => setMenu(menu === `${kind}:${p.id}` ? null : `${kind}:${p.id}`)} aria-label={`More for ${p.name}`}>
                  ⋯
                </button>
                {/* a sound can be in my sounds and shared (the same id): the menu is the one tapped */}
                {menu === `${kind}:${p.id}` && (
                  <div className="space-y-1 border-t border-line/60 p-2 text-xs">
                    {editable && (
                      <button
                        className="block w-full rounded-lg px-2 py-1 text-left font-semibold hover:bg-panel"
                        onClick={async () => {
                          const n = window.prompt("Name of this sound:", p.name);
                          if (n?.trim()) await api.rename(p.id, n.trim());
                          setMenu(null);
                        }}
                      >
                        Rename
                      </button>
                    )}
                    {kind !== "shared" && (
                      <button
                        className="block w-full rounded-lg px-2 py-1 text-left font-semibold hover:bg-panel"
                        onClick={async () => {
                          if (await api.save(p, "shared")) setMenu(null);
                        }}
                      >
                        Share with everyone
                      </button>
                    )}
                    {kind !== "mine" && (
                      <button
                        className="block w-full rounded-lg px-2 py-1 text-left font-semibold hover:bg-panel"
                        onClick={async () => {
                          if (await api.save(p, "mine")) setMenu(null);
                        }}
                      >
                        Save to my sounds
                      </button>
                    )}
                    {editable && (
                      <button
                        className="flex w-full items-center gap-1 rounded-lg px-2 py-1 text-left font-semibold text-bad hover:bg-panel"
                        onClick={async () => {
                          if (window.confirm(`Remove “${p.name}” from ${kind === "shared" ? "the shared sounds (for everyone)" : "your sounds"}? Songs using it keep it.`)) await api.remove(p.id);
                          setMenu(null);
                        }}
                      >
                        <Trash className="h-3 w-3" /> Remove
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  return (
    <>
      {group("My sounds", lib?.mine ?? [], "mine")}
      {group("Shared sounds", lib?.shared ?? [], "shared")}
      {group("In this song", songOnly, "song")}
      {api.err && <p className="text-xs text-bad">{api.err}</p>}
    </>
  );
}

// ---------- a sound from a voice ----------

type Source = { kind: "vocals"; sectionId: string | "all" } | { kind: "take"; takeId: string } | { kind: "file"; file: File };

async function decode(data: ArrayBuffer) {
  const Ctx = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  return new Ctx(2, 1, 44100).decodeAudioData(data);
}
const channelsOf = (b: AudioBuffer, from = 0, to = b.duration) => {
  const a = Math.max(0, Math.floor(from * b.sampleRate));
  const z = Math.min(b.length, Math.ceil(Math.min(to, from + 90) * b.sampleRate));
  return Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, k) => b.getChannelData(k).slice(a, z));
};
const takeUrl = async (pid: string, id: string) => ((await fetch(`/api/projects/${pid}/takes?ids=${id}`).then((r) => r.json())) as { urls?: Record<string, string> }).urls?.[id];

/** where a part plays in the song */
function partRange(tree: ProjectTree, sectionId: string) {
  const i = tree.sections.findIndex((s) => s.id === sectionId);
  const startOf = (k: number) => tree.sections[k]?.audio_start ?? tree.sections[k]?.lines.find((l) => l.audio_at !== null)?.audio_at ?? null;
  const start = startOf(i) ?? 0;
  const next = tree.sections.slice(i + 1).map((_, k) => startOf(i + 1 + k)).find((v) => v !== null && v > start);
  return { start, end: next ?? start + 60 };
}

export function MatchSheet({
  tree,
  lane,
  sectionId,
  api,
  onUse,
  onClose,
}: {
  tree: ProjectTree;
  lane: string;
  sectionId: string | null;
  api: SoundLibraryApi;
  /** the sound found: on this layer (played at once) */
  onUse: (p: FxPreset) => void;
  onClose: () => void;
}) {
  const pid = tree.project.id;
  const takes = tree.takes.filter((t) => t.chosen && t.lane !== "Flow");
  const [vocals, setVocals] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let gone = false;
    void fetch(`/api/projects/${pid}/audio`)
      .then((r) => r.json())
      .then((a: { vocalsUrl?: string | null }) => {
        if (!gone) setVocals(a.vocalsUrl ?? null);
      })
      .catch(() => {
        if (!gone) setVocals(null);
      });
    return () => {
      gone = true;
    };
  }, [pid]);
  const [source, setSource] = useState<Source | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [found, setFound] = useState<SoundMatch | null>(null);
  const [name, setName] = useState("");
  const [saved, setSaved] = useState<"mine" | "shared" | null>(null);
  const kind = source?.kind ?? (vocals ? "vocals" : "file");

  const listen = async () => {
    if (!source) return;
    setErr(null);
    setFound(null);
    setSaved(null);
    try {
      setBusy("Loading the voice…");
      let buf: AudioBuffer;
      let from = 0;
      let to = Infinity;
      if (source.kind === "file") buf = await decode(await source.file.arrayBuffer());
      else if (source.kind === "take") {
        const url = await takeUrl(pid, source.takeId);
        if (!url) throw new Error("That take couldn't be loaded.");
        buf = await decode(await fetch(url).then((r) => r.arrayBuffer()));
      } else {
        if (!vocals) throw new Error("The song's vocals aren't apart yet — More → The song's vocals → Remove the vocals.");
        buf = await decode(await fetch(vocals).then((r) => r.arrayBuffer()));
        if (source.sectionId !== "all") ({ start: from, end: to } = partRange(tree, source.sectionId));
      }
      // your own voice dry (this layer's take in this part), to hear what the effects add to a voice
      const mine = tree.takes.find((t) => t.chosen && t.lane === lane && t.section_id === sectionId && !(source.kind === "take" && t.id === source.takeId));
      let dry: Float32Array | null = null;
      if (mine) {
        const url = await takeUrl(pid, mine.id);
        if (url) dry = monoOf(channelsOf(await decode(await fetch(url).then((r) => r.arrayBuffer()))));
      }
      setBusy("Listening to the sound…");
      await new Promise((r) => setTimeout(r, 30));
      const m = matchSound(channelsOf(buf, from, to), buf.sampleRate, { dry, drySr: 44100, bpm: tree.audio?.bpm ?? null });
      const id = `fx-${Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      m.preset.id = id;
      setFound(m);
      setName(m.preset.name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The voice couldn't be listened to.");
    } finally {
      setBusy(null);
    }
  };
  const preset = found ? { ...found.preset, name: name.trim() || found.preset.name } : null;
  const opt = (on: boolean) => `rounded-full px-3 py-1.5 text-xs font-semibold ${on ? "bg-accent text-white" : "bg-panel-2 text-fg/80"}`;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={() => !busy && onClose()}>
      <div onClick={(e) => e.stopPropagation()} className="max-h-[92dvh] w-full max-w-lg space-y-4 overflow-auto rounded-t-3xl bg-panel px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
        <div>
          <h2 className="text-xl font-bold">A sound from a voice</h2>
          <p className="text-xs text-muted">Pick a voice that has the sound you want — the app listens to it and finds its effects (tone, compression, reverb, echo, width, autotune). Nothing is uploaded, no AI call.</p>
        </div>
        <div className="space-y-2">
          <p className="label">The voice</p>
          <div className="flex flex-wrap gap-1.5">
            <button className={opt(kind === "vocals")} disabled={!vocals} onClick={() => setSource({ kind: "vocals", sectionId: sectionId ?? "all" })}>
              The song&apos;s vocals{vocals === null ? " (not apart yet)" : ""}
            </button>
            <button className={opt(kind === "take")} disabled={!takes.length} onClick={() => takes[0] && setSource({ kind: "take", takeId: takes[0].id })}>
              A take
            </button>
            <label className={`${opt(kind === "file")} cursor-pointer`}>
              A file…
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setSource({ kind: "file", file: f });
                }}
              />
            </label>
          </div>
          {source?.kind === "vocals" && (
            <select className="input text-sm" value={source.sectionId} onChange={(e) => setSource({ kind: "vocals", sectionId: e.target.value })}>
              {tree.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value="all">The whole song (its first 90 s)</option>
            </select>
          )}
          {source?.kind === "take" && (
            <select className="input text-sm" value={source.takeId} onChange={(e) => setSource({ kind: "take", takeId: e.target.value })}>
              {takes.map((t) => (
                <option key={t.id} value={t.id}>
                  {tree.sections.find((s) => s.id === t.section_id)?.name ?? "The song"} · {t.lane} take {t.take_no}
                </option>
              ))}
            </select>
          )}
          {source?.kind === "file" && <p className="truncate text-xs text-muted">{source.file.name} — its first 90 s</p>}
        </div>
        <button className="btn-primary w-full justify-center rounded-2xl py-3 text-sm disabled:opacity-50" disabled={!source || !!busy} onClick={() => void listen()}>
          {busy ?? (found ? "Listen again" : "Find the sound")}
        </button>
        {err && <p className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad">{err}</p>}
        {found && preset && (
          <div className="space-y-3 rounded-2xl bg-accent-soft/50 p-3">
            <label className="block space-y-1">
              <span className="label">Its name</span>
              <input className="input text-base font-semibold" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <ul className="space-y-0.5 text-xs">
              {found.found.map((f) => (
                <li key={f}>· {f}</li>
              ))}
            </ul>
            <button
              className="btn-primary w-full justify-center rounded-xl py-2.5 text-sm"
              onClick={() => {
                registerFx([preset]);
                onUse(preset);
              }}
            >
              Use it on the {lane} · hear it
            </button>
            <div className="flex gap-2">
              <button
                className="btn flex-1 justify-center rounded-xl py-2 text-xs disabled:opacity-60"
                disabled={!!saved}
                onClick={async () => {
                  if (await api.save(preset, "mine")) setSaved("mine");
                }}
              >
                {saved === "mine" ? "✓ In my sounds" : "Save to my sounds"}
              </button>
              <button
                className="btn flex-1 justify-center rounded-xl py-2 text-xs disabled:opacity-60"
                disabled={!!saved}
                onClick={async () => {
                  if (await api.save(preset, "shared")) setSaved("shared");
                }}
              >
                {saved === "shared" ? "✓ Shared" : "Share with everyone"}
              </button>
            </div>
            <p className="text-[11px] text-muted">A guess from what can be heard — try it on your take, and change its name to what it is for you.</p>
          </div>
        )}
      </div>
    </div>
  );
}
