"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PROJECT_TYPES, type ProjectTree } from "@/lib/types";
import { WriterContext, type GenerateOptions, type WriterApi } from "./context";
import { BarsPanel, FullTextPanel, HistoryPanel, ProjectSettingsPanel, RhymePanel } from "./Panels";
import { PlayerProvider, UploadBeatButton } from "./Player";
import { PatternBar } from "./PatternBar";
import { SectionBlock } from "./SectionBlock";
import { SectionNav } from "./SectionNav";
import { songPattern } from "@/lib/pattern";

type Tab = "full" | "bars" | "rhymes" | "history" | "settings";
type MobileView = "write" | Tab;

export function Writer({ initial, aiEnabled }: { initial: ProjectTree; aiEnabled: boolean }) {
  const [tree, setTree] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<Tab>("full");
  const [mobile, setMobile] = useState<MobileView>("write");
  const [rhymeQuery, setRhymeQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const insertRef = useRef<((text: string, mode?: "append" | "replace") => void) | null>(null);
  const pid = tree.project.id;

  const showError = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 5000);
  }, []);

  const mutate = useCallback(
    async (path: string, body?: unknown, method?: string) => {
      setPending((n) => n + 1);
      try {
        const res = await fetch(path, {
          method: method ?? "POST",
          headers: body !== undefined ? { "content-type": "application/json" } : undefined,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (res.status === 401) {
          window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
          return null;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showError((data as { error?: string }).error ?? "Something went wrong");
          return null;
        }
        if ((data as ProjectTree).project && (data as ProjectTree).sections) setTree(data as ProjectTree);
        return res;
      } catch {
        showError("Network error — your last change may not be saved.");
        return null;
      } finally {
        setPending((n) => n - 1);
      }
    },
    [showError],
  );

  const generate = useCallback(
    async (lineId: string, opts: GenerateOptions = {}) => {
      setGenerating((s) => new Set(s).add(lineId));
      await mutate(`/api/lines/${lineId}`, { action: "generate", projectId: pid, count: 3, ...opts });
      setGenerating((s) => {
        const n = new Set(s);
        n.delete(lineId);
        return n;
      });
    },
    [mutate, pid],
  );

  const [filling, setFilling] = useState<Set<string>>(new Set());
  const fillBank = useCallback(
    async (sectionId: string, targets: string[] = []) => {
      setFilling((s) => new Set(s).add(sectionId));
      await mutate(`/api/sections/${sectionId}`, { action: "fillBank", targets });
      setFilling((s) => {
        const n = new Set(s);
        n.delete(sectionId);
        return n;
      });
    },
    [mutate],
  );

  // one call for the whole song once the pattern (first two lines) exists — automatically, once
  const [songFilling, setSongFilling] = useState(false);
  const fillSong = useCallback(async () => {
    setSongFilling(true);
    await mutate(`/api/projects/${pid}`, { action: "fillSongBank" });
    setSongFilling(false);
  }, [mutate, pid]);
  const pattern = songPattern(tree);
  const songAuto = useRef(false);
  const hasSongBank = !!tree.project.settings?.songBankAt;
  useEffect(() => {
    if (!aiEnabled || !pattern || hasSongBank || songAuto.current) return;
    songAuto.current = true;
    void fillSong();
  }, [aiEnabled, pattern, hasSongBank, fillSong]);

  // fill a section's bank automatically once its first lines set rhythm and length — at most once per section per visit
  const autoFilled = useRef(new Set<string>());
  const autoFillBank = useCallback(
    (sectionId: string) => {
      if (!aiEnabled || autoFilled.current.has(sectionId)) return;
      autoFilled.current.add(sectionId);
      void fillBank(sectionId);
    },
    [aiEnabled, fillBank],
  );

  const lookupRhyme = useCallback((text: string) => {
    setRhymeQuery(text);
    setTab("rhymes");
    setMobile("rhymes");
  }, []);

  const api: WriterApi = useMemo(
    () => ({
      tree,
      lang: tree.project.language,
      mutate,
      selectedId,
      select: setSelectedId,
      generating,
      generate,
      setInsertTarget: (fn) => (insertRef.current = fn),
      insertWord: (word) => {
        if (insertRef.current) {
          insertRef.current(word);
          setMobile("write");
        } else {
          void navigator.clipboard?.writeText(word);
          showError(`“${word}” copied — click into a line first to insert directly.`);
        }
      },
      placeBar: (text) => {
        if (insertRef.current) {
          insertRef.current(text, "replace");
          setMobile("write");
        } else {
          void navigator.clipboard?.writeText(text);
          showError("Bar copied — tap into the line you are writing to place it directly.");
        }
      },
      lookupRhyme,
      filling,
      fillBank,
      autoFillBank,
      songFilling,
      fillSong,
      aiEnabled,
    }),
    [tree, mutate, selectedId, generating, generate, lookupRhyme, filling, fillBank, autoFillBank, songFilling, fillSong, aiEnabled, showError],
  );

  useEffect(() => {
    document.title = `${tree.project.title} · VerseFlow`;
  }, [tree.project.title]);

  // keyboard: undo / redo outside of text fields, Esc to deselect
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
      if (e.key === "Escape" && !typing) setSelectedId(null);
      if (typing || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      void mutate(`/api/projects/${pid}`, { action: e.shiftKey ? "redo" : "undo" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mutate, pid]);

  const addSectionButton = (
    <button
      className="btn-ghost mt-2 text-xs"
      onClick={() => {
        const name = window.prompt("Section name (e.g. Bridge, Hook, Outro):");
        if (name?.trim()) {
          const g = tree.project.type === "song" || tree.project.type === "rap" ? 2 : tree.project.type === "poem" ? 4 : 1;
          void mutate(`/api/projects/${pid}`, { action: "addSection", name, group_size: g });
        }
      }}
    >
      + Add section
    </button>
  );

  const typeLabel = PROJECT_TYPES.find((t) => t.value === tree.project.type)?.label;
  const totalLines = tree.sections.reduce((n, s) => n + s.lines.length, 0);
  const approved = tree.sections.reduce((n, s) => n + s.lines.filter((l) => l.status === "APPROVED" || l.status === "APPROVED_EDITED").length, 0);

  const panel = (t: Tab) =>
    t === "full" ? (
      <FullTextPanel />
    ) : t === "bars" ? (
      <BarsPanel />
    ) : t === "rhymes" ? (
      <RhymePanel key={rhymeQuery} query={rhymeQuery} setQuery={setRhymeQuery} />
    ) : t === "history" ? (
      <HistoryPanel />
    ) : (
      <ProjectSettingsPanel onClose={() => (setTab("full"), setMobile("write"))} />
    );

  return (
    <WriterContext.Provider value={api}>
      <PlayerProvider>
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-bg/90 px-3 py-2 backdrop-blur sm:px-4">
          <Link href="/" className="btn-ghost" title="All projects">
            ←
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold leading-tight">{tree.project.title}</h1>
            <p className="truncate text-xs text-muted">
              {typeLabel} · {tree.project.language.toUpperCase()} · {approved}/{totalLines} approved
              {aiEnabled ? ` · AI: ${tree.usage.calls} call${tree.usage.calls === 1 ? "" : "s"}${tree.usage.calls ? `, ${Math.round((tree.usage.input_tokens + tree.usage.output_tokens) / 100) / 10}k tokens` : ""}` : ""}
              {pending > 0 ? " · saving…" : ""}
            </p>
          </div>
          <button className="btn-ghost" title="Undo (Ctrl/Cmd+Z)" onClick={() => void mutate(`/api/projects/${pid}`, { action: "undo" })}>
            ↶
          </button>
          <button className="btn-ghost" title="Redo (Ctrl/Cmd+Shift+Z)" onClick={() => void mutate(`/api/projects/${pid}`, { action: "redo" })}>
            ↷
          </button>
          <button className="btn-ghost hidden lg:inline-flex" onClick={() => setTab("settings")}>
            Settings
          </button>
          <UploadBeatButton />
          <Link href={`/p/${pid}/record`} className="btn">
            🎙 Record
          </Link>
        </header>
        <SectionNav />

        {!aiEnabled && (
          <div className="border-b border-line bg-warn-soft px-4 py-1.5 text-center text-xs text-warn">
            AI suggestions are off until an Anthropic API key is configured. Writing, rhymes and history work already.
          </div>
        )}

        <div className="flex flex-1">
          {/* section navigation (desktop) */}
          <nav className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-44 shrink-0 flex-col gap-0.5 overflow-auto border-r border-line p-3 lg:flex">
            <span className="label">Structure</span>
            {tree.sections.map((s) => (
              <a key={s.id} href={`#section-${s.id}`} className="truncate rounded px-2 py-1 text-sm hover:bg-panel-2">
                {s.name} <span className="text-xs text-muted">{s.lines.length}</span>
              </a>
            ))}
            {addSectionButton}
          </nav>

          {/* main writing area */}
          <main
            className={`min-w-0 flex-1 px-2 pt-4 sm:px-6 pb-28 lg:pb-12 ${mobile === "write" ? "" : "hidden lg:block"}`}
            onClick={(e) => e.target === e.currentTarget && setSelectedId(null)}
          >
            <div className="mx-auto max-w-2xl space-y-8">
              {tree.project.concept && (
                <details className="rounded-lg border border-line bg-panel px-3 py-2 text-sm">
                  <summary className="cursor-pointer text-muted">Story / concept</summary>
                  <p className="mt-2 whitespace-pre-wrap">{tree.project.concept}</p>
                </details>
              )}
              <PatternBar />
              {tree.sections.map((s, i) => (
                <SectionBlock key={s.id} section={s} index={i} total={tree.sections.length} />
              ))}
              <div className="lg:hidden">
                {addSectionButton}
              </div>
            </div>
          </main>

          {/* side panel (desktop) */}
          <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-[380px] shrink-0 flex-col border-l border-line bg-panel lg:flex">
            <div className="flex border-b border-line text-sm">
              {(["full", "bars", "rhymes", "history"] as Tab[]).map((t) => (
                <button
                  key={t}
                  className={`flex-1 py-2 ${tab === t ? "border-b-2 border-accent font-semibold" : "text-muted hover:text-fg"}`}
                  onClick={() => setTab(t)}
                >
                  {t === "full" ? "Full version" : t === "bars" ? "Bars" : t === "rhymes" ? "Rhymes" : "History"}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-auto p-4">{panel(tab)}</div>
          </aside>

          {/* mobile panels */}
          {mobile !== "write" && <div className="flex-1 overflow-auto bg-panel p-4 pb-28 lg:hidden">{panel(mobile)}</div>}
        </div>

        {/* mobile bottom bar */}
        <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] text-xs lg:hidden">
          {(
            [
              ["write", "✎", "Write"],
              ["full", "≡", "Full text"],
              ["bars", "✦", "Bars"],
              ["rhymes", "♪", "Rhymes"],
              ["history", "↺", "History"],
              ["settings", "⚙", "Settings"],
            ] as [MobileView, string, string][]
          ).map(([v, icon, label]) => (
            <button key={v} className={`flex flex-1 flex-col items-center py-2 ${mobile === v ? "text-accent" : "text-muted"}`} onClick={() => setMobile(v)}>
              <span className="text-base leading-none">{icon}</span>
              {label}
            </button>
          ))}
        </nav>

        {tab === "settings" && (
          <div className="fixed inset-0 z-40 hidden items-start justify-center bg-black/40 p-8 lg:flex" onClick={() => setTab("full")}>
            <div className="w-full max-w-lg rounded-xl border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
              <h2 className="mb-3 font-semibold">Project settings</h2>
              <ProjectSettingsPanel onClose={() => setTab("full")} />
            </div>
          </div>
        )}

        {toast && (
          <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-md bg-fg px-3 py-2 text-sm text-bg shadow-lg lg:bottom-6">
            {toast}
          </div>
        )}
      </div>
      </PlayerProvider>
    </WriterContext.Provider>
  );

}
