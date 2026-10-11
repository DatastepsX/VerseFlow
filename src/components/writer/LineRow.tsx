"use client";

import { useEffect, useRef, useState } from "react";
import { analyzeLine, compareLines, type RhymeMatch } from "@/lib/rhyme/analyze";
import type { Alternative, Line } from "@/lib/types";
import { useWriter } from "./context";
import { AI_ACTIONS, isLocked, letterColor, STATUS_META } from "./util";

export function RhymeBadge({ match }: { match: RhymeMatch | null }) {
  if (!match) return null;
  const meta =
    match.quality === "perfect"
      ? { t: "rhyme", c: "text-ok", i: "●" }
      : match.quality === "assonance"
        ? { t: "assonance", c: "text-warn", i: "◐" }
        : match.quality === "identical"
          ? { t: "same word", c: "text-warn", i: "=" }
          : { t: "no rhyme", c: "text-bad", i: "○" };
  return (
    <span className={`text-[11px] ${meta.c}`} title={`${meta.t}${match.depth > 1 ? ` · ${match.depth} matching vowels` : ""}`}>
      {meta.i}
      {match.depth > 2 && match.quality !== "none" ? <sup className="ml-px">{match.depth}</sup> : null}
    </span>
  );
}

interface Props {
  line: Line & { alternatives: Alternative[] };
  number: number;
  letter: string | null;
  partnerText: string | null;
  partnerNumber: number | null;
  targetSyllables: number | null;
  groupSize: number;
  isRap: boolean;
}

