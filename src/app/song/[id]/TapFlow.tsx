"use client";

import { useEffect, useRef, useState } from "react";
import { exampleWords } from "@/lib/flow/example";
import { flowFromGrid, STEPS_PER_BEAT, type FlowGridModel } from "@/lib/flow/grid";
import type { LineFlow } from "@/lib/types";
import { Check, Hand, Shuffle, Sparkles } from "@/components/icons";

/**
 * Tap a line's flow: the beat plays (one bar to count in, then the line's
 * bar), you tap the pad once per syllable. Taps snap to 16th notes; a tap on
 * a beat is stressed. Right away: example words with exactly that rhythm.
 */
export function TapFlow({
  window: win,
  flow,
  lang,
  onStart,
  songTime,
  onSave,
  onCancel,
}: {
  /** the line's bar(s) on the beat (start, step, length) */
  window: FlowGridModel;
  flow: LineFlow | null;
  lang: string;
  /** plays the count-in + the bar(s) */
  onStart: () => void;
  /** the song time you hear now */
  songTime: () => number;
  onSave: (f: LineFlow, write: boolean) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [taps, setTaps] = useState<number[]>([]);
  const [now, setNow] = useState(0);
  const [seed, setSeed] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const tapCount = useRef(0);
  const end = win.start + win.cells.length * win.step;

  // the count-in / progress while the beat plays; the bar is over → the result
  useEffect(() => {
    if (phase !== "running") return;
    const id = setInterval(() => {
      const t = songTime();
      setNow(t);
      if (t > end + 0.15) {
        if (tapCount.current) setPhase("done");
        else {
          setPhase("idle");
          setHint("No taps — tap the pad once per syllable while the bar plays.");
        }
      }
    }, 40);
    return () => clearInterval(id);
  }, [phase, songTime, end]);

  // the taps on the grid: 16th notes, a tap on a beat = stressed
  const cells = new Array(win.cells.length).fill(0) as (0 | 1 | 2)[];
  for (const t of taps) {
    let k = Math.max(0, Math.min(cells.length - 1, Math.round((t - win.start) / win.step)));
    // two quick taps on one 16th: no tap gets lost — the later one takes the next free step
    while (k < cells.length - 1 && cells[k]) k++;
    if (cells[k]) continue;
    cells[k] = k % STEPS_PER_BEAT === 0 ? 2 : 1;
  }
  const result = flowFromGrid({ ...win, cells }, flow);
  const example = exampleWords(result.syllables, result.stress, lang, seed);
  const counting = now < win.start - win.step / 2;
  const progress = Math.max(0, Math.min(1, (now - win.start) / (end - win.start)));
  const beatsLeft = Math.ceil((win.start - now) / (win.step * STEPS_PER_BEAT));

  const tap = () => {
    const t = songTime();
    if (t < win.start - win.step * 0.75 || t > end) return; // the count-in and after the bar don't count
    tapCount.current += 1;
    setTaps((x) => [...x, t]);
    navigator.vibrate?.(8);
  };

  return (
    <div className="mt-3 rounded-2xl bg-panel-2/70 p-3">
      {phase === "idle" && (
        <>
          <p className="text-sm">
            Tap the rhythm of this line: <b>one tap per syllable</b> while the beat plays. You get one bar to count in.
          </p>
          {hint && <p className="mt-1 text-xs text-warn">{hint}</p>}
          <div className="mt-3 flex gap-2">
            <button
              className="btn-primary flex-1 justify-center rounded-xl py-3 text-[15px]"
              onClick={() => {
                setTaps([]);
                tapCount.current = 0;
                setHint(null);
                setNow(win.start - 2);
                setPhase("running");
                onStart();
              }}
            >
              <Hand className="h-5 w-5" /> Start
            </button>
            <button className="btn justify-center rounded-xl border-0 bg-panel px-4" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}

      {phase === "running" && (
        <button
          className={`flex h-44 w-full touch-manipulation select-none flex-col items-center justify-center gap-2 rounded-2xl text-white transition-colors ${counting ? "bg-fg/80" : "bg-accent active:bg-accent/80"}`}
          onPointerDown={(e) => {
            e.preventDefault();
            tap();
          }}
        >
          {counting ? (
            <>
              <span className="text-5xl font-extrabold tabular-nums">{Math.max(1, beatsLeft)}</span>
              <span className="text-sm opacity-80">get ready…</span>
            </>
          ) : (
            <>
              <Hand className="h-10 w-10" />
              <span className="text-lg font-bold">Tap!</span>
              <span className="text-sm tabular-nums opacity-90">
                {taps.length} syllable{taps.length === 1 ? "" : "s"}
              </span>
            </>
          )}
          <span className="mt-1 h-1.5 w-3/4 overflow-hidden rounded-full bg-white/25">
            <span className="block h-full bg-white" style={{ width: `${progress * 100}%` }} />
          </span>
        </button>
      )}

      {phase === "done" && (
        <>
          <p className="text-xs font-semibold text-muted">
            {result.syllables} syllables · for example:
          </p>
          <p className="mt-1 text-[17px] font-medium italic leading-snug">“{example}”</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button className="btn justify-center rounded-xl border-0 bg-panel py-2.5" onClick={() => setPhase("idle")}>
              <Hand className="h-4 w-4" /> Again
            </button>
            <button className="btn justify-center rounded-xl border-0 bg-panel py-2.5" onClick={() => setSeed((s) => s + 1)}>
              <Shuffle className="h-4 w-4" /> Other example
            </button>
            <button className="btn justify-center rounded-xl border-0 bg-panel py-2.5" onClick={() => onSave(result, false)}>
              <Check className="h-4 w-4" /> Save
            </button>
            <button className="btn-primary justify-center rounded-xl py-2.5" onClick={() => onSave(result, true)} title="Save the flow and write 3 lyrics options for it">
              <Sparkles className="h-4 w-4" /> Write · 1 call
            </button>
          </div>
        </>
      )}
    </div>
  );
}
