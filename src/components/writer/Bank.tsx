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
  const bank = w.tree.bank.filter((b) => b.section_id === sectionId);
  const available = bank.filter((b) => b.state === "available").length;
  const { suggestions, partnerText, matches } = suggestForSlot({
    bank,
    texts,
    index,
    groupSize,
    scheme,
    lang: w.lang,
    count: 3,
    skip,
  });
  const filling = w.filling.has(sectionId);
  const fillLabel = partnerText && matches === 0 ? `✨ Get bars rhyming with “${lastWord(partnerText)}”` : available ? "✨ Refill bank" : "✨ Fill suggestion bank";

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted">
        <span>{title}</span>
        <span className="normal-case tracking-normal">
          {available ? `${matches} fitting · ${available} in bank · free` : "bank is empty"}
        </span>
        {matches > 3 && (
          <button className="btn-ghost px-1 py-0 text-[11px] normal-case" onClick={() => setSkip((s) => s + 3)}>
            ↻ others
          </button>
        )}
      </div>

      {suggestions.map((s) => (
        <div key={s.line.id} className="group/b flex items-baseline gap-2 rounded-md bg-panel-2 px-2 py-1.5">
          <button className="min-w-0 flex-1 text-left text-[15px] leading-snug hover:text-accent" onClick={() => onUse(s.line)} title="Use this bar">
            {s.line.text}
          </button>
          <span
            className={`text-[11px] ${s.quality === "perfect" ? "text-ok" : s.quality === "assonance" ? "text-warn" : "text-muted"}`}
            title={s.quality === "opener" ? "starts a new rhyme — partners are in the bank" : s.quality}
          >
            {s.quality === "perfect" ? "●" : s.quality === "assonance" ? "◐" : "○"}
          </span>
          <span className="font-mono text-[11px] text-muted">{s.syllables}</span>
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

      {available > 0 && suggestions.length === 0 && (
        <p className="text-xs text-muted">
          {partnerText ? `Nothing in the bank rhymes with “${lastWord(partnerText)}” yet.` : "No fitting bars left in the bank."}
        </p>
      )}

      {w.aiEnabled && (suggestions.length < 3 || available < 6) && (
        <button
          className="btn px-2 py-1 text-xs"
          disabled={filling}
          onClick={() => void w.fillBank(sectionId, partnerText && matches === 0 ? [partnerText] : [])}
          title="One AI call writes ~30–40 bars for this section; afterwards suggestions are free"
        >
          {filling ? "Writing bars… (1 AI call)" : `${fillLabel} · 1 AI call`}
        </button>
      )}
    </div>
  );
}
