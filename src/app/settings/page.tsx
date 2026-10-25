"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Headphones, Mic } from "@/components/icons";
import { ElevenAccount } from "@/components/ElevenAccount";
import { ThemePicker } from "@/components/ThemePicker";
import { deviceKind, loadProfile, onProfile } from "@/lib/client/profile";
import { usePref } from "@/lib/client/usePref";
import { StudioEngine } from "@/lib/studio/engine";
import { LANGUAGES } from "@/lib/types";
import { VoiceSheet, type VoiceInfo } from "../song/[id]/VoiceSheet";

const seg = (on: boolean) => `flex-1 rounded-full py-2 text-sm font-semibold transition-colors ${on ? "bg-panel text-fg shadow-sm" : "text-muted"}`;
const card = "space-y-3 rounded-3xl bg-panel px-4 py-4 ring-1 ring-line/60";

/**
 * Your settings — the same in every song and on every device (kept with your profile): recording, the timing
 * for each kind of device, your voice, the ElevenLabs account, appearance.
 */
export default function Settings() {
  const engine = useRef<StudioEngine | null>(null);
  useEffect(() => {
    const e = new StudioEngine();
    engine.current = e;
    return () => e.close();
  }, []);

  // where you record and play
  const [main, setMain] = usePref<"phone" | "mac">("vf.studio.main", "phone");
  // recording
  const [countIn, setCountIn] = usePref("vf.studio.countin", 1);
  const [metronome, setMetronome] = usePref("vf.studio.metronome", true);
  const [size, setSize] = usePref<"S" | "M" | "L">("vf.rec.size", "M");
  const [headphones, setHeadphones] = usePref("vf.studio.headphones", true);

  // timing: this device's, set here; the others' as they are
  const kind = deviceKind();
  const [raw, setRaw] = usePref<number | null>(`vf.studio.latency.${kind}`, null);
  const [vp, setVp] = usePref<number | null>(`vf.studio.latency.vp.${kind}`, null);
  const [all, setAll] = useState<Record<string, unknown>>({});
  useEffect(() => {
    void loadProfile().then((p) => setAll({ ...p }));
    return onProfile((k, v) => setAll((a) => ({ ...a, [k]: v })));
  }, []);
  const timings = Object.entries(all)
    .map(([k, v]) => ({ m: /^vf\.studio\.latency(\.vp)?\.([A-Za-z]+)$/.exec(k), v }))
    .filter((x): x is { m: RegExpExecArray; v: number } => !!x.m && typeof x.v === "number" && x.m[2] !== kind);
  const others = [...new Set(timings.map((x) => x.m[2]))];
  const [measuring, setMeasuring] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const clapAlong = async () => {
    const e = engine.current;
    if (!e) return;
    setMeasuring(true);
    setNote(null);
    try {
      await e.ctx.resume();
      if (!e.armed) await e.arm(undefined, { voiceProcessing: !headphones });
      const r = await e.calibrateClaps(0);
      if (!r) setNote("The claps weren't clear — clap (or say “ta”) right on each of the 8 clicks after the 4 count-in clicks, close to the microphone, and try again.");
      else {
        const ms = Math.round(Math.max(0, r.delay) * 1000 * 10) / 10;
        (headphones ? setRaw : setVp)(ms);
        setNote(`${ms} ms — kept for ${kind} ${headphones ? "with" : "without"} headphones.`);
      }
    } catch (err) {
      setNote(err instanceof Error ? `Microphone: ${err.message}` : "The microphone is not available.");
    } finally {
      e.disarm();
      setMeasuring(false);
    }
  };

  // your voice
  const [voice, setVoice] = useState<VoiceInfo | null | undefined>(undefined);
  const [voiceSheet, setVoiceSheet] = useState(false);
  const [lang, setLang] = useState("it");
  useEffect(() => {
    fetch("/api/voice")
      .then((r) => r.json())
      .then((r: { voice: VoiceInfo | null }) => setVoice(r.voice))
      .catch(() => setVoice(null));
  }, []);

  const ms = (v: number | null | undefined) => (typeof v === "number" ? `${v} ms` : "not set");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-5 px-4 pb-16 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-center gap-2">
        <Link href="/" className="flex h-9 w-9 items-center justify-center rounded-full text-muted active:bg-panel-2" aria-label="Back">
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Your settings</h1>
          <p className="text-xs text-muted">The same in every song, on your iPhone and your Mac.</p>
        </div>
      </header>

      <section className="space-y-2">
        <p className="label">Main device</p>
        <div className={card}>
          <div className="flex rounded-full bg-panel-2 p-1">
            {(
              [
                ["phone", "My iPhone"],
                ["mac", "My Mac"],
              ] as const
            ).map(([v, label]) => (
              <button key={v} className={seg(main === v)} onClick={() => setMain(v)}>
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">
            {main === "mac"
              ? "The Mac records and plays; your iPhone is the remote: the tab and the part you open on it, and what you play, happen on the Mac. Keep the song open on the Mac."
              : "Your iPhone records and plays by itself."}
          </p>
        </div>
      </section>

      <section className="space-y-2">
        <p className="label">Recording</p>
        <div className={card}>
          <div>
            <p className="mb-1.5 text-sm font-semibold">Count-in</p>
            <div className="flex rounded-full bg-panel-2 p-1">
              {[
                [0, "Off"],
                [1, "1 bar"],
                [2, "2 bars"],
              ].map(([n, label]) => (
                <button key={n} className={seg(countIn === n)} onClick={() => setCountIn(n as number)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <Row label="Click during the count-in" on={metronome} set={setMetronome} />
          <div>
            <p className="mb-1.5 text-sm font-semibold">Lyrics size while recording</p>
            <div className="flex rounded-full bg-panel-2 p-1">
              {(["S", "M", "L"] as const).map((k) => (
                <button key={k} className={seg(size === k)} onClick={() => setSize(k)}>
                  {k === "S" ? "Small" : k === "M" ? "Medium" : "Large"}
                </button>
              ))}
            </div>
          </div>
          <Row
            label="I wear headphones"
            sub={headphones ? "Clean takes, no processing." : "The beat from the speaker is filtered out of the take."}
            on={headphones}
            set={setHeadphones}
            icon
          />
          <p className="text-xs text-muted">The microphone itself is chosen in Record → Settings on each device.</p>
        </div>
      </section>

      <section className="space-y-2">
        <p className="label">Timing</p>
        <div className={card}>
          <p className="text-sm">
            <b>This {kind}</b>
            <span className="mt-1 flex justify-between text-sm">
              <span className="text-muted">with headphones</span>
              <span className="font-mono">{ms(raw)}</span>
            </span>
            <span className="flex justify-between text-sm">
              <span className="text-muted">without headphones</span>
              <span className="font-mono">{ms(vp)}</span>
            </span>
          </p>
          <button className="btn-primary w-full justify-center rounded-xl py-2.5 text-sm disabled:opacity-50" disabled={measuring} onClick={() => void clapAlong()}>
            <Mic className="h-4 w-4" />
            {measuring ? "Clap on each click…" : `Clap along · ${headphones ? "with" : "without"} headphones`}
          </button>
          <p className="text-xs text-muted">
            4 clicks to count in, then clap (or say “ta”) right on the next 8, close to the microphone. Switch “I wear headphones” above to set the other one.
          </p>
          {note && <p className="rounded-xl bg-panel-2 px-3 py-2 text-sm">{note}</p>}
          {(raw !== null || vp !== null) && (
            <button
              className="text-xs text-muted underline"
              onClick={() => {
                setRaw(null);
                setVp(null);
              }}
            >
              Use the estimate again on this {kind}
            </button>
          )}
          {others.length > 0 && (
            <div className="border-t border-line/60 pt-2 text-sm">
              {others.map((o) => (
                <p key={o} className="flex justify-between">
                  <span className="text-muted">{o}</span>
                  <span className="font-mono text-xs">
                    {ms(all[`vf.studio.latency.${o}`] as number | undefined)} · {ms(all[`vf.studio.latency.vp.${o}`] as number | undefined)} without
                  </span>
                </p>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <p className="label">Your voice</p>
        <div className={card}>
          <p className="text-sm">
            {voice === undefined ? "…" : voice ? (
              <>
                <b>{voice.name}</b>
                <span className="block text-xs text-muted">Made {new Date(voice.created_at).toLocaleDateString()} — it speaks your lyrics on your flow (Hear).</span>
              </>
            ) : (
              <span className="text-muted">No voice yet: record about a minute, and ElevenLabs makes a copy of it (1 call).</span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <select className="input w-auto py-2 text-sm" value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language of the text to read">
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <button className="btn flex-1 justify-center rounded-xl py-2.5 text-sm" onClick={() => setVoiceSheet(true)}>
              {voice ? "Make it again" : "Make your voice"}
            </button>
          </div>
        </div>
      </section>

      <ElevenAccount />

      <section className="space-y-2">
        <p className="label">Appearance</p>
        <ThemePicker />
      </section>

      {voiceSheet && (
        <VoiceSheet
          engine={engine}
          lang={lang}
          current={voice ?? null}
          onClose={() => setVoiceSheet(false)}
          onDone={(v) => {
            setVoice(v);
            setVoiceSheet(false);
          }}
        />
      )}
    </main>
  );
}

function Row({ label, sub, on, set, icon }: { label: string; sub?: string; on: boolean; set: (on: boolean) => void; icon?: boolean }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="flex items-center gap-2">
        {icon && <Headphones className="h-4 w-4 text-muted" />}
        <span>
          {label}
          {sub && <span className="block text-xs text-muted">{sub}</span>}
        </span>
      </span>
      <button
        role="switch"
        aria-checked={on}
        onClick={(e) => {
          e.preventDefault();
          set(!on);
        }}
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-line"}`}
      >
        <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
      </button>
    </label>
  );
}
