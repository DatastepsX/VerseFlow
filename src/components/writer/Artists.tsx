"use client";

import { useEffect, useRef, useState } from "react";
import { ARTIST_COLORS, projectArtists, sectionArtists } from "@/lib/artists";
import type { Artist, ProjectTree } from "@/lib/types";
import { useWriter } from "./context";

type SectionT = ProjectTree["sections"][number];

export function ArtistChip({ artist, small }: { artist: Pick<Artist, "name" | "color">; small?: boolean }) {
  return (
    <span
      className={`inline-flex max-w-[9rem] items-center gap-1 truncate rounded-full font-semibold normal-case tracking-normal text-white ${small ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-[11px]"}`}
      style={{ background: artist.color }}
    >
      {artist.name}
    </span>
  );
}

/** who performs this section: chips + a picker (toggle performers, add a new one) */
export function SectionArtists({ section }: { section: SectionT }) {
  const w = useWriter();
  const pid = w.tree.project.id;
  const all = projectArtists(w.tree.project);
  const mine = sectionArtists(w.tree.project, section);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  // the ticks follow the tap at once; the saved state takes over when the server answers
  const [pending, setPending] = useState<string[] | null>(null);
  const current = pending ?? section.artists ?? [];
  const setArtists = async (ids: string[]) => {
    setPending(ids);
    await w.mutate(`/api/sections/${section.id}`, { artists: ids }, "PATCH");
    setPending(null);
  };
  const toggle = (id: string) => void setArtists(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  const addNew = async () => {
    const n = name.trim();
    if (!n) return;
    const res = await w.mutate(`/api/projects/${pid}`, { action: "addArtist", name: n, color: ARTIST_COLORS[all.length % ARTIST_COLORS.length] });
    const id = res?.headers.get("x-artist-id");
    if (id) await setArtists([...current, id]);
    setName("");
  };

  return (
    <div ref={box} className="relative flex min-w-0 items-center gap-1">
      <button className="flex min-w-0 items-center gap-1" onClick={() => setOpen((o) => !o)} title="Who performs this section">
        {mine.length ? mine.map((a) => <ArtistChip key={a.id} artist={a} />) : <span className="btn-ghost px-1 py-0.5 text-xs text-muted">🎤 who?</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-60 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-panel p-2 text-sm shadow-lg">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Performed by</div>
          {all.length === 0 && <p className="mb-1 text-xs text-muted">No performers yet — add the first one.</p>}
          {all.map((a) => (
            <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-panel-2">
              <input type="checkbox" checked={current.includes(a.id)} onChange={() => toggle(a.id)} />
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: a.color }} />
              <span className="truncate">{a.name}</span>
            </label>
          ))}
          <div className="mt-1 flex gap-1">
            <input
              className="input py-1 text-sm"
              placeholder="New performer…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addNew()}
            />
            <button className="btn px-2 py-1 text-xs" disabled={!name.trim()} onClick={() => void addNew()}>
              Add
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted">Rename, colours and voice notes: Settings → Performers.</p>
        </div>
      )}
    </div>
  );
}

/** Settings: the song's performers — name, colour and a voice/style note the AI writes their parts with */
export function ArtistsEditor() {
  const w = useWriter();
  const pid = w.tree.project.id;
  const all = projectArtists(w.tree.project);
  const [name, setName] = useState("");
  const update = (artistId: string, patch: Record<string, string>) => void w.mutate(`/api/projects/${pid}`, { action: "updateArtist", artistId, ...patch });
  const parts = (id: string) => w.tree.sections.filter((s) => s.artists?.includes(id)).map((s) => s.name);
  return (
    <div className="space-y-2">
      <label className="label">Performers</label>
      {all.length === 0 && <p className="text-xs text-muted">Add the singers / rappers of this song, then assign sections to them (🎤 next to a section name).</p>}
      {all.map((a) => (
        <div key={a.id} className="rounded-md border border-line p-2">
          <div className="flex items-center gap-2">
            <button
              className="h-5 w-5 shrink-0 rounded-full border border-line"
              style={{ background: a.color }}
              title="Change colour"
              onClick={() => update(a.id, { color: ARTIST_COLORS[(ARTIST_COLORS.indexOf(a.color) + 1) % ARTIST_COLORS.length] })}
            />
            <input className="input py-1 text-sm" defaultValue={a.name} key={a.name} onBlur={(e) => e.target.value.trim() !== a.name && update(a.id, { name: e.target.value })} />
            <button
              className="btn-ghost px-1 text-xs text-bad"
              onClick={() => window.confirm(`Remove ${a.name}? Their sections stay, just without a performer.`) && void w.mutate(`/api/projects/${pid}`, { action: "removeArtist", artistId: a.id })}
            >
              ✕
            </button>
          </div>
          <input
            className="input mt-1 py-1 text-xs"
            placeholder="Voice / style (e.g. melodic female vocals, aggressive rap flow)"
            defaultValue={a.notes ?? ""}
            key={a.notes ?? ""}
            onBlur={(e) => e.target.value.trim() !== (a.notes ?? "") && update(a.id, { notes: e.target.value })}
          />
          <p className="mt-1 truncate text-[11px] text-muted">{parts(a.id).length ? `Performs: ${parts(a.id).join(", ")}` : "No sections yet"}</p>
        </div>
      ))}
      <div className="flex gap-1">
        <input className="input py-1 text-sm" placeholder="Add a performer…" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn px-2 text-xs"
          disabled={!name.trim()}
          onClick={() => {
            void w.mutate(`/api/projects/${pid}`, { action: "addArtist", name: name.trim(), color: ARTIST_COLORS[all.length % ARTIST_COLORS.length] });
            setName("");
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}
