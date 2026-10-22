"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { BEAT_ACCEPT, MAX_BEAT_BYTES, uploadBeat } from "@/lib/client/beat";
import { LANGUAGES, PROJECT_TYPES, type Project, type ProjectType } from "@/lib/types";

type ProjectRow = Pick<Project, "id" | "title" | "type" | "language" | "updated_at">;

/**
 * Home: your songs, and a new song in three taps — name, language, beat.
 * The song opens in the app view (/song/[id]): record the flow, get lyrics.
 */
export default function Home() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [beat, setBeat] = useState<File | null>(null);
  const [form, setForm] = useState({
    title: "",
    language: "it",
    type: "song" as ProjectType,
    concept: "",
    genre: "",
    text: "",
  });

  useEffect(() => {
    api<ProjectRow[]>("/api/projects").then(setProjects, (e: Error) => setError(e.message));
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!beat && !form.text.trim()) {
      setError("Choose your beat first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setStatus("Creating the song…");
      const p = await api<Project>("/api/projects", {
        body: {
          title: form.title.trim() || beat?.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "New song",
          type: form.type,
          language: form.language,
          concept: form.concept.trim() || null,
          settings: { genre: form.genre.trim() || undefined, simpleLanguage: true },
          text: form.text.trim() || undefined,
        },
      });
      if (beat) {
        try {
          await api(`/api/projects/${p.id}/audio`, { body: await uploadBeat(p.id, beat, setStatus) });
        } catch (err) {
          window.alert(`The song was created, but the beat: ${(err as Error).message}`);
        }
      }
      router.push(`/song/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      setStatus(null);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-4 pb-28 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight">VerseFlow</h1>
        <p className="mt-1 text-sm text-muted">Upload a beat · sing your flow · get your lyrics</p>
      </header>

      {error && !sheet && <p className="mb-4 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}

      {projects === null && !error && <p className="text-sm text-muted">Loading…</p>}
      {projects?.length === 0 && (
        <button
          className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-line px-6 py-12 text-center"
          onClick={() => setSheet(true)}
        >
          <span className="text-4xl">🎵</span>
          <span className="font-semibold">Start your first song</span>
          <span className="text-sm text-muted">Upload a beat, sing or rap over it, and get lyrics that fit your flow.</span>
        </button>
      )}
      <ul className="space-y-2.5">
        {projects?.map((p) => (
          <li key={p.id}>
            <Link href={`/song/${p.id}`} className="flex items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3.5 shadow-sm active:scale-[0.99]">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-xl">🎤</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{p.title}</span>
                <span className="text-xs text-muted">
                  {PROJECT_TYPES.find((t) => t.value === p.type)?.label} · {p.language.toUpperCase()} · {new Date(p.updated_at).toLocaleDateString()}
                </span>
              </span>
              <span className="text-muted">›</span>
            </Link>
          </li>
        ))}
      </ul>

      {/* new song */}
      <button
        className="fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-1/2 z-20 -translate-x-1/2 rounded-full bg-accent px-7 py-4 text-base font-bold text-white shadow-xl active:scale-95"
        onClick={() => setSheet(true)}
      >
        ＋ New song
      </button>

      {sheet && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={() => !busy && setSheet(false)}>
          <form
            onSubmit={create}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[92dvh] w-full max-w-lg space-y-4 overflow-auto rounded-t-3xl bg-panel px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3"
          >
            <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
            <h2 className="text-xl font-bold">New song</h2>

            <label className="flex cursor-pointer items-center gap-3 rounded-2xl border-2 border-dashed border-accent/50 bg-accent-soft/40 px-4 py-4">
              <span className="text-3xl">🎵</span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{beat ? beat.name : "Choose your beat"}</span>
                <span className="text-xs text-muted">{beat ? `${(beat.size / 1024 / 1024).toFixed(1)} MB` : "MP3 or any audio file, up to 50 MB"}</span>
              </span>
              <input
                type="file"
                accept={BEAT_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (f && f.size > MAX_BEAT_BYTES) {
                    setError("The file is larger than 50 MB.");
                    return;
                  }
                  setError(null);
                  setBeat(f);
                }}
              />
            </label>

            <div>
              <label className="label">Name</label>
              <input
                className="input text-base"
                value={form.title}
                placeholder={beat ? beat.name.replace(/\.[^.]+$/, "") : "My new song"}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Language of the lyrics</label>
              <div className="flex flex-wrap gap-1.5">
                {LANGUAGES.map((l) => (
                  <button
                    type="button"
                    key={l.value}
                    className={`rounded-full px-3.5 py-2 text-sm font-medium ${form.language === l.value ? "bg-accent text-white" : "bg-panel-2"}`}
                    onClick={() => setForm({ ...form, language: l.value })}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>

            <button type="button" className="text-sm text-muted underline" onClick={() => setMore((m) => !m)}>
              {more ? "Fewer options" : "More options"}
            </button>
            {more && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
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
                    <label className="label">Genre</label>
                    <input className="input" value={form.genre} placeholder="Italian rap" onChange={(e) => setForm({ ...form, genre: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label className="label">What is the song about? (optional)</label>
                  <textarea
                    className="input min-h-20"
                    value={form.concept}
                    placeholder="Your flow decides the topic too — add a story here if you have one."
                    onChange={(e) => setForm({ ...form, concept: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">Existing lyrics (optional)</label>
                  <textarea
                    className="input min-h-20"
                    value={form.text}
                    placeholder="Paste lyrics you already have ([Verse 1], [Chorus]…)."
                    onChange={(e) => setForm({ ...form, text: e.target.value })}
                  />
                </div>
              </div>
            )}

            {error && <p className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}
            <button className="btn-primary w-full justify-center rounded-2xl py-3.5 text-base" disabled={busy}>
              {busy ? (status ?? "Creating…") : "Create song"}
            </button>
          </form>
        </div>
      )}
    </main>
  );
}
