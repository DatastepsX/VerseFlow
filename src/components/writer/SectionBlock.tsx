"use client";

import { useState } from "react";
import { analyzeLine, compareLines, lastWord, rhymeScheme } from "@/lib/rhyme/analyze";
import { rhymePartners } from "@/lib/scheme";
import type { ProjectTree } from "@/lib/types";
import { useWriter } from "./context";
import { LineRow, RhymeBadge } from "./LineRow";

type SectionT = ProjectTree["sections"][number];

export function SectionBlock({ section, index, total }: { section: SectionT; index: number; total: number }) {
  const w = useWriter();
  const [settings, setSettings] = useState(false);
  const g = Math.max(1, section.group_size);
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
    <section id={`section-${section.id}`} className="scroll-mt-20">
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
        <button className="btn-ghost text-xs" onClick={() => setSettings((s) => !s)}>
          {settings ? "Done" : "⚙"}
        </button>
      </div>

      {settings && <SectionSettings section={section} index={index} total={total} />}

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
                />
              );
            })}
          </div>
        ))}
      </div>

      <Composer section={section} texts={texts} targetSyl={targetSyl} offset={offset} />
    </section>
  );
}

function Composer({ section, texts, targetSyl, offset }: { section: SectionT; texts: string[]; targetSyl: number | null; offset: number }) {
  const w = useWriter();
  const [text, setText] = useState("");
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

  const add = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const res = await w.mutate(`/api/sections/${section.id}`, { action: "addLine", text: t, status: asDraft ? "OPEN" : "APPROVED" });
    setBusy(false);
    if (res) setText("");
  };

  const suggest = async (scope: "line" | "group") => {
    setBusy(true);
    const res = await w.mutate(`/api/sections/${section.id}`, { action: "addLine", text: "", status: "OPEN" });
    setBusy(false);
    const id = res?.headers.get("x-line-id");
    if (!id) return;
    w.select(id);
    if (scope === "group") {
      // make room for the rest of the group, then ask for whole-group options
      let prev = id;
      for (let k = 1; k < g; k++) {
        const r = await w.mutate(`/api/sections/${section.id}`, { action: "addLine", text: "", status: "OPEN", afterLineId: prev });
        prev = r?.headers.get("x-line-id") ?? prev;
      }
    }
    await w.generate(id, { scope, instruction: text.trim() ? `Idea to build on: ${text.trim()}` : undefined });
    setText("");
  };

  return (
    <div className={`mt-3 rounded-lg border border-line bg-panel p-2 ${startsGroup && texts.length ? "mt-5" : ""}`}>
      <div className="flex items-start gap-2">
        <span className="w-6 pt-2 text-right font-mono text-xs text-muted">{offset + nextIdx + 1}</span>
        <textarea
          rows={1}
          className="min-w-0 flex-1 field-sizing-content resize-none bg-transparent py-1.5 text-[17px] leading-snug outline-none placeholder:text-muted"
          placeholder={nextIdx === 0 ? "Write the first line…" : pa ? `Next line — rhyme with “${lastWord(partnerText)}”` : "Write the next line…"}
          value={text}
          onFocus={() => w.setInsertTarget((word) => setText((d) => (d.trim() ? `${d.replace(/\s+$/, "")} ${word}` : word)))}
          onChange={(e) => setText(e.target.value.replace(/\n/g, ""))}
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
        {a && (
          <span className={targetSyl && Math.abs(a.syllables - targetSyl) >= 3 ? "text-warn" : ""}>
            {a.syllables} syl{targetSyl ? ` / ≈${targetSyl}` : ""}
          </span>
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
        {w.aiEnabled && (
          <span className="ml-auto flex gap-1.5">
            <button className="btn px-2 py-1 text-xs" disabled={busy} onClick={() => void suggest("line")}>
              ✨ Suggest next line
            </button>
            {g > 1 && startsGroup && (
              <button className="btn px-2 py-1 text-xs" disabled={busy} onClick={() => void suggest("group")}>
                ✨ Suggest {g === 2 ? "couplet" : "group"}
              </button>
            )}
          </span>
        )}
      </div>
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
        <button className="btn text-xs" disabled={index === 0} onClick={() => void w.mutate(`/api/sections/${section.id}`, { action: "move", dir: -1 })}>
          ↑ Move up
        </button>
        <button className="btn text-xs" disabled={index === total - 1} onClick={() => void w.mutate(`/api/sections/${section.id}`, { action: "move", dir: 1 })}>
          ↓ Move down
        </button>
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
