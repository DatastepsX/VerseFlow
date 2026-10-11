"use client";

import { useRef, useState } from "react";
import { analyzeLine, compareLines, lastWord, rhymeScheme } from "@/lib/rhyme/analyze";
import { rhymePartners } from "@/lib/scheme";
import { prosody } from "@/lib/rhyme/prosody";
import { patternReference } from "@/lib/pattern";
import { rhythmReference } from "@/lib/suggest";
import type { ProjectTree } from "@/lib/types";
import { useWriter } from "./context";
import { sectionRanges, fmtTime } from "@/lib/audio/song-map";
import { BankPicker } from "./Bank";
import { SectionWorkflow } from "./SectionWorkflow";
import { LengthControls } from "./LengthControls";
import { usePlayer } from "./Player";
import { useFollow } from "./follow";
import { LineRow, RhymeBadge } from "./LineRow";

type SectionT = ProjectTree["sections"][number];

export function SectionBlock({ section, index, total }: { section: SectionT; index: number; total: number }) {
  const w = useWriter();
  const player = usePlayer();
  const [settings, setSettings] = useState(false);
  const g = Math.max(1, section.group_size);
  const range = sectionRanges(w.tree.sections, w.tree.audio).get(section.id) ?? null;
  const liveLine = player.position?.sectionId === section.id ? player.position.lineIndex : null;
  const lines = section.lines;
  const isRap = w.tree.project.type === "rap";

  // rhyme letters from what is actually written; partners from the intended scheme
  const texts = lines.map((l) => (l.kind === "lyric" && l.status !== "DECLINED" ? l.text : ""));
  const scheme = rhymeScheme(texts, w.lang, Math.max(4, g));
  const partners = rhymePartners(texts, g, section.rhyme_scheme);

  const sylRef = lines.filter((l) => l.kind === "rhythm_ref" && l.text.trim());
  const sylFrom = sylRef.length ? sylRef : lines.filter((l) => l.kind === "lyric" && l.text.trim() && l.status !== "DECLINED");
  const targetSyl = sylFrom.length
    ? Math.round(sylFrom.reduce((n, l) => n + analyzeLine(l.text, w.lang).syllables, 0) / sylFrom.length)
    : null;

  const groups: number[][] = [];
  for (let i = 0; i < lines.length; i += g) groups.push(lines.slice(i, i + g).map((_, k) => i + k));

  // line numbers continue across sections
  const offset = w.tree.sections.slice(0, index).reduce((n, s) => n + s.lines.length, 0);

  return (
    <section id={`section-${section.id}`} className="scroll-mt-28 lg:scroll-mt-20">
      <div className="mb-2 flex items-center gap-2">
        <input
          className="min-w-0 flex-1 bg-transparent text-sm font-bold uppercase tracking-widest outline-none focus:text-accent"
          defaultValue={section.name}
          key={section.name}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== section.name) void w.mutate(`/api/sections/${section.id}`, { name }, "PATCH");
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        {section.story_beat && <span className="hidden truncate text-xs text-muted sm:inline">{section.story_beat}</span>}
        {section.intensity ? <span className="text-xs text-muted">⚡{section.intensity}</span> : null}
        {w.tree.audio && range && (
          <span className="flex items-center gap-1 text-xs text-muted">
            <button className="btn-ghost px-1.5 py-0.5 text-xs" disabled={!player.ready} onClick={() => player.playSection(section.id)} title="Play from this section">
              ▶ {fmtTime(range.start)}
            </button>
            {range.bars !== null && (
              <span title={`${lines.length} lines written · ${Math.ceil(range.bars / (section.bars_per_line || 1))} lines fit the beat`}>
                {range.bars} bars
              </span>
            )}
            <button
              className={`btn-ghost px-1.5 py-0.5 text-xs ${player.loopId === section.id ? "text-accent" : ""}`}
              onClick={() => {
                player.setLoop(player.loopId === section.id ? null : section.id);
                if (player.loopId !== section.id && !player.playing) player.playSection(section.id);
              }}
              title="Loop this section while you write"
            >
              🔁
            </button>
          </span>
        )}
        {w.tree.audio && !range && (
          <button
            className="btn-ghost text-xs"
            disabled={!player.ready}
            onClick={() => void w.mutate(`/api/sections/${section.id}`, { audio_start: player.snappedNow() }, "PATCH")}
            title="Anchor this section at the current position of the beat"
          >
            ⚓ starts here
          </button>
        )}
        <button className="btn-ghost text-xs" onClick={() => setSettings((s) => !s)}>
          {settings ? "Done" : "⚙"}
        </button>
      </div>

      {settings && <SectionSettings section={section} index={index} total={total} />}

      <SectionWorkflow section={section} />

      <div className="space-y-3">
        {groups.map((idxs, gi) => (
          <div key={gi} className={g > 1 ? "space-y-0.5" : ""}>
            {idxs.map((k) => {
              const p = partners[k].partner;
              return (
                <LineRow
                  key={lines[k].id}
                  line={lines[k]}
                  number={offset + k + 1}
                  letter={scheme[k]?.letter ?? null}
                  partnerText={p !== null ? texts[p] || null : null}
                  partnerNumber={p !== null ? offset + p + 1 : null}
                  targetSyllables={targetSyl}
                  groupSize={g}
                  isRap={isRap}
                  sectionTexts={texts}
                  index={k}
                  scheme={section.rhyme_scheme}
                  live={liveLine === k}
                />
              );
            })}
          </div>
        ))}
      </div>

      <Composer section={section} texts={texts} offset={offset} live={liveLine !== null && liveLine >= lines.length} />
    </section>
  );
}

