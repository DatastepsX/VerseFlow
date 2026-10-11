"use client";

import { useState } from "react";
import { lastWord } from "@/lib/rhyme/analyze";
import { suggestForSlot } from "@/lib/suggest";
import type { BankLine } from "@/lib/types";
import { useWriter } from "./context";

/**
 * Suggestions for one slot (the next line, or an existing line to replace),
 * served from the section's bank without an API call. AI is only offered when
 * the bank has nothing that fits.
 */
export function BankPicker({
  sectionId,
  index,
  texts,
  groupSize,
  scheme,
  onUse,
  onEdit,
  title = "From your bank",
}: {
  sectionId: string;
  index: number;
  texts: string[];
  groupSize: number;
  scheme: string | null;
  onUse: (b: BankLine) => void;
  onEdit?: (b: BankLine) => void;
  title?: string;
}) {
  const w = useWriter();
  const [skip, setSkip] = useState(0);
  // the whole project's bank: bars generated for other sections are reused (no new API call)
  const bank = w.tree.bank;
  const sectionName = (id: string) => w.tree.sections.find((x) => x.id === id)?.name ?? "another section";
  const available = bank.filter((b) => b.state === "available").length;
  const sectionAvailable = bank.filter((b) => b.state === "available" && b.section_id === sectionId).length;
  const rhythmRef = w.tree.sections.find((x) => x.id === sectionId)?.lines.find((l) => l.kind === "rhythm_ref" && l.text.trim())?.text;
  const { suggestions, partnerText, matches, reference } = suggestForSlot({
    bank,
    texts,
    index,
    groupSize,
    scheme,
    lang: w.lang,
    count: 3,
    skip,
    rhythmRef,
    sectionId,
  });
  const filling = w.filling.has(sectionId);
  // the bank has bars, but none flows like the line before → say so and offer better ones
  const bestFit = suggestions.reduce((m, x) => Math.max(m, x.rhythm), 0);
  const poorFit = !!reference && suggestions.length > 0 && bestFit < 0.6;
  const written = texts.filter((t) => t.trim()).length;
  const fillLabel =
    partnerText && matches === 0
      ? `✨ Get bars rhyming with “${lastWord(partnerText)}”`
      : sectionAvailable === 0
        ? "✨ Write bars for this section"
        : "✨ Refill bank";

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted">
        <span className="font-semibold text-fg">{title}</span>
        {available > 0 && (
          <span className="normal-case tracking-normal">
            {matches} fitting · {available} in bank · free
          </span>
        )}
        {matches > 3 && (
          <button className="btn-ghost px-1 py-0 text-[11px] normal-case" onClick={() => setSkip((s) => s + 3)}>
            ↻ others
          </button>
        )}
      </div>

      {reference && suggestions.length > 0 && (
        <p className="text-[11px] text-muted" title={reference.text}>
          follows the flow of “{reference.text.length > 42 ? reference.text.slice(0, 40) + "…" : reference.text}”: {reference.prosody.syllables} syllables{" "}
          <span className="font-mono tracking-tight">
            {reference.prosody.pattern
              .split("-")
              .map((x) => (x === "TA" ? "●" : "·"))
              .join("")}
          </span>
        </p>
      )}

      {suggestions.map((s) => (
        <div key={s.line.id} className="group/b flex items-baseline gap-2 rounded-md border border-line bg-panel-2 px-2.5 py-2 hover:border-accent">
          <button className="min-w-0 flex-1 text-left text-[16px] leading-snug hover:text-accent" onClick={() => onUse(s.line)} title="Use this bar">
            {s.line.text}
            {s.line.section_id !== sectionId && (
              <span className="ml-1.5 align-middle text-[10px] uppercase tracking-wide text-muted">from {sectionName(s.line.section_id)}</span>
            )}
          </button>
          <span
            className={`text-[11px] ${s.quality === "perfect" ? "text-ok" : s.quality === "assonance" ? "text-warn" : "text-muted"}`}
            title={s.quality === "opener" ? "starts a new rhyme — partners are in the bank" : s.quality}
          >
            {s.quality === "perfect" ? "●" : s.quality === "assonance" ? "◐" : "○"}
          </span>
          <span
            className={`rounded px-1 font-mono text-[11px] ${!reference ? "text-muted" : Math.abs(s.sylDiff) <= 1 && s.rhythm >= 0.75 ? "bg-ok-soft text-ok" : Math.abs(s.sylDiff) <= 2 ? "bg-warn-soft text-warn" : "bg-bad-soft text-bad"}`}
            title={reference ? `${s.syllables} syllables (${s.sylDiff >= 0 ? "+" : ""}${s.sylDiff} vs. the line before) · rhythm match ${Math.round(s.rhythm * 100)}%` : `${s.syllables} syllables`}
          >
            {s.syllables}
            {reference ? ` · ${Math.round(s.rhythm * 100)}%` : ""}
          </span>
          <span className="flex shrink-0 gap-0.5">
            <button className="btn-ghost px-1 py-0 text-xs text-ok" title="Use" onClick={() => onUse(s.line)}>
              ✓
            </button>
            {onEdit && (
              <button className="btn-ghost px-1 py-0 text-xs" title="Edit before using" onClick={() => onEdit(s.line)}>
                ✎
              </button>
            )}
            <button
              className="btn-ghost px-1 py-0 text-xs text-bad"
              title="Not for me — never suggest again"
              onClick={() => void w.mutate(`/api/bank/${s.line.id}`, { action: "reject" })}
            >
              ✕
            </button>
          </span>
        </div>
      ))}

      {!w.aiEnabled && available === 0 && (
        <p className="rounded-md bg-warn-soft px-2.5 py-2 text-xs text-warn">
          Bar options are written by Claude. Add <code>ANTHROPIC_API_KEY</code> in Vercel → verseflow → Settings → Environment Variables
          and redeploy — after that, options appear here automatically once a section has two lines.
        </p>
      )}

      {filling && (
        <p className="animate-pulse rounded-md bg-accent-soft px-2.5 py-2 text-sm text-accent">
          ✨ Writing ~40 bars that fit your lines (1 AI call)…
        </p>
      )}

      {w.aiEnabled && !filling && available === 0 && written < 2 && (
        <p className="text-xs text-muted">Write a second line (or start now) — then options for the next bars appear here.</p>
      )}

      {available > 0 && suggestions.length === 0 && (
        <p className="text-xs text-muted">
          {partnerText ? `Nothing in the bank rhymes with “${lastWord(partnerText)}” yet.` : "No fitting bars left in the bank."}
        </p>
      )}

      {poorFit && (
        <p className="rounded-md bg-warn-soft px-2.5 py-1.5 text-xs text-warn">
          These bars don&apos;t flow like the line before ({reference!.prosody.syllables} syllables) — get bars written for it below, or adjust one with − / +.
        </p>
      )}

      {w.aiEnabled && !filling && (suggestions.length < 3 || available < 6 || poorFit) && (
        <button
          className="btn px-2 py-1 text-xs"
          disabled={filling}
          onClick={() => void w.fillBank(sectionId, partnerText && (matches === 0 || poorFit) ? [partnerText] : [])}
          title="One AI call writes ~30–40 bars for this section; afterwards suggestions are free"
        >
          {available === 0
            ? "✨ Show options now"
            : poorFit
              ? `✨ Get ${reference!.prosody.syllables}-syllable bars${partnerText ? ` rhyming with “${lastWord(partnerText)}”` : ""}`
              : fillLabel}{" "}
          · 1 AI call
        </button>
      )}
    </div>
  );
}
