"use client";

import { useEffect, useRef, useState } from "react";
import { analyzeLine, compareLines, type RhymeMatch } from "@/lib/rhyme/analyze";
import type { Alternative, Line } from "@/lib/types";
import { prosody } from "@/lib/rhyme/prosody";
import { patternReference } from "@/lib/pattern";
import { rhythmReference } from "@/lib/suggest";
import { BankPicker } from "./Bank";
import { usePlayer } from "./Player";
import { LengthControls } from "./LengthControls";
import { useWriter } from "./context";
import { useFollow } from "./follow";
import { snapSectionStart } from "@/lib/audio/structure";
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
  /** section line texts + this line's index, for bank suggestions */
  sectionTexts: string[];
  index: number;
  scheme: string | null;
  /** the beat is currently playing this line's bar(s) */
  live?: boolean;
}

export function LineRow({ line, number, letter, partnerText, partnerNumber, targetSyllables, groupSize, isRap, sectionTexts, index, scheme, live }: Props) {
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
  // draft bars get quick ✓ / ✕ / ↻ right on the row (first review pass)
  const reviewable = !rhythm && !!line.text.trim() && (line.status === "SUGGESTED" || line.status === "DECLINED" || line.status === "NEEDS_NEW_OPTIONS");
  const player = usePlayer();
  // keep the line the song is at in view
  const rowRef = useRef<HTMLDivElement>(null);
  useFollow(() => rowRef.current, live ? line.id : null, player.playing);
  // selecting a bar moves the beat to that bar
  const jumpToBar = () => {
    const sec = w.tree.sections.find((x) => x.id === line.section_id);
    if (!sec || !player.ready) return;
    const at = player.lineStart(sec.id, sec.lines.findIndex((l) => l.id === line.id));
    if (at !== null) player.seek(at);
  };
  const ownSection = w.tree.sections.find((x) => x.id === line.section_id);
  const sectionRhythmRef = ownSection ? patternReference(ownSection) : null;
  const refText = selected && !rhythm ? rhythmReference(sectionTexts, index, sectionRhythmRef) : null;
  const refProsody = refText ? prosody(refText, w.lang) : null;
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
      ref={rowRef}
      className={`group rounded-md border-l-[3px] ${meta.bar} ${selected ? "bg-panel shadow-sm ring-1 ring-line" : "hover:bg-panel/60"} ${live ? "bg-accent-soft/70 ring-2 ring-accent/40" : ""}`}
    >
      <div
        className="flex cursor-pointer items-baseline gap-2 px-2 py-1.5"
        onClick={() => {
          if (selected) return;
          setEditingRaw(false);
          setMenu(false);
          w.select(line.id);
          jumpToBar();
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
              w.setInsertTarget((word, mode) => setDraft((d) => (mode === "replace" || !d.trim() ? word : `${d.replace(/\s+$/, "")} ${word}`)))
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
          {reviewable && !editing && (
            <span className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
              {line.status !== "SUGGESTED" || line.alternatives.length === 0 ? null : (
                <button
                  className="rounded px-1.5 py-0.5 text-xs text-accent hover:bg-accent-soft"
                  title={`Next option (${line.alternatives.length} more) — free`}
                  onClick={() => void w.mutate(`/api/alternatives/${line.alternatives[0].id}`, { action: "swap" })}
                >
                  ↻{line.alternatives.length}
                </button>
              )}
              <button
                className={`rounded px-1.5 py-0.5 text-xs ${line.status === "DECLINED" ? "bg-bad text-white" : "text-bad hover:bg-bad-soft"}`}
                title={line.status === "DECLINED" ? "Marked to replace — tap to undo" : "Mark to replace"}
                onClick={() =>
                  void w.mutate(
                    `/api/lines/${line.id}`,
                    line.status === "DECLINED" ? { status: "SUGGESTED", action: "unmark" } : { status: "DECLINED", action: "mark_replace" },
                    "PATCH",
                  )
                }
              >
                ✕
              </button>
              <button
                className="rounded px-1.5 py-0.5 text-xs text-ok hover:bg-ok-soft"
                title="Keep this bar"
                onClick={() => void w.mutate(`/api/lines/${line.id}`, { status: "APPROVED", action: "approve" }, "PATCH")}
              >
                ✓
              </button>
            </span>
          )}
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
            <div className="flex flex-wrap items-center gap-1.5">
              {!rhythm && <LengthControls text={draft} lang={w.lang} reference={refProsody} onChange={setDraft} />}
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
            <div className="flex flex-wrap items-center gap-1.5">
              {!rhythm && line.text.trim() && (
                <LengthControls
                  text={line.text}
                  lang={w.lang}
                  reference={refProsody}
                  onChange={(t) =>
                    void w.mutate(`/api/lines/${line.id}`, { text: t, status: isLocked(line) ? "APPROVED_EDITED" : line.status, action: "length" }, "PATCH")
                  }
                />
              )}
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
                  ✕ To replace
                </button>
              )}
              {isLocked(line) && (
                <button className="btn" onClick={() => void setStatus("OPEN", "unlock")} title="Make it a draft again">
                  Unlock
                </button>
              )}
              {w.aiEnabled && !rhythm && (
                <button className="btn" disabled={busy} onClick={() => gen()}>
                  {busy ? "…" : "✨ AI options · 1 call"}
                </button>
              )}
              {w.aiEnabled && !rhythm && groupSize > 1 && (
                <button className="btn" disabled={busy} onClick={() => gen(undefined, "group")}>
                  ✨ {groupSize === 2 ? "Couplet" : "Group"} · 1 call
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
                    {index > 0 && (
                      <MenuItem
                        label="✂ New section from here…"
                        onClick={() => {
                          setMenu(false);
                          const name = window.prompt("This line and the ones after it become a new section. Name (e.g. Rap 1, Chorus, Bridge):", isRap ? "Hook" : "Rap");
                          if (!name?.trim()) return;
                          // the new section starts where this line is sung, on the bar (a pickup stays in it)
                          const sec = w.tree.sections.find((x) => x.id === line.section_id);
                          const k = sec?.lines.findIndex((l) => l.id === line.id) ?? -1;
                          const at = line.audio_at ?? (sec ? player.lineStart(sec.id, k) : null);
                          let start = at;
                          if (at !== null && w.tree.audio?.bpm) {
                            const bar = (w.tree.audio.beats_per_bar * 60) / w.tree.audio.bpm;
                            start = snapSectionStart(at, w.tree.audio);
                            if (start > at + 0.15) start = Math.max(0, start - bar);
                          }
                          void w.mutate(`/api/lines/${line.id}`, { action: "splitSection", name: name.trim(), start });
                        }}
                      />
                    )}
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

          {!rhythm && !editing && (!isLocked(line) || !line.text.trim()) && w.tree.bank.some((b) => b.section_id === line.section_id) && (
            <BankPicker
              sectionId={line.section_id}
              index={index}
              texts={sectionTexts}
              groupSize={groupSize}
              scheme={scheme}
              title={line.text.trim() ? "Replace from your bank" : "Fill from your bank"}
              onUse={(b) =>
                void w.mutate(`/api/lines/${line.id}`, { text: b.text, status: "APPROVED", bankId: b.id, action: "bank" }, "PATCH")
              }
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

      {line.alternatives.length > 0 && selected && (
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
                onFocus={() => w.setInsertTarget((word, mode) => setText((d) => (mode === "replace" ? word : `${d.replace(/\s+$/, "")} ${word}`)))}
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
