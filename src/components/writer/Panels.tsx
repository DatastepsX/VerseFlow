"use client";

import { useEffect, useRef, useState } from "react";
import { api, projectApi } from "@/lib/client/api";
import type { RhymeResult } from "@/lib/rhyme/types";
import { LANGUAGES, PROJECT_TYPES, type LineEvent, type ProjectSettings, type ProjectVersion } from "@/lib/types";
import { useWriter } from "./context";
import { prosody } from "@/lib/rhyme/prosody";
import { download, fullText, fullTextSections } from "./util";
import { useFollow } from "./follow";
import { NowPlaying } from "./NowPlaying";
import { usePlayer } from "./Player";

export function FullTextPanel() {
  const { tree } = useWriter();
  const [approvedOnly, setApprovedOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = fullText(tree, { approvedOnly });
  const slug = tree.project.title.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase() || "verseflow";
  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <button
          className="btn text-xs"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
        <button className="btn text-xs" onClick={() => download(`${slug}.txt`, `${tree.project.title}\n\n${text}`)}>
          .txt
        </button>
        <button className="btn text-xs" onClick={() => download(`${slug}.md`, fullText(tree, { approvedOnly, markdown: true }), "text/markdown")}>
          .md
        </button>
        <label className="ml-auto flex items-center gap-1 text-xs text-muted">
          <input type="checkbox" checked={approvedOnly} onChange={(e) => setApprovedOnly(e.target.checked)} /> approved only
        </label>
      </div>
      <FollowingText approvedOnly={approvedOnly} />
    </div>
  );
}

