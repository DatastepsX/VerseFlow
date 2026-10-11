"use client";

import { songPattern } from "@/lib/pattern";
import { prosody } from "@/lib/rhyme/prosody";
import { useWriter } from "./context";

const dots = (pattern: string) =>
  pattern
    .split("-")
    .map((x) => (x === "TA" ? "●" : "·"))
    .join("");

/**
 * The song's pattern (first lines) and the state of the whole-song suggestions:
 * write the pattern → one call prepares couplets for every section → pick bars.
 */
export function PatternBar() {
  const w = useWriter();
  const pattern = songPattern(w.tree);
  const st = w.tree.project.settings ?? {};
  const ready = w.tree.bank.filter((b) => b.state === "available").length;
  const sectionsWithBars = new Set(w.tree.bank.filter((b) => b.state === "available").map((b) => b.section_id)).size;
  const changed = !!pattern && !!st.songBankPattern && st.songBankPattern.join("\n") !== pattern.lines.join("\n");

  if (!pattern) {
    return (
      <div className="rounded-lg border border-dashed border-accent/50 bg-accent-soft/40 px-3 py-2.5 text-sm">
        <strong>Start with your pattern:</strong> write the first two lines of the song. Their length, syllables and flow become the
        pattern — then suggestions for the whole song are prepared in one go and you just pick the bars you like.
      </div>
    );
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-line bg-panel px-3 py-2.5 text-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Pattern of the song</div>
      {pattern.lines.map((l, i) => {
        const p = prosody(l, w.lang);
        return (
          <div key={i} className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate">{l}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted" title="syllables and stresses">
              {p.syllables} {dots(p.pattern)}
            </span>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
        {w.songFilling ? (
          <span className="animate-pulse text-accent">✨ Preparing couplets for the whole song (1 AI call, ~30–60 s)…</span>
        ) : st.songBankAt ? (
          <span className="text-muted">
            {ready} bars ready in {sectionsWithBars} section{sectionsWithBars === 1 ? "" : "s"} — pick them under each line, or in the Bars tab.
          </span>
        ) : !w.aiEnabled ? (
          <span className="text-warn">Add ANTHROPIC_API_KEY in Vercel to prepare suggestions.</span>
        ) : null}
        {w.aiEnabled && !w.songFilling && (st.songBankAt || changed) && (
          <button className={changed ? "btn-primary px-2 py-1 text-xs" : "btn px-2 py-1 text-xs"} onClick={() => void w.fillSong()}>
            {changed ? "Pattern changed — ✨ new suggestions for the song" : "✨ More suggestions for the whole song"} · 1 call
          </button>
        )}
      </div>
    </div>
  );
}
