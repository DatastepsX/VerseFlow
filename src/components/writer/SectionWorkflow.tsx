"use client";

import { useState } from "react";
import { sectionLineTarget } from "@/lib/audio/song-map";
import { sectionPattern } from "@/lib/pattern";
import { prosody } from "@/lib/rhyme/prosody";
import type { ProjectTree } from "@/lib/types";
import { useWriter } from "./context";

/** bars the server drafts per call (DRAFT_CHUNK in src/lib/server/ai.ts) — used for the call count label */
const DRAFT_CHUNK = 8;

type SectionT = ProjectTree["sections"][number];

const dots = (pattern: string) =>
  pattern
    .split("-")
    .map((x) => (x === "TA" ? "●" : "·"))
    .join("");

/**
 * The section's working panel: its pattern (rhythm only, not lyrics) and the
 * draft workflow — fill the section in one call, keep ✓ / mark ✕ bars,
 * replace the marked ones in one call, then polish.
 */
export function SectionWorkflow({ section }: { section: SectionT }) {
  const w = useWriter();
  const pattern = sectionPattern(section);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<null | "fill" | "replace" | "polish" | "keep">(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const lyric = section.lines.filter((l) => l.kind === "lyric");
  const target = sectionLineTarget({ ...section, lines: lyric }, w.tree.sections, w.tree.audio);
  const kept = lyric.filter((l) => (l.status === "APPROVED" || l.status === "APPROVED_EDITED") && l.text.trim()).length;
  const review = lyric.filter((l) => l.status === "SUGGESTED" && l.text.trim()).length;
  const replace = lyric.filter((l) => l.status === "DECLINED" || l.status === "NEEDS_NEW_OPTIONS").length;
  const open = Math.max(0, target - lyric.filter((l) => l.text.trim()).length);
  // the writer's (or imported) lines that can still be improved
  const polishable = lyric.filter(
    (l) => l.text.trim() && l.status !== "APPROVED" && l.status !== "APPROVED_EDITED" && l.status !== "DECLINED",
  ).length;
  const others = w.tree.sections.filter((s) => s.id !== section.id && sectionPattern(s).length);

  const run = async (action: "fill" | "replace" | "polish" | "keepAll") => {
    setBusy(action === "keepAll" ? "keep" : action);
    if (action === "keepAll") await w.mutate(`/api/sections/${section.id}`, { action });
    else {
      // the server splits the section into chunks of ~8 bars; all chunks are drafted at the same time
      // (one call each) and each chunk's drafts show up as soon as it is done
      const plan = await w.mutate(`/api/sections/${section.id}`, { action: "draftPlan", mode: action });
      let parts: number[][] = [];
      try {
        parts = JSON.parse(plan?.headers.get("x-parts") ?? "[]");
      } catch {}
      const total = parts.reduce((n, p) => n + p.length, 0) || (action === "polish" ? polishable : 0);
      let done = 0;
      setProgress({ done, total });
      await Promise.all(
        parts.map(async (indices) => {
          const res = await w.mutate(`/api/sections/${section.id}`, { action, indices });
          if (res) setProgress({ done: (done += indices.length), total });
        }),
      );
      // responses can arrive out of order: reload once so the newest state wins
      if (parts.length > 1) await w.mutate(`/api/projects/${w.tree.project.id}`, undefined, "GET");
      setProgress(null);
    }
    setBusy(null);
  };
  const calls = (n: number) => Math.ceil(n / DRAFT_CHUNK);
  const callLabel = (n: number) => (calls(n) === 1 ? "1 call" : `${calls(n)} calls`);
  const working = progress ? ` ${progress.done}/${progress.total}…` : "…";
  const savePattern = async (text: string) => {
    await w.mutate(`/api/sections/${section.id}`, { pattern: text.trim() || null }, "PATCH");
    setEditing(false);
  };

  return (
    <div className="mb-3 space-y-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm">
      {/* pattern */}
      {editing ? (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Pattern for {section.name}</div>
          <p className="text-xs text-muted">
            1–2 lines that set the rhythm: length, syllables and stresses. The words don&apos;t matter and won&apos;t appear in the lyrics — sing
            along with the beat and type what fits (even “la la la” style).
          </p>
          <textarea
            className="input min-h-16 font-mono text-sm"
            autoFocus
            value={draft}
            placeholder={"e mentre ti guardo stasera ci sono\ncerco la strada con te non ritorno"}
            onChange={(e) => setDraft(e.target.value)}
          />
          {draft
            .split("\n")
            .filter((l) => l.trim())
            .map((l, i) => {
              const p = prosody(l, w.lang);
              return (
                <div key={i} className="font-mono text-[11px] text-muted">
                  line {i + 1}: {p.syllables} syllables {dots(p.pattern)}
                </div>
              );
            })}
          {others.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-xs">
              <span className="text-muted">copy from:</span>
              {others.map((s) => (
                <button key={s.id} className="btn px-2 py-0.5 text-xs" onClick={() => setDraft(sectionPattern(s).join("\n"))}>
                  {s.name}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-1.5">
            <button className="btn-primary px-3 py-1 text-xs" onClick={() => void savePattern(draft)}>
              Save pattern
            </button>
            <button className="btn px-3 py-1 text-xs" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : pattern.length ? (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Pattern</div>
            {pattern.map((l, i) => {
              const p = prosody(l, w.lang);
              return (
                <div key={i} className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate italic text-muted">{l}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted">
                    {p.syllables} {dots(p.pattern)}
                  </span>
                </div>
              );
            })}
          </div>
          <button
            className="btn-ghost px-1.5 text-xs"
            onClick={() => {
              setDraft(pattern.join("\n"));
              setEditing(true);
            }}
          >
            ✎
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted">No pattern yet — set the rhythm for this section to get suggestions that fit.</span>
          <button
            className="btn px-2 py-1 text-xs"
            onClick={() => {
              setDraft("");
              setEditing(true);
            }}
          >
            ♩ Set pattern
          </button>
        </div>
      )}

      {/* draft workflow */}
      {!editing && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2 text-xs">
          <span className="mr-1 text-muted">
            {target} bars · <span className="text-ok">✓ {kept}</span> · <span className="text-accent">draft {review}</span> ·{" "}
            <span className="text-bad">✕ {replace}</span>
            {open ? ` · ${open} open` : ""}
          </span>
          {w.aiEnabled && open > 0 && (
            <button
              className={pattern.length ? "btn-primary px-2 py-1 text-xs" : "btn px-2 py-1 text-xs"}
              disabled={!!busy}
              onClick={() => void run("fill")}
              title="Writes every open bar with 3 options each, following the pattern and the rhyme scheme"
            >
              {busy === "fill" ? `Writing bars${working}` : `✨ Fill ${open} bars · ${callLabel(open)}`}
            </button>
          )}
          {w.aiEnabled && replace > 0 && (
            <button className="btn-primary px-2 py-1 text-xs" disabled={!!busy} onClick={() => void run("replace")} title="New options only for the bars marked ✕, fitting the bars you keep">
              {busy === "replace" ? `Rewriting${working}` : `↻ Replace ${replace} marked · ${callLabel(replace)}`}
            </button>
          )}
          {w.aiEnabled && polishable > 0 && (
            <button
              className="btn px-2 py-1 text-xs"
              disabled={!!busy}
              onClick={() => void run("polish")}
              title="3 improved versions of every line you haven't approved yet — your text stays, the versions appear under ↻ on each line"
            >
              {busy === "polish" ? `Polishing${working}` : `✨ Polish ${polishable} lines · ${callLabel(polishable)}`}
            </button>
          )}
          {review > 0 && (
            <button className="btn px-2 py-1 text-xs" disabled={!!busy} onClick={() => void run("keepAll")}>
              ✓ Keep all {review} drafts
            </button>
          )}
          {!w.aiEnabled && <span className="text-warn">AI is off (no API key)</span>}
        </div>
      )}
    </div>
  );
}
