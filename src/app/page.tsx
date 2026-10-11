"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { MAX_BEAT_BYTES, uploadBeat } from "@/lib/client/beat";
import { LANGUAGES, PROJECT_TYPES, type Project, type ProjectType } from "@/lib/types";

type ProjectRow = Pick<Project, "id" | "title" | "type" | "language" | "updated_at">;

export default function Dashboard() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [song, setSong] = useState<File | null>(null);
  const [readLyrics, setReadLyrics] = useState(true);
  const [form, setForm] = useState({
    title: "",
    type: "song" as ProjectType,
    language: "it",
    concept: "",
    genre: "",
    style: "",
    simpleLanguage: true,
  });

  useEffect(() => {
    api<ProjectRow[]>("/api/projects").then(setProjects, (e: Error) => setError(e.message));
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const p = await api<Project>("/api/projects", {
        body: {
          title: form.title || "Untitled",
          type: form.type,
          language: form.language,
          concept: form.concept || null,
          settings: { genre: form.genre || undefined, style: form.style || undefined, simpleLanguage: form.simpleLanguage },
        },
      });
      if (song) {
        try {
          await api(`/api/projects/${p.id}/audio`, { body: await uploadBeat(p.id, song, setStatus) });
          if (readLyrics) {
            // 1 ElevenLabs call, then the song is rebuilt from its vocals (sections + lines, free)
            setStatus("Reading the lyrics from the song… (up to a minute)");
            await api(`/api/projects/${p.id}/lyrics`, { body: { action: "transcribe", autoSections: true } });
            setStatus("Building the sections…");
            await api(`/api/projects/${p.id}/lyrics`, { body: { action: "rebuild" } });
          }
        } catch (err) {
          // the project exists already: open it and say what is missing
          window.alert(`The project was created, but: ${(err as Error).message}`);
        }
      }
      router.push(`/p/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      setStatus(null);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">VerseFlow</h1>
          <p className="text-sm text-muted">Write line by line. Keep what you approve.</p>
        </div>
        {!creating && (
          <button className="btn-primary" onClick={() => setCreating(true)}>
            + New project
          </button>
        )}
      </header>

      {error && <p className="mb-4 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}

      {creating && (
        <form onSubmit={create} className="mb-8 space-y-4 rounded-xl border border-line bg-panel p-5">
          <h2 className="font-semibold">New project</h2>
          <div>
            <label className="label">Title</label>
            <input
              className="input"
              autoFocus
              value={form.title}
              placeholder="Cold Heart"
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Song / beat (optional)</label>
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-line px-3 py-2.5 text-sm hover:bg-panel-2">
              <span>🎵</span>
              <span className={`min-w-0 flex-1 truncate ${song ? "" : "text-muted"}`}>{song ? song.name : "Choose an MP3 / audio file (max 50 MB)"}</span>
              {song && (
                <button
                  type="button"
                  className="btn-ghost px-1 text-xs"
                  onClick={(e) => {
                    e.preventDefault();
                    setSong(null);
                  }}
                >
                  ✕
                </button>
              )}
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (f && f.size > MAX_BEAT_BYTES) {
                    setError("The file is larger than 50 MB.");
                    return;
                  }
                  setSong(f);
                  // the song's name as title when none is typed yet
                  if (f && !form.title.trim()) setForm({ ...form, title: f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() });
                }}
              />
            </label>
            {song && (
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={readLyrics} onChange={(e) => setReadLyrics(e.target.checked)} />
                <span>
                  Has vocals: read the lyrics and build the sections (verse, chorus, rap…) · 1 call
                </span>
              </label>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Type</label>
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ProjectType })}>
                {PROJECT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Language</label>
              <select className="input" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Story / concept (optional)</label>
            <textarea
              className="input min-h-24"
              value={form.concept}
              placeholder="A man is left by the woman he loves. It starts softly, remembering the good parts…"
              onChange={(e) => setForm({ ...form, concept: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Genre</label>
              <input className="input" value={form.genre} placeholder="Italian rap" onChange={(e) => setForm({ ...form, genre: e.target.value })} />
            </div>
            <div>
              <label className="label">Style / references</label>
              <input className="input" value={form.style} placeholder="modern, emotional" onChange={(e) => setForm({ ...form, style: e.target.value })} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.simpleLanguage} onChange={(e) => setForm({ ...form, simpleLanguage: e.target.checked })} />
            Prefer simple, modern wording
          </label>
          <div className="flex items-center justify-end gap-2">
            {status && <span className="mr-auto text-sm text-muted">{status}</span>}
            <button type="button" className="btn" disabled={busy} onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={busy}>
              {busy ? "Creating…" : "Create writing structure"}
            </button>
          </div>
        </form>
      )}

      <section>
        <h2 className="label mb-3">My projects</h2>
        {projects === null && !error && <p className="text-sm text-muted">Loading…</p>}
        {projects?.length === 0 && !creating && (
          <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
            No projects yet. Create your first song or text.
          </div>
        )}
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
          {projects?.map((p) => (
            <li key={p.id}>
              <Link href={`/p/${p.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-panel-2">
                <span className="font-medium">{p.title}</span>
                <span className="text-xs text-muted">
                  {PROJECT_TYPES.find((t) => t.value === p.type)?.label} · {p.language.toUpperCase()} ·{" "}
                  {new Date(p.updated_at).toLocaleDateString()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
