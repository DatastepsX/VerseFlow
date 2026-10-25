"use client";

import { useEffect, useRef, useState } from "react";
import { barsPerLine, chipsOf, lineCuts, lineFromText, linesFromBreaks, linesFromOnsets, ownWords, relayout, type Onset } from "@/lib/flow/pattern";
import { quantizeTaps } from "@/lib/flow/grid";
import type { FlowPattern, PatternLine, SongFlow } from "@/lib/types";
import { Check, Hand, LineBreak, Mic, Pencil, Play, Restart, Sparkles } from "@/components/icons";

type Mode = "write" | "sing" | "tap" | "both";

export interface SheetAudio {
  /** the beat is loaded (until then nothing can be sung or tapped over it) */
  ready: boolean;
  /** plays the beat from `from` to `until` with clicks (no recorded voices) — with `voice`: and what was just sung */
  play: (from: number, until: number, clicks: { at: number; accent: boolean }[], voice?: boolean) => void;
  stop: () => void;
  /** the song time being heard now */
  songTime: () => number;
  armMic: () => Promise<void>;
  /** the microphone's level now, 0..1 (singing: it stops when you do) */
  level?: () => number;
  startRec: () => void;
  /** stops recording → where the sung syllables start (song time), how loud they were and how long held */
  stopRec: (keepFrom: number) => Promise<{ t: number; strength: number; dur?: number }[]>;
}

const emptyLine = (): PatternLine => ({ text: "", written: true, syllables: 0, stress: [], long: [], pauses: [], offsets: [] });
const MODE_KEY = "verseflow.flowMode";

/**
 * The flow of a part (or of a stretch of it): 2 or 4 pattern lines — written
 * (the default: the words set the syllables, the chips set stress, long notes
 * and pauses), or sung / tapped over the part's first bars. Always shown as
 * text before it's used; then the whole part (or the stretch) follows it.
 * The song's flows can be picked from the list and reused.
 */
