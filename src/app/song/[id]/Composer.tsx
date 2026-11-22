"use client";

import { useEffect, useRef, useState } from "react";
import { analyzeLine, compareLines } from "@/lib/rhyme/analyze";
import { prosody } from "@/lib/rhyme/prosody";
import type { RhymeResult } from "@/lib/rhyme/types";
import { Plus, Sparkles } from "@/components/icons";

/**
 * Writing a part bar by bar — the writer leads: type the next line, Enter puts it in (kept, the AI never
 * changes it). While writing, for free: the length of the line before (syllables), and — on the second line of
 * a couplet — the word to rhyme with, its rhymes to tap in, a ✓ once the line rhymes. On request: the next line
 * suggested on the same length and flow (1 call), picked into the box to edit.
 */

const lastWord = (t: string) => t.trim().split(/\s+/).pop()?.replace(/[^\p{L}\p{N}'’]+/gu, "") ?? "";

export function Composer({
  lang,
  previous,
  rhymeWith,
  startOpen,
  onAdd,
  autoCheck,
  setAutoCheck,
  onNextLine,
  onRhymes,
  loadEndings,
}: {
  lang: string;
  /** the line before (the last written one in the part): its length is the one to match */
  previous: string | null;
  /** this line closes a couplet: it should rhyme with this line */
  rhymeWith: string | null;
  /** open from the start (a song written from scratch); else a "+ Write a line" button */
  startOpen: boolean;
  onAdd: (text: string) => Promise<unknown>;
  /** each line added is checked (grammar, wording — as you'd say it): 1 call per line */
  autoCheck: boolean;
  setAutoCheck: (on: boolean) => void;
  /** 3 next lines on the line before's length and flow (1 call) */
  onNextLine: (() => Promise<string[]>) | null;
  /** line endings that rhyme with the line before, best fit for the lyrics first (1 call; remembered) */
  loadEndings: ((word: string, line: string) => Promise<{ text: string; word: string }[]>) | null;
  /** the rhymes of a word, with endings for the line (the rhyme sheet) — an ending picked there is added here */
  onRhymes: (word: string, line: string, use: (ending: string) => void) => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"add" | "next" | null>(null);
  const [options, setOptions] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const target = previous ? prosody(previous, lang).syllables : null;
  const syl = text.trim() ? prosody(text, lang).syllables : 0;
  const word = rhymeWith ? lastWord(rhymeWith) : "";
  const rhymes = !!word && !!text.trim() && compareLines(analyzeLine(rhymeWith!, lang), analyzeLine(text, lang)).score >= 0.55 && lastWord(text).toLowerCase() !== word.toLowerCase();

  // the rhymes of the word to rhyme with (the dictionary: free)
  const [found, setFound] = useState<{ key: string; words: string[] } | null>(null);
  const key = `${word}|${lang}`;
  useEffect(() => {
    if (!word) return;
    let gone = false;
    void fetch(`/api/rhymes?q=${encodeURIComponent(word)}&lang=${encodeURIComponent(lang)}`)
      .then((r) => (r.ok ? (r.json() as Promise<RhymeResult>) : null))
      .then((r) => {
        if (!gone && r) setFound({ key, words: [...r.perfect, ...r.near].map((w) => w.word).filter((w) => w.toLowerCase() !== word.toLowerCase()).slice(0, 14) });
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [word, lang, key]);
  const chips = found?.key === key ? found.words : [];

  // the second line of a couplet: endings that rhyme, shown as soon as it is to be written
  const [ends, setEnds] = useState<{ key: string; list: { text: string; word: string }[] | null; err?: string } | null>(null);
  const endKey = rhymeWith ? `${rhymeWith}|${lang}` : "";
  useEffect(() => {
    if (!loadEndings || !rhymeWith || !word) return;
    let gone = false;
    loadEndings(word, rhymeWith).then(
      (list) => !gone && setEnds({ key: endKey, list }),
      (e: unknown) => !gone && setEnds({ key: endKey, list: null, err: e instanceof Error ? e.message : "No endings now" }),
    );
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endKey]);
  const endList = ends?.key === endKey ? ends : null;
  const [allEnds, setAllEnds] = useState(false);
  /** an ending tapped: it ends the line being written (what is typed stays in front of it) */
  const putEnding = (e: string) => {
    setText((t) => (t.trim() ? `${t.trim()} ${e}` : e));
    setTimeout(() => {
      const el = box.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }, 30);
  };

  const add = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy("add");
    setErr(null);
    try {
      await onAdd(t);
      setText("");
      setOptions(null);
      setTimeout(() => box.current?.focus(), 50);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };
  const next = async () => {
    if (!onNextLine || busy) return;
    setBusy("next");
    setErr(null);
    try {
      setOptions(await onNextLine());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };
  /** a rhyme tapped: it ends the line (the last word replaced when it was one being tried) */
  const putWord = (w: string) => {
    const t = text.trimEnd();
    setText(t ? `${t} ${w}` : w);
    box.current?.focus();
  };

  if (!open)
    return (
      <button className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-line py-2 text-[13px] font-semibold text-muted active:bg-panel-2" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Write a line
      </button>
    );
  return (
    <div className="mt-2 space-y-2 rounded-3xl bg-panel px-3.5 py-3 ring-1 ring-accent/30">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold text-muted">
        <span>{previous ? "Next bar" : "First bar"}</span>
        <button
          className={`order-last ml-auto rounded-full px-2 py-0.5 ${autoCheck ? "bg-ok-soft text-ok" : "bg-panel-2 text-muted"}`}
          onClick={() => setAutoCheck(!autoCheck)}
          aria-pressed={autoCheck}
          title="Each line you add is checked: grammar, and wording as a native speaker would say it (1 call per line)"
        >
          {autoCheck ? "✓ Check each line · 1 call" : "Check each line: off"}
        </button>
        {target !== null && (
          <span className={syl ? (Math.abs(syl - target) <= 1 ? "text-ok" : "text-warn") : ""} title="Syllables: this line / the line before">
            {syl || "–"}/{target} syl
          </span>
        )}
        {word && (
          <button className={`rounded-full px-2 py-0.5 ${rhymes ? "bg-ok-soft text-ok" : "bg-accent-soft text-accent"}`} onClick={() =>
              onRhymes(word, rhymeWith!, (ending) => {
                setText((t) => (t.trim() ? `${t.trim()} ${ending}` : ending));
                // back in the box, at the end: change it, then add it
                setTimeout(() => {
                  const el = box.current;
                  el?.focus();
                  el?.setSelectionRange(el.value.length, el.value.length);
                }, 60);
              })
            } title={`Rhymes and line endings for “${word}”`}>
            {rhymes ? "✓ rhymes with" : "rhymes with"} “{word}”
          </button>
        )}
      </div>
      <textarea
        ref={box}
        className="input min-h-[2.75rem] resize-none text-[17px]"
        rows={1}
        autoFocus={startOpen}
        value={text}
        placeholder={previous ? "Write your next bar…" : "Write your first bar…"}
        onChange={(e) => setText(e.target.value.replace(/\n/g, " "))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void add();
          }
        }}
        enterKeyHint="done"
      />
      {/* endings that rhyme with the line before, best fit first: tap one to end the line on it */}
      {loadEndings && rhymeWith && word && (
        <div className="space-y-1">
          <p className="px-1 text-[11px] font-semibold text-muted">
            Endings on “-{word.slice(-4)}” · best fit first <span className="font-normal">· 1 call</span>
          </p>
          {!endList ? (
            <p className="flex items-center gap-2 px-1 py-1 text-xs text-muted">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-r-transparent" /> Writing endings for your lyrics…
            </p>
          ) : endList.list === null ? (
            <p className="px-1 text-xs text-bad">{endList.err}</p>
          ) : (
            <>
              {(allEnds ? endList.list : endList.list.slice(0, 5)).map((e) => (
                <button key={e.text} className="flex w-full items-center gap-2 rounded-xl bg-panel-2/70 px-2.5 py-1.5 text-left text-sm active:bg-accent-soft" onClick={() => putEnding(e.text)}>
                  <span className="min-w-0 flex-1">
                    … {e.text.slice(0, Math.max(0, e.text.length - e.word.length))}
                    <b className="text-accent">{e.text.slice(Math.max(0, e.text.length - e.word.length))}</b>
                  </span>
                </button>
              ))}
              {endList.list.length > 5 && (
                <button className="px-1 text-[11px] font-semibold text-accent" onClick={() => setAllEnds(!allEnds)}>
                  {allEnds ? "Fewer" : `${endList.list.length - 5} more`}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {/* the word to rhyme with: its rhymes, tap one to end the line on it (free) */}
      {chips.length > 0 && (
        <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
          {chips.map((w) => (
            <button key={w} className="shrink-0 rounded-full bg-panel-2 px-2.5 py-1 text-[13px] font-semibold text-fg/80 active:bg-accent-soft" onClick={() => putWord(w)}>
              {w}
            </button>
          ))}
        </div>
      )}
      {/* the next line suggested: tap one to put it in the box, edit it, then add it */}
      {options && (
        <div className="space-y-1.5">
          {options.map((o, i) => (
            <button
              key={i}
              className="flex w-full items-start gap-2 rounded-xl bg-panel-2/70 px-2.5 py-2 text-left text-sm ring-1 ring-line/50 active:bg-accent-soft"
              onClick={() => {
                setText(o);
                setTimeout(() => {
                  box.current?.focus();
                  box.current?.setSelectionRange(o.length, o.length);
                }, 30);
              }}
            >
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-panel text-[10px] font-bold text-muted">{i + 1}</span>
              <span className="min-w-0 flex-1">{o}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted">{prosody(o, lang).syllables} syl</span>
            </button>
          ))}
          <p className="px-1 text-[11px] text-muted">Tap one to put it in the box — change it as you like, then add it.</p>
        </div>
      )}
      {err && <p className="rounded-xl bg-bad-soft px-3 py-1.5 text-xs text-bad">{err}</p>}
      <div className="flex gap-2">
        {onNextLine && previous && (
          <button className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-2xl bg-accent-soft text-[13px] font-semibold text-accent disabled:opacity-50" disabled={busy !== null} onClick={() => void next()}>
            {busy === "next" ? (
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent border-r-transparent" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {busy === "next" ? "Writing…" : options ? "Other next lines" : "Suggest the next line"}
            <span className="text-[10px] font-medium text-muted">· 1 call</span>
          </button>
        )}
        <button className="btn-primary h-10 flex-1 justify-center rounded-2xl text-sm" disabled={!text.trim() || busy !== null} onClick={() => void add()}>
          {busy === "add" ? "Adding…" : "Add the line"}
        </button>
      </div>
    </div>
  );
}