export function LineRow({ line, number, letter, partnerText, partnerNumber, targetSyllables, groupSize, isRap }: Props) {
  const w = useWriter();
  const selected = w.selectedId === line.id;
  const [draft, setDraft] = useState(line.text);
  const [instruction, setInstruction] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = w.generating.has(line.id);

  const [editingRaw, setEditingRaw] = useState(false);
  const [menuRaw, setMenu] = useState(false);
  // editing and the menu only live while the line is selected
  const editing = editingRaw && selected;
  const menu = menuRaw && selected;
  const setEditing = (on: boolean) => {
    if (on) setDraft(line.text);
    setEditingRaw(on);
  };

  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      const len = ref.current?.value.length ?? 0;
      ref.current?.setSelectionRange(len, len);
    }
  }, [editing]);

  const a = line.text.trim() ? analyzeLine(line.text, w.lang) : null;
  const match = a && partnerText?.trim() ? compareLines(a, analyzeLine(partnerText, w.lang)) : null;
  const meta = STATUS_META[line.status];
  const rhythm = line.kind === "rhythm_ref";
  const sylOff = a && targetSyllables && !rhythm ? Math.abs(a.syllables - targetSyllables) : 0;

  const saveEdit = async () => {
    const text = draft.trim();
    setEditing(false);
    if (text === line.text.trim()) return;
    await w.mutate(`/api/lines/${line.id}`, { text, status: rhythm ? line.status : "APPROVED_EDITED", action: "edit" }, "PATCH");
  };

  const setStatus = (status: Line["status"], action: string) =>
    w.mutate(`/api/lines/${line.id}`, { status, action }, "PATCH");

  const gen = (instr?: string, scope: "line" | "group" = "line") => {
    setMenu(false);
    void w.generate(line.id, { instruction: instr ?? (instruction.trim() || undefined), scope });
  };

  return (
    <div
      className={`group rounded-md border-l-[3px] ${meta.bar} ${selected ? "bg-panel shadow-sm ring-1 ring-line" : "hover:bg-panel/60"} `}
    >
      <div
        className="flex cursor-pointer items-baseline gap-2 px-2 py-1.5"
        onClick={() => {
          if (selected) return;
          setEditingRaw(false);
          setMenu(false);
          w.select(line.id);
        }}
      >
        <span className="w-6 shrink-0 text-right font-mono text-xs text-muted">{number}</span>
        <span
          className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold ${letter ? letterColor(letter) : "text-transparent"}`}
          title={letter ? `Rhyme group ${letter}` : undefined}
        >
          {letter ?? "·"}
        </span>
        {editing ? (
          <textarea
            ref={ref}
            rows={1}
            className="min-w-0 flex-1 field-sizing-content resize-none bg-transparent text-[17px] leading-snug outline-none"
            value={draft}
            onFocus={() =>
              w.setInsertTarget((word) => setDraft((d) => (d.trim() ? `${d.replace(/\s+$/, "")} ${word}` : word)))
            }
            onChange={(e) => setDraft(e.target.value.replace(/\n/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void saveEdit();
              }
              if (e.key === "Escape") {
                setDraft(line.text);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span
            className={`min-w-0 flex-1 text-[17px] leading-snug ${line.status === "DECLINED" ? "text-muted line-through" : ""} ${rhythm ? "italic text-muted" : ""} ${!line.text ? "text-muted" : ""}`}
            onDoubleClick={() => {
              w.select(line.id);
              setEditing(true);
            }}
          >
            {line.text || (busy ? "Writing options…" : "(empty — ask for suggestions or edit)")}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1.5">
          {rhythm && <span className="rounded bg-panel-2 px-1 text-[10px] uppercase text-muted">rhythm</span>}
          {partnerNumber !== null && <RhymeBadge match={match} />}
          {a && (
            <span
              className={`w-6 text-right font-mono text-[11px] ${sylOff >= 3 ? "text-warn" : "text-muted"}`}
              title={`${a.syllables} syllables${targetSyllables ? ` (target ≈ ${targetSyllables})` : ""}`}
            >
              {a.syllables}
            </span>
          )}
        </span>
      </div>

      {selected && (
        <div className="space-y-2 px-2 pb-2 pl-10" onClick={(e) => e.stopPropagation()}>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span className={`rounded px-1.5 py-0.5 font-medium ${meta.chip}`}>{meta.label}</span>
            {a?.lastWord && (
              <button className="hover:text-fg" onClick={() => w.lookupRhyme(line.text)} title="Find rhymes">
                ends “{a.lastWord}” · -{a.rhymeKey}
              </button>
            )}
            {partnerNumber !== null && partnerText && (
              <span>
                · should rhyme with line {partnerNumber}
                {match && match.quality === "none" ? " (doesn’t yet)" : ""}
              </span>
            )}
          </div>

          {editing ? (
            <div className="flex gap-1.5">
              <button className="btn-primary" onClick={() => void saveEdit()}>
                Save
              </button>
              <button
                className="btn"
                onClick={() => {
                  setDraft(line.text);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {!isLocked(line) && line.text.trim() && !rhythm && (
                <button className="btn border-ok/40 text-ok" onClick={() => void setStatus("APPROVED", "approve")}>
                  ✓ Use
                </button>
              )}
              <button className="btn" onClick={() => setEditing(true)}>
                ✎ Edit
              </button>
              {line.status !== "DECLINED" && !rhythm && line.text.trim() && (
                <button className="btn text-bad" onClick={() => void setStatus("DECLINED", "decline")}>
                  ✕ Decline
                </button>
              )}
              {isLocked(line) && (
                <button className="btn" onClick={() => void setStatus("OPEN", "unlock")} title="Make it a draft again">
                  Unlock
                </button>
              )}
              {w.aiEnabled && !rhythm && (
                <button className="btn" disabled={busy} onClick={() => gen()}>
                  {busy ? "…" : "✨ 3 options"}
                </button>
              )}
              {w.aiEnabled && !rhythm && groupSize > 1 && (
                <button className="btn" disabled={busy} onClick={() => gen(undefined, "group")}>
                  ✨ {groupSize === 2 ? "Couplet" : "Group"}
                </button>
              )}
              <div className="relative">
                <button className="btn" onClick={() => setMenu((m) => !m)}>
                  ⋯
                </button>
                {menu && (
                  <div className="absolute left-0 z-20 mt-1 w-56 overflow-hidden rounded-md border border-line bg-panel py-1 text-sm shadow-lg">
                    {w.aiEnabled &&
                      !rhythm &&
                      AI_ACTIONS.filter((x) => !x.rap || isRap).map((x) => (
                        <button key={x.label} className="block w-full px-3 py-1.5 text-left hover:bg-panel-2" onClick={() => gen(x.instruction)}>
                          ✨ {x.label}
                        </button>
                      ))}
                    <div className="my-1 border-t border-line" />
                    <MenuItem
                      label={rhythm ? "Use as lyric line" : "Mark as rhythm reference"}
                      onClick={() => {
                        setMenu(false);
                        void w.mutate(`/api/lines/${line.id}`, { kind: rhythm ? "lyric" : "rhythm_ref", action: "kind" }, "PATCH");
                      }}
                    />
                    <MenuItem label="Note…" onClick={() => (setMenu(false), setNote(line.note ?? ""))} />
                    <MenuItem
                      label="Insert line below"
                      onClick={async () => {
                        setMenu(false);
                        const res = await w.mutate(`/api/sections/${line.section_id}`, { action: "addLine", afterLineId: line.id, status: "OPEN" });
                        const id = res?.headers.get("x-line-id");
                        if (id) w.select(id);
                      }}
                    />
                    <MenuItem
                      label="Insert line above"
                      onClick={async () => {
                        setMenu(false);
                        const sec = w.tree.sections.find((s) => s.id === line.section_id);
                        const i = sec?.lines.findIndex((l) => l.id === line.id) ?? 0;
                        const prev = i > 0 ? sec!.lines[i - 1].id : null;
                        const res = await w.mutate(`/api/sections/${line.section_id}`, { action: "addLine", afterLineId: prev, status: "OPEN" });
                        const id = res?.headers.get("x-line-id");
                        if (id) w.select(id);
                      }}
                    />
                    <MenuItem label="Move up" onClick={() => (setMenu(false), void w.mutate(`/api/lines/${line.id}`, { action: "move", dir: -1 }))} />
                    <MenuItem label="Move down" onClick={() => (setMenu(false), void w.mutate(`/api/lines/${line.id}`, { action: "move", dir: 1 }))} />
                    <MenuItem label="Add my own option…" onClick={() => {
                      setMenu(false);
                      const t = window.prompt("Your alternative for this line:");
                      if (t?.trim()) void w.mutate(`/api/lines/${line.id}`, { action: "addAlternative", text: t });
                    }} />
                    <MenuItem
                      label="Delete line"
                      danger
                      onClick={() => {
                        setMenu(false);
                        w.select(null);
                        void w.mutate(`/api/lines/${line.id}`, undefined, "DELETE");
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {w.aiEnabled && !rhythm && !editing && (
            <input
              className="input py-1.5 text-xs"
              placeholder="Direction for the AI (optional) — e.g. “mention the rain”, “more anger”"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && gen()}
            />
          )}

          {note !== null && (
            <div className="flex gap-1.5">
              <input className="input py-1.5 text-xs" autoFocus value={note} placeholder="Delivery note, idea…" onChange={(e) => setNote(e.target.value)} />
              <button
                className="btn"
                onClick={() => {
                  void w.mutate(`/api/lines/${line.id}`, { note: note.trim() || null, action: "note" }, "PATCH");
                  setNote(null);
                }}
              >
                Save
              </button>
            </div>
          )}
          {line.note && note === null && <p className="text-xs italic text-muted">Note: {line.note}</p>}
        </div>
      )}

      {line.alternatives.length > 0 && (
        <Alternatives line={line} partnerText={partnerText} onMore={() => gen(line.alternatives[0]?.instruction ?? undefined, line.alternatives[0]?.text.includes("\n") ? "group" : "line")} />
      )}
    </div>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button className={`block w-full px-3 py-1.5 text-left hover:bg-panel-2 ${danger ? "text-bad" : ""}`} onClick={onClick}>
      {label}
    </button>
  );
}

function Alternatives({
  line,
  partnerText,
  onMore,
}: {
  line: Line & { alternatives: Alternative[] };
  partnerText: string | null;
  onMore: () => void;
}) {
  const w = useWriter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const busy = w.generating.has(line.id);
  const partner = partnerText?.trim() ? analyzeLine(partnerText, w.lang) : null;

  return (
    <div className="mx-2 mb-2 ml-10 space-y-1.5 rounded-md border border-dashed border-accent/40 bg-accent-soft/40 p-2" onClick={(e) => e.stopPropagation()}>
      {line.alternatives.map((alt, i) => {
        const rows = alt.text.split("\n");
        const multi = rows.length > 1;
        return (
          <div key={alt.id} className="rounded-md bg-panel p-2">
            {editingId === alt.id ? (
              <textarea
                className="input min-h-14 text-[15px]"
                autoFocus
                value={text}
                onFocus={() => w.setInsertTarget((word) => setText((d) => `${d.replace(/\s+$/, "")} ${word}`))}
                onChange={(e) => setText(e.target.value)}
              />
            ) : (
              <div className="flex gap-2">
                <span className="font-mono text-xs font-bold text-accent">{String.fromCharCode(65 + i)}</span>
                <div className="flex-1 space-y-0.5">
                  {rows.map((r, k) => {
                    const an = analyzeLine(r, w.lang);
                    const m = !multi && partner ? compareLines(an, partner) : null;
                    return (
                      <div key={k} className="flex items-baseline gap-2">
                        <span className="flex-1 text-[15px] leading-snug">{r}</span>
                        {m && <RhymeBadge match={m} />}
                        <span className="font-mono text-[11px] text-muted">{an.syllables}</span>
                      </div>
                    );
                  })}
                  {alt.source === "user" && <span className="text-[10px] uppercase text-muted">your option</span>}
                </div>
              </div>
            )}
            <div className="mt-1.5 flex gap-1.5 pl-5">
              {editingId === alt.id ? (
                <>
                  <button
                    className="btn-primary px-2 py-1 text-xs"
                    onClick={() => {
                      setEditingId(null);
                      void w.mutate(`/api/alternatives/${alt.id}`, { action: "select", text });
                    }}
                  >
                    Use edited
                  </button>
                  <button className="btn px-2 py-1 text-xs" onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="btn px-2 py-1 text-xs text-ok" onClick={() => void w.mutate(`/api/alternatives/${alt.id}`, { action: "select" })}>
                    ✓ Use
                  </button>
                  <button
                    className="btn px-2 py-1 text-xs"
                    onClick={() => {
                      setEditingId(alt.id);
                      setText(alt.text);
                    }}
                  >
                    ✎ Edit
                  </button>
                  <button className="btn px-2 py-1 text-xs text-bad" onClick={() => void w.mutate(`/api/alternatives/${alt.id}`, { action: "reject" })}>
                    ✕
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
      <div className="flex gap-1.5">
        {w.aiEnabled && (
          <button className="btn px-2 py-1 text-xs" disabled={busy} onClick={onMore}>
            {busy ? "Writing…" : "✨ 3 new options"}
          </button>
        )}
        <button
          className="btn-ghost text-xs"
          onClick={() => {
            for (const alt of line.alternatives) void w.mutate(`/api/alternatives/${alt.id}`, { action: "reject" });
          }}
        >
          Dismiss all
        </button>
      </div>
    </div>
  );
}