export function FlowSheet({
  title,
  scope,
  flows,
  initialFlowId,
  lang,
  bar,
  barStart,
  linesInStretch,
  audio,
  onUse,
  onClose,
}: {
  /** "Part 2" */
  title: string;
  /** "the whole part" or "from line 5 on" */
  scope: string;
  flows: (SongFlow & { usedIn: string[] })[];
  initialFlowId: string | null;
  lang: string;
  bar: number;
  /** the bar line where the stretch starts: the pattern is sung / tapped / heard there */
  barStart: number;
  /** how many lines the stretch will get with a 1-bar pattern line */
  linesInStretch: number;
  audio: SheetAudio;
  /** use it: an existing flow (unchanged) or a new one */
  onUse: (use: { flowId: string } | { pattern: FlowPattern }) => Promise<void>;
  onClose: () => void;
}) {
  const initial = flows.find((f) => f.id === initialFlowId) ?? null;
  const [mode, setMode] = useState<Mode>(() => {
    try {
      return (localStorage.getItem(MODE_KEY) as Mode) || "write";
    } catch {
      return "write";
    }
  });
  const [picked, setPicked] = useState<string | null>(initial?.id ?? null);
  const [lines, setLines] = useState<PatternLine[]>(() => initial?.pattern.lines.map((l) => ({ ...l })) ?? [emptyLine(), emptyLine()]);
  const [scheme, setScheme] = useState<FlowPattern["scheme"]>(initial?.pattern.scheme ?? "AABB");
  const [changed, setChanged] = useState(false);
  const [phase, setPhase] = useState<"idle" | "running">("idle");
  const [now, setNow] = useState(0);
  const [taps, setTaps] = useState(0);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const tapsRef = useRef<number[]>([]);
  /** "Next line": when it was tapped, and how many syllables were tapped by then */
  const breaksRef = useRef<{ t: number; taps: number }[]>([]);
  const [breaks, setBreaks] = useState(0);
  /** a take was sung / tapped: the button does it again */
  const [recorded, setRecorded] = useState(false);
  const seed = useRef(0);
  const p = lines.length;
  const end = barStart + p * bar;
  /** with "Next line" a line can be longer than a bar: it may take up to two each (sung: three — it stops when you do) */
  const limit = barStart + (mode === "tap" ? 2 : 3) * p * bar;

  const pickMode = (m: Mode) => {
    setMode(m);
    setRecorded(false);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {}
  };
  const edit = (next: PatternLine[]) => {
    setLines(next);
    setChanged(true);
  };
  const setCount = (n: 2 | 4) => {
    if (n === p) return;
    edit(n === 4 ? [...lines, emptyLine(), emptyLine()] : lines.slice(0, 2));
  };

  // recording / tapping: count-in bar, then the pattern's bars; over → the lines
  const finish = useRef<(() => Promise<void>) | null>(null);
  /** where the syllables of the last take were found (song time) */
  const sungAt = useRef<number[]>([]);
  /** the lines as the last take made them (an edit makes new ones) */
  const fromTake = useRef<PatternLine[] | null>(null);
  /** singing: the loudest level so far and when the voice was last heard */
  const peak = useRef(0);
  const lastVoice = useRef(0);
  const audioRef = useRef(audio);
  useEffect(() => {
    audioRef.current = audio;
  });
  useEffect(() => {
    if (phase !== "running") return;
    const id = setInterval(() => {
      const t = audioRef.current.songTime();
      setNow(t);
      const br = breaksRef.current;
      // singing without "Next line": on until you stop singing (a bar of quiet after the pattern's bars), at most
      // twice as long — a sung line is often longer than its bar
      if (mode !== "tap" && !br.length) {
        const lvl = audioRef.current.level?.() ?? 0;
        peak.current = Math.max(peak.current * 0.999, lvl);
        if (lvl > Math.max(0.01, 0.12 * peak.current)) lastVoice.current = t;
        // two bars of quiet after the last sound: the take is over (a breath or a rest between lines is shorter)
        if (t > limit || (t > end && t - Math.max(lastVoice.current, end - bar) > 2 * bar)) void finish.current?.();
        return;
      }
      // no "Next line": a line per bar, over after the last bar
      if (!br.length) {
        if (t > end + 0.15) void finish.current?.();
        return;
      }
      // the last line: over when it rests a bar (tapping) or after two (singing) — or at the latest
      const lastTap = tapsRef.current[tapsRef.current.length - 1] ?? 0;
      const lastStart = br[br.length - 1].t;
      const rest = mode === "sing" ? t > lastStart + 2 * bar : lastTap > lastStart && t > lastTap + bar;
      if (t > limit || (br.length >= p - 1 && t > end && rest)) void finish.current?.();
    }, 40);
    return () => clearInterval(id);
  }, [phase, end, limit, p, bar, mode]);

  const start = async () => {
    setHint(null);
    tapsRef.current = [];
    setTaps(0);
    peak.current = 0;
    lastVoice.current = 0;
    breaksRef.current = [];
    setBreaks(0);
    finishing.current = false;
    try {
      if (mode !== "tap") await audio.armMic();
    } catch (err) {
      setHint(err instanceof Error ? `Microphone: ${err.message}` : "The microphone is not available.");
      return;
    }
    const from = barStart - bar;
    const clicks = [0, 1, 2, 3].map((k) => ({ at: from + (k * bar) / 4, accent: k === 0 })).filter((c) => c.at >= 0);
    audio.play(Math.max(0, from), limit + 0.3, clicks);
    if (mode !== "tap") audio.startRec();
    setNow(from);
    setPhase("running");
  };
  const finishing = useRef(false);
  useEffect(() => {
    finish.current = async () => {
      // once (the clock and "Done" can both end it)
      if (finishing.current) return;
      finishing.current = true;
      setPhase("idle");
      const voice = mode !== "tap" ? await audio.stopRec(Math.max(0, barStart - 0.4)) : [];
      audio.stop();
      let onsets: Onset[];
      if (mode === "sing") onsets = voice;
      else {
        // taps count the syllables; with the voice, each moves onto the syllable sung there
        const used = new Set<number>();
        const refined = tapsRef.current.map((t) => {
          let best = -1;
          voice.forEach((v, k) => {
            if (!used.has(k) && Math.abs(v.t - t) <= 0.12 && (best < 0 || Math.abs(v.t - t) < Math.abs(voice[best].t - t))) best = k;
          });
          if (best >= 0) used.add(best);
          return best >= 0 ? { t: voice[best].t, strength: voice[best].strength, dur: voice[best].dur } : { t, strength: null, dur: null };
        });
        const q = quantizeTaps(
          refined.map((x) => x.t),
          { bpm: 240 / bar, beat_offset: barStart, beats_per_bar: 4 },
        );
        onsets = q.map((x, i) => ({ t: x.t, strength: refined[i]?.strength ?? null, dur: refined[i]?.dur ?? null }));
      }
      // "Next line" splits the lines (else the bar lines do): where the next line's first syllable is
      const br = breaksRef.current;
      // without it, sung: the lines break where the singing rests longest (not at the bar lines)
      const sorted = [...onsets].sort((x, y) => x.t - y.t);
      sungAt.current = sorted.map((o) => o.t);
      const firsts = br.length ? br.map((b) => (mode === "sing" ? onsets.filter((o) => o.t < b.t).length : b.taps)) : mode !== "tap" ? lineCuts(sorted, p) : [];
      const got = firsts.length ? linesFromBreaks(sorted, firsts, barStart, bar, p, lang, seed.current++) : linesFromOnsets(onsets, barStart, bar, p, lang, seed.current++);
      if (got.every((l) => !l.syllables)) {
        setHint(mode === "sing" ? "Nothing was heard — sing a bit louder, or closer to the phone." : "No taps — tap once per syllable while the bars play.");
        return;
      }
      setRecorded(true);
      const missing = got.filter((l) => !l.syllables).length;
      if (br.length && missing) setHint(`${p - missing} of ${p} lines — tap “Next line” after each line (or type the missing one).`);
      fromTake.current = got;
      edit(got);
    };
  });

  const tap = () => {
    const t = audio.songTime();
    if (t < barStart - bar / 16 || t > limit) return;
    tapsRef.current.push(t);
    setTaps(tapsRef.current.length);
    navigator.vibrate?.(8);
  };
  /** the line is done: the next syllable starts the next line (after the last line: done) */
  const nextLine = () => {
    const t = audio.songTime();
    if (t < barStart) return;
    const br = breaksRef.current;
    // a second tap right away, or before any syllable of the new line, changes nothing
    const prev = br[br.length - 1];
    if (prev && (t - prev.t < 0.25 || (mode !== "sing" && prev.taps === tapsRef.current.length))) return;
    br.push({ t, taps: tapsRef.current.length });
    setBreaks(br.length);
    navigator.vibrate?.([6, 40, 6]);
    if (br.length >= p) void finish.current?.();
  };

  const listen = () => {
    const from = barStart - bar;
    // just sung, nothing changed since: your voice, a click on every syllable found in it
    const sung = sungAt.current;
    if (lines === fromTake.current && mode !== "tap" && sung.length) {
      const clicks = sung.map((t) => ({ at: t, accent: false }));
      audio.play(Math.max(0, from), sung[sung.length - 1] + bar / 2, clicks, true);
      return;
    }
    // a line per bar — or per two, when a line is longer than a bar
    const per = barsPerLine({ lines, scheme, bar, source: mode }) * bar;
    const clicks = [
      ...[0, 1, 2, 3].map((k) => ({ at: from + (k * bar) / 4, accent: false })),
      ...lines.flatMap((l, i) => l.offsets.map((o, k) => ({ at: barStart + i * per + o, accent: l.stress.includes(k + 1) }))),
    ].filter((c) => c.at >= 0);
    audio.play(Math.max(0, from), barStart + p * per + 0.4, clicks);
  };

  const ready = lines.every((l) => l.syllables > 0);
  // lines in your own words are kept; the rest (example words, "pa pam") only set the rhythm and get written
  const own = lines.map((l) => ownWords(l, lang, mode));
  const toWrite = Math.max(0, linesInStretch - own.filter(Boolean).length);
  const calls = Math.ceil(toWrite / 8);
  const use = async () => {
    setBusy(true);
    try {
      await onUse(picked && !changed ? { flowId: picked } : { pattern: { lines, scheme: p === 4 ? scheme : "AABB", bar, source: mode } });
    } catch (err) {
      setHint(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  };

  const counting = now < barStart - 0.02;
  const progress = Math.max(0, Math.min(1, (now - barStart) / (end - barStart)));

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={() => phase === "idle" && !busy && onClose()}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[94dvh] w-full max-w-lg space-y-4 overflow-auto rounded-t-3xl bg-panel px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3"
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
        <div>
          <h2 className="text-xl font-bold">Flow · {title}</h2>
          <p className="text-xs text-muted">for {scope}</p>
        </div>

        {/* the song's flows: pick one */}
        {flows.length > 0 && (
          <div>
            <p className="label">Your flows</p>
            <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
              {flows.map((f) => (
                <button
                  key={f.id}
                  onClick={() => {
                    setPicked(f.id);
                    setLines(f.pattern.lines.map((l) => ({ ...l })));
                    setScheme(f.pattern.scheme);
                    setChanged(false);
                  }}
                  className={`w-44 shrink-0 rounded-2xl p-3 text-left ring-1 ${picked === f.id && !changed ? "bg-accent-soft ring-accent" : "bg-panel-2 ring-transparent"}`}
                >
                  <span className="flex items-center justify-between text-sm font-bold">
                    {f.name}
                    <span className="text-[11px] font-medium text-muted">
                      {f.pattern.lines.length} lines{f.pattern.lines.length === 4 ? ` · ${f.pattern.scheme}` : ""}
                    </span>
                  </span>
                  <Dots line={f.pattern.lines[0]} />
                  <span className="mt-1 block truncate text-xs">{f.pattern.lines[0]?.text || "…"}</span>
                  <span className="block truncate text-[10px] text-muted">{f.usedIn.length ? `in ${f.usedIn.join(", ")}` : "not used yet"}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* how to make it */}
        <div className="flex rounded-full bg-panel-2 p-1" role="tablist">
          {(
            [
              ["write", Pencil, "Write"],
              ["sing", Mic, "Sing"],
              ["tap", Hand, "Tap"],
              ["both", Hand, "Sing+tap"],
            ] as const
          ).map(([m, Icon, label]) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={`flex flex-1 items-center justify-center gap-1 rounded-full py-2 text-[13px] font-semibold ${mode === m ? "bg-accent text-white shadow-sm" : "text-muted"}`}
              onClick={() => pickMode(m)}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted">Pattern</span>
          {([2, 4] as const).map((n) => (
            <button key={n} className={`rounded-full px-3 py-1 font-semibold ${p === n ? "bg-fg text-bg" : "bg-panel-2"}`} onClick={() => setCount(n)}>
              {n} lines
            </button>
          ))}
          {p === 4 &&
            (["AABB", "ABAB"] as const).map((sc) => (
              <button
                key={sc}
                className={`rounded-full px-3 py-1 font-mono text-xs font-semibold ${scheme === sc ? "bg-accent-soft text-accent" : "text-muted"}`}
                onClick={() => {
                  setScheme(sc);
                  setChanged(true);
                }}
                title={sc === "AABB" ? "lines 1+2 and 3+4 rhyme" : "lines 1+3 and 2+4 rhyme"}
              >
                {sc}
              </button>
            ))}
        </div>

        {/* sing / tap: the first bars of the part */}
        {mode !== "write" && phase === "idle" && (
          <button
            className={`w-full justify-center rounded-2xl py-3 text-[15px] ${recorded ? "btn border-0 bg-panel-2" : "btn-primary"}`}
            disabled={!audio.ready}
            onClick={() => void start()}
          >
            {recorded ? <Restart className="h-5 w-5" /> : mode === "tap" ? <Hand className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
            {!audio.ready
              ? "Loading the beat…"
              : `${recorded ? "Again: " : ""}${mode === "sing" ? `sing ${p} bars` : mode === "tap" ? `tap ${p} bars` : `sing and tap ${p} bars`}`.replace(/^./, (c) => c.toUpperCase())}
            <span className="text-xs font-normal opacity-80">· 1 bar to count in</span>
          </button>
        )}
        {phase === "running" && (
          <div className="space-y-1.5">
          {/* two pads: "Next line" on the left, the syllables (or the singing) on the right */}
          <div className="flex gap-2.5">
          <button
            className={`flex h-44 flex-[2] touch-manipulation select-none flex-col items-center justify-center gap-2 rounded-3xl text-white ${counting ? "bg-fg/80" : mode === "sing" ? "bg-[#dc2626]" : "bg-accent active:bg-accent/85"}`}
            onPointerDown={(e) => {
              e.preventDefault();
              if (mode !== "sing") tap();
              // singing: a tap on it ends the take (after the count-in)
              else if (!counting) void finish.current?.();
            }}
            aria-label={mode === "sing" ? "Singing" : "Syllable"}
          >
            {counting ? (
              <>
                <span className="text-5xl font-extrabold tabular-nums">{Math.max(1, Math.ceil((barStart - now) / (bar / 4)))}</span>
                <span className="text-sm opacity-80">get ready…</span>
              </>
            ) : (
              <>
                {mode === "sing" ? <Mic className="h-10 w-10" /> : <Hand className="h-10 w-10" />}
                <span className="text-lg font-bold">
                  {mode === "sing" ? "Sing!" : "Tap!"} · {breaks ? `line ${Math.min(p, breaks + 1)} of ${p}` : `bar ${mode === "tap" ? Math.min(p, Math.floor((now - barStart) / bar) + 1) : Math.floor((now - barStart) / bar) + 1}`}
                </span>
                {mode !== "sing" ? <span className="text-sm tabular-nums opacity-90">{taps} syllables</span> : <span className="text-sm opacity-90">tap here when you&apos;re done</span>}
              </>
            )}
            <span className="mt-1 h-1.5 w-3/4 overflow-hidden rounded-full bg-white/25">
              <span className="block h-full bg-white" style={{ width: `${progress * 100}%` }} />
            </span>
          </button>
          <button
            className="order-first flex h-44 flex-1 touch-manipulation select-none flex-col items-center justify-center gap-2 rounded-3xl bg-fg text-bg active:opacity-85 disabled:opacity-40"
            disabled={counting}
            onPointerDown={(e) => {
              e.preventDefault();
              nextLine();
            }}
            aria-label={breaks >= p - 1 ? "Done" : "Next line"}
          >
            {breaks >= p - 1 ? <Check className="h-9 w-9" /> : <LineBreak className="h-9 w-9" />}
            <span className="text-base font-bold leading-tight">{breaks >= p - 1 ? "Done" : <>Next<br />line</>}</span>
          </button>
          </div>
          <p className="text-center text-[11px] text-muted">
            {mode === "tap" ? "“Next line” when a line is done — or leave it: each bar is a line." : "“Next line” when a line is done — or just sing: it stops when you do, the lines break at your longest pauses."}
          </p>
          </div>
        )}

        {/* the pattern lines: always as text, each syllable a chip */}
        <div className="space-y-3">
          {lines.map((l, i) => (
            <div key={i} className="rounded-2xl bg-panel-2/70 p-3">
              <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-muted">
                <span>
                  Line {i + 1}
                  {p === 4 ? ` · ${scheme[i]}` : ` · ${"AA"[i]}`}
                </span>
                <span className="ml-auto">{l.syllables ? `${l.syllables} syllables` : ""}</span>
              </div>
              <input
                className="input border-0 bg-panel text-[17px]"
                value={l.text}
                placeholder={i === 0 ? "Write your line — e.g. Ti scrivo dentro me" : "and the next one…"}
                onChange={(e) => {
                  const text = e.target.value;
                  edit(lines.map((x, k) => (k === i ? (text.trim() ? lineFromText(text, lang, bar, x.syllables ? x : undefined) : { ...emptyLine(), text }) : x)));
                }}
              />
              {l.syllables > 0 && <Chips line={l} lang={lang} onChange={(next) => edit(lines.map((x, k) => (k === i ? next : x)))} bar={bar} />}
              {l.syllables > 0 && l.text.trim() && (
                <p className={`mt-1 text-[11px] ${own[i] ? "text-ok" : "text-muted"}`}>
                  {own[i] ? "Your words — kept as the lyrics." : "Only the rhythm — the lyrics are written for you. Type your own words to keep them."}
                </p>
              )}
            </div>
          ))}
          <p className="text-[11px] text-muted">
            Tap a syllable: stressed · hold it: long note · tap <span className="inline-block rounded bg-panel-2 px-1">+</span> between two: a pause
          </p>
        </div>

        {hint && <p className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn">{hint}</p>}

        <div className="flex gap-2">
          <button className="btn justify-center rounded-2xl border-0 bg-panel-2 px-4 py-3" disabled={!ready || phase !== "idle"} onClick={listen}>
            <Play className="h-4 w-4" /> Listen
          </button>
          <button className="btn-primary flex-1 justify-center rounded-2xl py-3 text-[15px]" disabled={!ready || busy || phase !== "idle"} onClick={() => void use()}>
            {busy ? (
              "Writing…"
            ) : (
              <>
                <Check className="h-4 w-4" /> Use for {scope}
                {calls > 0 && (
                  <span className="flex items-center gap-0.5 text-xs font-normal opacity-80">
                    · <Sparkles className="h-3 w-3" /> {calls} call{calls === 1 ? "" : "s"}
                  </span>
                )}
              </>
            )}
          </button>
        </div>
        <button className="w-full text-center text-sm text-muted" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** a pattern line as dots: stressed tall, long wide */
function Dots({ line }: { line: PatternLine | undefined }) {
  if (!line) return null;
  return (
    <span className="mt-1.5 flex h-3 items-end gap-[2px]">
      {Array.from({ length: line.syllables }, (_, i) => (
        <span
          key={i}
          className={`rounded-full ${line.stress.includes(i + 1) ? "h-3 bg-accent" : "h-1.5 bg-accent/35"} ${line.long.includes(i + 1) ? "w-3" : "w-1.5"}`}
        />
      ))}
    </span>
  );
}

/**
 * The syllables of a pattern line as chips: tap = stressed (or not), hold =
 * long note (or not), the + between two = a pause there (or not).
 */
function Chips({ line, lang, bar, onChange }: { line: PatternLine; lang: string; bar: number; onChange: (l: PatternLine) => void }) {
  const labels = chipsOf(line.text, lang);
  const hold = useRef<{ k: number; timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  const toggle = (arr: number[], k: number) => (arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k].sort((a, b) => a - b));
  return (
    <div className="mt-2 flex flex-wrap items-center gap-y-1.5">
      {Array.from({ length: line.syllables }, (_, i) => {
        const k = i + 1;
        const stressed = line.stress.includes(k);
        const long = line.long.includes(k);
        const pause = line.pauses.includes(k);
        return (
          <span key={i} className="flex items-center">
            <button
              className={`h-9 touch-manipulation select-none rounded-lg px-2 text-[13px] font-semibold transition-colors ${long ? "min-w-14" : "min-w-9"} ${stressed ? "bg-accent text-white" : "bg-panel text-fg/80 ring-1 ring-line"}`}
              onPointerDown={() => {
                const timer = setTimeout(() => {
                  if (hold.current) hold.current.fired = true;
                  navigator.vibrate?.(12);
                  onChange(relayout({ ...line, long: toggle(line.long, k) }, bar));
                }, 450);
                hold.current = { k, timer, fired: false };
              }}
              onPointerUp={() => {
                const h = hold.current;
                if (!h || h.k !== k) return;
                clearTimeout(h.timer);
                hold.current = null;
                if (!h.fired) onChange({ ...line, stress: toggle(line.stress, k) });
              }}
              onPointerLeave={() => {
                if (hold.current?.k === k) {
                  clearTimeout(hold.current.timer);
                  hold.current = null;
                }
              }}
              aria-label={`Syllable ${k}${stressed ? ", stressed" : ""}${long ? ", long" : ""}`}
            >
              {labels[i] ?? "•"}
              {long && <span className="ml-0.5 opacity-70">—</span>}
            </button>
            {i < line.syllables - 1 && (
              <button
                className={`mx-[2px] flex h-9 w-4 items-center justify-center rounded text-[11px] font-bold ${pause ? "bg-warn-soft text-warn" : "text-muted/60"}`}
                onClick={() => onChange(relayout({ ...line, pauses: toggle(line.pauses, k) }, bar))}
                aria-label={pause ? `Pause after syllable ${k} (tap to remove)` : `Add a pause after syllable ${k}`}
              >
                {pause ? "‖" : "+"}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