/** the full text with the line the song is at highlighted and kept in view */
function FollowingText({ approvedOnly }: { approvedOnly: boolean }) {
  const { tree } = useWriter();
  const p = usePlayer();
  const sections = fullTextSections(tree, { approvedOnly });
  const pos = p.position;
  const liveSection = pos ? tree.sections.find((s) => s.id === pos.sectionId) : undefined;
  const liveLine = liveSection && pos?.lineIndex !== null && pos?.lineIndex !== undefined ? liveSection.lines[pos.lineIndex] : undefined;
  const shown = new Set(sections.flatMap((x) => x.groups.flat().map((l) => l.id)));
  // the line if it is in the text, else the section heading
  const target = liveLine && shown.has(liveLine.id) ? `ft-line-${liveLine.id}` : pos ? `ft-sec-${pos.sectionId}` : null;
  const box = useRef<HTMLDivElement>(null);
  useFollow(() => (target ? (box.current?.querySelector<HTMLElement>(`#${target}`) ?? null) : null), target, p.playing);

  if (!sections.length) return <p className="text-sm text-muted">Nothing written yet.</p>;
  return (
    <div ref={box} className="flex-1 space-y-6 text-[15px] leading-relaxed">
      <NowPlaying />
      {sections.map(({ section, groups }) => (
        <div key={section.id}>
          <div id={`ft-sec-${section.id}`} className={`mb-2 text-xs font-bold uppercase tracking-widest ${pos?.sectionId === section.id ? "text-accent" : "text-muted"}`}>
            {section.name}
          </div>
          <div className="space-y-3">
            {groups.map((g, i) => (
              <div key={i}>
                {g.map((l) => (
                  <div
                    key={l.id}
                    id={`ft-line-${l.id}`}
                    className={`-mx-1 rounded px-1 transition-colors ${liveLine?.id === l.id ? "bg-accent-soft font-medium text-fg ring-1 ring-accent/40" : ""}`}
                  >
                    {l.text}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function WordList({ words, onPick }: { words: RhymeResult["perfect"]; onPick: (w: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {words.map((x) => (
        <button
          key={x.word}
          className="rounded bg-panel-2 px-1.5 py-0.5 text-sm hover:bg-accent-soft hover:text-accent"
          title="Insert into the line you are editing"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(x.word)}
        >
          {x.word}
        </button>
      ))}
    </div>
  );
}

/** Remount with key={query} when the query is set from outside. */
export function RhymePanel({ query, setQuery }: { query: string; setQuery: (q: string) => void }) {
  const w = useWriter();
  const [input, setInput] = useState(query);
  const [state, setState] = useState<{ q: string; r: RhymeResult | null } | null>(null);
  const key = `${query}|${w.lang}`;
  const loading = !!query.trim() && state?.q !== key;
  const result = state?.q === key ? state.r : null;

  useEffect(() => {
    if (!query.trim()) return;
    let cancelled = false;
    api<RhymeResult>(`/api/rhymes?q=${encodeURIComponent(query)}&lang=${w.lang}`)
      .then((r) => !cancelled && setState({ q: key, r }))
      .catch(() => !cancelled && setState({ q: key, r: null }));
    return () => {
      cancelled = true;
    };
  }, [query, w.lang, key]);

  return (
    <div className="space-y-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(input);
        }}
        className="flex gap-1.5"
      >
        <input className="input" placeholder="Word to rhyme with…" value={input} onChange={(e) => setInput(e.target.value)} />
        <button className="btn">Find</button>
      </form>
      {loading && <p className="text-xs text-muted">Searching…</p>}
      {result && !loading && (
        <>
          <p className="text-xs text-muted">
            “{result.word}” · sound -{result.rhymeKey} · tap a word to insert it into the line you&apos;re editing
          </p>
          <div>
            <h4 className="label">Rhymes</h4>
            {result.perfect.length ? <WordList words={result.perfect} onPick={w.insertWord} /> : <p className="text-xs text-muted">None found.</p>}
          </div>
          <div>
            <h4 className="label">Near rhymes / assonance</h4>
            {result.near.length ? <WordList words={result.near} onPick={w.insertWord} /> : <p className="text-xs text-muted">None found.</p>}
          </div>
          <p className="text-[10px] text-muted">Source: {result.source}</p>
        </>
      )}
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  create: "Added",
  edit: "Edited",
  approve: "Approved",
  decline: "Declined",
  unlock: "Unlocked",
  delete: "Deleted",
  select_alternative: "Chose option",
  request_options: "Asked for options",
  restore: "Restored",
  kind: "Changed type",
  note: "Note",
};

export function HistoryPanel() {
  const w = useWriter();
  const [events, setEvents] = useState<LineEvent[] | null>(null);
  const [versions, setVersions] = useState<ProjectVersion[] | null>(null);
  const [label, setLabel] = useState("");
  const pid = w.tree.project.id;
  const stamp = w.tree.project.updated_at;

  useEffect(() => {
    projectApi.history(pid).then(setEvents, () => setEvents([]));
    projectApi.versions(pid).then(setVersions, () => setVersions([]));
  }, [pid, stamp]);

  const lineText = (id: string) => {
    for (const s of w.tree.sections) for (const l of s.lines) if (l.id === id) return l.text;
    return null;
  };

  return (
    <div className="space-y-5">
      <div>
        <h4 className="label">Saved versions</h4>
        <form
          className="mb-2 flex gap-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            await w.mutate(`/api/projects/${pid}`, { action: "saveVersion", label: label || `Version ${new Date().toLocaleString()}` });
            setLabel("");
          }}
        >
          <input className="input py-1.5" placeholder="Name this version (e.g. “first full draft”)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn">Save</button>
        </form>
        <ul className="space-y-1">
          {versions?.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-panel-2">
              <span className="truncate">
                {v.label} <span className="text-xs text-muted">{new Date(v.created_at).toLocaleString()}</span>
              </span>
              <button
                className="btn-ghost text-xs"
                onClick={() => {
                  if (window.confirm(`Restore “${v.label}”? The current state is saved as a version first.`))
                    void w.mutate(`/api/versions/${v.id}`, {});
                }}
              >
                Restore
              </button>
            </li>
          ))}
          {versions?.length === 0 && <li className="text-xs text-muted">No saved versions yet.</li>}
        </ul>
      </div>
      <div>
        <h4 className="label">Line history</h4>
        <ul className="space-y-1.5">
          {events?.map((ev) => {
            const before = ev.before as { text?: string; status?: string; deleted?: boolean } | null;
            const after = ev.after as { text?: string; status?: string; deleted?: boolean } | null;
            const current = lineText(ev.line_id);
            return (
              <li key={ev.id} className={`rounded border border-line p-2 text-xs ${ev.undone ? "opacity-50" : ""}`}>
                <div className="flex justify-between text-muted">
                  <span>
                    {ACTION_LABEL[ev.action] ?? ev.action}
                    {after?.status && ev.action !== "approve" ? ` → ${after.status.toLowerCase().replace(/_/g, " ")}` : ""}
                    {ev.undone ? " (undone)" : ""}
                  </span>
                  <span>{new Date(ev.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                {before?.text !== undefined && after?.text !== undefined ? (
                  <div className="mt-1 space-y-0.5">
                    <div className="text-bad line-through">{before.text || "(empty)"}</div>
                    <div className="text-ok">{after.text}</div>
                  </div>
                ) : (
                  <div className="mt-1 truncate">{after?.text ?? current ?? "(deleted line)"}</div>
                )}
                {before && (before.text !== undefined || before.deleted === false) && !ev.undone && (
                  <button className="btn-ghost mt-1 px-1 text-[11px]" onClick={() => void w.mutate(`/api/events/${ev.id}`, { which: "before" })}>
                    ↺ Restore previous
                  </button>
                )}
              </li>
            );
          })}
          {events?.length === 0 && <li className="text-xs text-muted">No changes yet.</li>}
        </ul>
      </div>
    </div>
  );
}

export function ProjectSettingsPanel({ onClose }: { onClose: () => void }) {
  const w = useWriter();
  const p = w.tree.project;
  const [form, setForm] = useState({
    title: p.title,
    type: p.type,
    language: p.language,
    concept: p.concept ?? "",
    ...({ genre: "", style: "", mood: "", secondaryLanguage: "", explicitness: "", simpleLanguage: false } as Record<string, unknown>),
    ...p.settings,
  } as Record<string, unknown> & ProjectSettings & { title: string; type: string; language: string; concept: string });
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const { title, type, language, concept, ...settings } = form;
    await w.mutate(`/api/projects/${p.id}`, { title, type, language, concept: concept || null, settings }, "PATCH");
    onClose();
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="label">Title</label>
        <input className="input" value={form.title} onChange={(e) => set("title", e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Type</label>
          <select className="input" value={form.type} onChange={(e) => set("type", e.target.value)}>
            {PROJECT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Language</label>
          <select className="input" value={form.language} onChange={(e) => set("language", e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="label">Story / concept</label>
        <textarea className="input min-h-28" value={form.concept} onChange={(e) => set("concept", e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Genre</label>
          <input className="input" value={(form.genre as string) ?? ""} onChange={(e) => set("genre", e.target.value)} />
        </div>
        <div>
          <label className="label">Mood</label>
          <input className="input" value={(form.mood as string) ?? ""} onChange={(e) => set("mood", e.target.value)} />
        </div>
        <div>
          <label className="label">Style / references</label>
          <input className="input" value={(form.style as string) ?? ""} onChange={(e) => set("style", e.target.value)} />
        </div>
        <div>
          <label className="label">Mixed-in language</label>
          <input className="input" placeholder="e.g. English" value={(form.secondaryLanguage as string) ?? ""} onChange={(e) => set("secondaryLanguage", e.target.value)} />
        </div>
        <div>
          <label className="label">Explicit content</label>
          <select className="input" value={(form.explicitness as string) ?? ""} onChange={(e) => set("explicitness", e.target.value || undefined)}>
            <option value="">—</option>
            <option value="none">None</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
        <label className="mt-5 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!form.simpleLanguage} onChange={(e) => set("simpleLanguage", e.target.checked)} /> Simple wording
        </label>
      </div>
      <div className="flex justify-between gap-2 pt-2">
        <button
          className="btn text-xs"
          onClick={async () => {
            const copy = await api<{ id: string }>(`/api/projects/${p.id}`, { body: { action: "duplicate" } });
            window.location.href = `/p/${copy.id}`;
          }}
        >
          Duplicate project
        </button>
        <div className="flex gap-2">
          <button
            className="btn text-xs text-bad"
            onClick={async () => {
              if (!window.confirm(`Delete “${p.title}” permanently?`)) return;
              await api(`/api/projects/${p.id}`, { method: "DELETE" });
              window.location.href = "/";
            }}
          >
            Delete
          </button>
          <button className="btn-primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Every bar generated so far, from all sections — browse, search and reuse
 * them without a new AI call. Tap a bar to put it into the line you're writing.
 */
export function BarsPanel() {
  const w = useWriter();
  const p = usePlayer();
  const liveId = p.position?.sectionId ?? null;
  const box = useRef<HTMLDivElement>(null);
  // the bars of the section the song is in come into view when the section changes
  useFollow(() => (liveId ? (box.current?.querySelector<HTMLElement>(`[data-bars-section="${liveId}"]`) ?? null) : null), liveId, p.playing);
  const [q, setQ] = useState("");
  const [showUsed, setShowUsed] = useState(false);
  const needle = q.trim().toLowerCase();
  const bars = w.tree.bank.filter((b) => (showUsed || b.state === "available") && (!needle || b.text.toLowerCase().includes(needle)));
  const total = w.tree.bank.filter((b) => b.state === "available").length;

  const bySection = w.tree.sections
    .map((s) => {
      const fams = new Map<string, typeof bars>();
      for (const b of bars.filter((x) => x.section_id === s.id)) (fams.get(b.family) ?? fams.set(b.family, []).get(b.family)!).push(b);
      return { section: s, families: [...fams.entries()] };
    })
    .filter((x) => x.families.length);

  return (
    <div ref={box} className="space-y-3">
      <NowPlaying />
      <p className="text-xs text-muted">
        {total} bars generated so far — free to reuse. Tap a bar to put it into the line you are writing (tap into a line first).
      </p>
      <div className="flex items-center gap-2">
        <input className="input py-1.5" placeholder="Search bars or words…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex shrink-0 items-center gap-1 text-xs text-muted">
          <input type="checkbox" checked={showUsed} onChange={(e) => setShowUsed(e.target.checked)} /> used
        </label>
      </div>
      {bySection.length === 0 && (
        <p className="text-sm text-muted">
          {total ? "No bar matches your search." : "No bars yet — they appear here after the first “✨ … · 1 AI call” in any section."}
        </p>
      )}
      {bySection.map(({ section, families }) => (
        <div
          key={section.id}
          data-bars-section={section.id}
          className={liveId === section.id ? "-mx-2 rounded-lg bg-accent-soft/50 px-2 py-1 ring-1 ring-accent/30" : ""}
        >
          <h4 className={`label ${liveId === section.id ? "text-accent" : ""}`}>
            {liveId === section.id ? "♪ " : ""}
            {section.name}
          </h4>
          <div className="space-y-2">
            {families.map(([fam, list]) => (
              <div key={fam} className="rounded-md border border-line p-1.5">
                <div className="px-1 pb-1 text-[10px] uppercase tracking-wide text-muted">rhyme {fam.split(":").slice(2).join(":") || "—"}</div>
                {list.map((b) => (
                  <div key={b.id} className={`flex items-baseline gap-2 rounded px-1.5 py-1 hover:bg-panel-2 ${b.state === "used" ? "opacity-50" : ""}`}>
                    <button
                      className="min-w-0 flex-1 text-left text-sm leading-snug hover:text-accent"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => w.placeBar(b.text)}
                      title="Put this bar into the line you are writing"
                    >
                      {b.text}
                    </button>
                    <span className="font-mono text-[11px] text-muted">{prosody(b.text, w.lang).syllables}</span>
                    {b.state === "used" ? (
                      <span className="text-[10px] uppercase text-muted">used</span>
                    ) : (
                      <button
                        className="btn-ghost px-1 py-0 text-xs text-bad"
                        title="Not for me — never suggest again"
                        onClick={() => void w.mutate(`/api/bank/${b.id}`, { action: "reject" })}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