function Composer({
  section,
  texts,
  offset,
  live,
}: {
  section: SectionT;
  texts: string[];
  offset: number;
  live: boolean;
}) {
  const w = useWriter();
  const player = usePlayer();
  const boxRef = useRef<HTMLDivElement>(null);
  useFollow(() => boxRef.current, live ? `next-${section.id}` : null, player.playing);
  const [text, setText] = useState("");
  const [bankId, setBankId] = useState<string | null>(null);
  // "fit my line" results: bank lines created by the last fit call
  const [fitBefore, setFitBefore] = useState<Set<string> | null>(null);
  const [fitting, setFitting] = useState(false);
  const [asDraft, setAsDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const g = Math.max(1, section.group_size);
  const nextIdx = texts.length;
  const partners = rhymePartners([...texts, text], g, section.rhyme_scheme);
  const p = partners[nextIdx].partner;
  const partnerText = p !== null && p < nextIdx ? texts[p] : "";
  const pa = partnerText.trim() ? analyzeLine(partnerText, w.lang) : null;
  const a = text.trim() ? analyzeLine(text, w.lang) : null;
  const match = a && pa ? compareLines(a, pa) : null;
  const startsGroup = nextIdx % g === 0 && g > 1;
  const written = texts.filter((t) => t.trim()).length;
  const rhythmRefLine = patternReference(section);
  const refText = rhythmReference(texts, nextIdx, rhythmRefLine);
  const refProsody = refText ? prosody(refText, w.lang) : null;
  const fitted = fitBefore
    ? w.tree.bank.filter((b) => b.section_id === section.id && b.state === "available" && b.family.endsWith(":fit") && !fitBefore.has(b.id))
    : [];
  const sylGap = text.trim() && refProsody ? prosody(text, w.lang).syllables - refProsody.syllables : 0;
  const fitText = async () => {
    if (!refText) return;
    setFitting(true);
    setFitBefore(new Set(w.tree.bank.map((b) => b.id)));
    await w.mutate(`/api/sections/${section.id}`, { action: "fitText", text: text.trim(), reference: refText });
    setFitting(false);
  };

  const addCouplet = async (first: { text: string; id: string }, second: { text: string; id: string }) => {
    if (busy) return;
    setBusy(true);
    const st = asDraft ? "OPEN" : "APPROVED";
    const r1 = await w.mutate(`/api/sections/${section.id}`, {
      action: "addLines",
      lines: [
        { text: first.text, status: st, bankId: first.id },
        { text: second.text, status: st, bankId: second.id },
      ],
    });
    setBusy(false);
    if (r1) {
      setText("");
      setBankId(null);
    }
  };

  const add = async (t = text.trim(), fromBank = bankId) => {
    if (!t || busy) return;
    setBusy(true);
    const res = await w.mutate(`/api/sections/${section.id}`, {
      action: "addLine",
      text: t,
      status: asDraft ? "OPEN" : "APPROVED",
      bankId: fromBank ?? undefined,
    });
    setBusy(false);
    if (res) {
      setText("");
      setBankId(null);
    }
  };

  return (
    <div ref={boxRef} className={`mt-3 rounded-lg border bg-panel p-2 ${live ? "border-accent ring-2 ring-accent/30" : "border-line"} ${startsGroup && texts.length ? "mt-5" : ""}`}>
      <div className="flex items-start gap-2">
        <span className="w-6 pt-2 text-right font-mono text-xs text-muted">{offset + nextIdx + 1}</span>
        <textarea
          rows={1}
          className="min-w-0 flex-1 field-sizing-content resize-none bg-transparent py-1.5 text-[17px] leading-snug outline-none placeholder:text-muted"
          placeholder={nextIdx === 0 ? "Write the first line…" : pa ? `Next line — rhyme with “${lastWord(partnerText)}”` : "Write the next line…"}
          value={text}
          onFocus={() =>
            w.setInsertTarget((word, mode) => {
              setText((d) => (mode === "replace" || !d.trim() ? word : `${d.replace(/\s+$/, "")} ${word}`));
              if (mode === "replace") setBankId(null);
            })
          }
          onChange={(e) => setText(e.target.value.replace(/\n/g, ""))}
          onPaste={(e) => {
            // several lines pasted at once: each becomes its own line
            const lines = e.clipboardData
              .getData("text")
              .split(/\r?\n/)
              .map((l) => l.replace(/\s+/g, " ").trim())
              .filter(Boolean);
            if (lines.length < 2) return;
            e.preventDefault();
            void w.mutate(`/api/sections/${section.id}`, {
              action: "addLines",
              lines: lines.map((t) => ({ text: t, status: asDraft ? "OPEN" : "APPROVED" })),
            });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
        />
        <button className="btn-primary mt-0.5" disabled={!text.trim() || busy} onClick={() => void add()}>
          Add
        </button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-8 text-xs text-muted">
        <LengthControls
          text={text}
          lang={w.lang}
          reference={refProsody}
          onChange={(t) => {
            setText(t);
            setBankId(null);
          }}
        />
        {w.aiEnabled && Math.abs(sylGap) >= 3 && (
          <button
            className="btn px-2 py-0.5 text-xs"
            disabled={fitting}
            onClick={() => void fitText()}
            title="Rewrite your line to the length and flow of the line before — same meaning, same last word"
          >
            {fitting ? "Fitting…" : `✨ Fit to ${refProsody?.syllables} syl · 1 call`}
          </button>
        )}
        {pa && (
          <span className="flex items-center gap-1">
            rhyme with “{lastWord(partnerText)}” (-{pa.rhymeKey}) {match && <RhymeBadge match={match} />}
          </span>
        )}
        {pa && (
          <button className="underline-offset-2 hover:text-fg hover:underline" onClick={() => w.lookupRhyme(partnerText)}>
            find rhymes
          </button>
        )}
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={asDraft} onChange={(e) => setAsDraft(e.target.checked)} /> add as draft
        </label>
      </div>
      {fitted.length > 0 && (
        <div className="mt-2 space-y-1 pl-8">
          <div className="text-[11px] font-semibold uppercase tracking-wide">Your line, fitted to {refProsody?.syllables} syllables</div>
          {fitted.map((b) => (
            <div key={b.id} className="flex items-baseline gap-2 rounded-md border border-accent/40 bg-accent-soft/40 px-2.5 py-1.5">
              <button className="min-w-0 flex-1 text-left text-[16px] leading-snug hover:text-accent" onClick={() => void add(b.text, b.id)}>
                {b.text}
              </button>
              <span className="font-mono text-[11px] text-muted">{prosody(b.text, w.lang).syllables}</span>
              <button className="btn-ghost px-1 py-0 text-xs" title="Edit before using" onClick={() => (setText(b.text), setBankId(b.id))}>
                ✎
              </button>
            </div>
          ))}
        </div>
      )}
      {written >= 1 && (
        <div className="mt-2 border-t border-line pl-8 pt-2">
          <BankPicker
            sectionId={section.id}
            index={nextIdx}
            texts={texts}
            groupSize={g}
            scheme={section.rhyme_scheme}
            title={`Options for bar ${offset + nextIdx + 1}${pa ? ` · rhymes with “${lastWord(partnerText)}”` : ""}`}
            onUse={(b) => void add(b.text, b.id)}
            onUseCouplet={(a, b) => void addCouplet(a, b)}
            onEdit={(b) => {
              setText(b.text);
              setBankId(b.id);
            }}
          />
        </div>
      )}
    </div>
  );
}

function SectionSettings({ section, index, total }: { section: SectionT; index: number; total: number }) {
  const w = useWriter();
  const save = (patch: Record<string, unknown>) => void w.mutate(`/api/sections/${section.id}`, patch, "PATCH");
  return (
    <div className="mb-3 grid grid-cols-2 gap-3 rounded-lg border border-line bg-panel p-3 sm:grid-cols-4">
      <div>
        <label className="label">Grouping</label>
        <select className="input py-1.5" value={section.group_size} onChange={(e) => save({ group_size: Number(e.target.value) })}>
          <option value={1}>Single lines</option>
          <option value={2}>Couplets</option>
          <option value={3}>Tercets</option>
          <option value={4}>Quatrains</option>
        </select>
      </div>
      {w.tree.audio && (
        <div>
          <label className="label">One line =</label>
          <select className="input py-1.5" value={section.bars_per_line} onChange={(e) => save({ bars_per_line: Number(e.target.value) })}>
            <option value={0.5}>½ bar</option>
            <option value={1}>1 bar</option>
            <option value={2}>2 bars</option>
            <option value={4}>4 bars</option>
          </select>
        </div>
      )}
      {w.tree.audio && section.audio_start !== null && (
        <div>
          <label className="label">Beat anchor</label>
          <button className="btn w-full justify-center py-1.5 text-xs" onClick={() => save({ audio_start: null })}>
            Clear anchor ({fmtTime(section.audio_start)})
          </button>
        </div>
      )}
      <div>
        <label className="label">Rhyme scheme</label>
        <input
          className="input py-1.5"
          placeholder={section.group_size === 2 ? "AA (default)" : section.group_size === 4 ? "AABB (default)" : "e.g. ABAB"}
          defaultValue={section.rhyme_scheme ?? ""}
          onBlur={(e) => save({ rhyme_scheme: e.target.value.trim() || null })}
        />
      </div>
      <div>
        <label className="label">Intensity</label>
        <select className="input py-1.5" value={section.intensity ?? ""} onChange={(e) => save({ intensity: e.target.value ? Number(e.target.value) : null })}>
          <option value="">—</option>
          {Array.from({ length: 10 }, (_, i) => (
            <option key={i} value={i + 1}>
              {i + 1}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">Story beat</label>
        <input className="input py-1.5" placeholder="e.g. anger" defaultValue={section.story_beat ?? ""} onBlur={(e) => save({ story_beat: e.target.value.trim() || null })} />
      </div>
      <div className="col-span-2 sm:col-span-4">
        <label className="label">Notes for this section</label>
        <input className="input py-1.5" placeholder="delivery, imagery, what must happen here…" defaultValue={section.notes ?? ""} onBlur={(e) => save({ notes: e.target.value.trim() || null })} />
      </div>
      <div className="col-span-2 flex flex-wrap gap-1.5 sm:col-span-4">
        {section.audio_start !== null ? (
          <span className="self-center text-xs text-muted">Order follows the beat (starts at the anchor) — clear the anchor to move it by hand.</span>
        ) : (
          <>
            <button className="btn text-xs" disabled={index === 0} onClick={() => void w.mutate(`/api/sections/${section.id}`, { action: "move", dir: -1 })}>
              ↑ Move up
            </button>
            <button className="btn text-xs" disabled={index === total - 1} onClick={() => void w.mutate(`/api/sections/${section.id}`, { action: "move", dir: 1 })}>
              ↓ Move down
            </button>
          </>
        )}
        {index > 0 && (
          <button
            className="btn text-xs"
            title="Moves this section's lines to the end of the section before it"
            onClick={() => {
              const prev = w.tree.sections[index - 1];
              if (window.confirm(`Merge “${section.name}” into “${prev.name}”? Its ${section.lines.length} lines move to the end of “${prev.name}”.`))
                void w.mutate(`/api/sections/${section.id}`, { action: "mergePrevious" });
            }}
          >
            ⤒ Merge into previous
          </button>
        )}
        <button
          className="btn ml-auto text-xs text-bad"
          onClick={() => {
            if (window.confirm(`Delete section “${section.name}” and its ${section.lines.length} lines? (Save a version first if unsure.)`))
              void w.mutate(`/api/sections/${section.id}`, undefined, "DELETE");
          }}
        >
          Delete section
        </button>
      </div>
    </div>
  );
}
