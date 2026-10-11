"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { LyricsPlan } from "@/lib/audio/lyrics";
import { fmtTime } from "@/lib/audio/song-map";
import { useWriter } from "./context";

interface Status {
  configured: boolean;
  transcript: { created_at: string; words: number } | null;
}

/**
 * Read the vocals of the uploaded beat (1 ElevenLabs call), preview how the
 * lyrics map onto sections and bars, then fill only the free bars.
 */
export function LyricsDialog({ onClose }: { onClose: () => void }) {
  const w = useWriter();
  const pid = w.tree.project.id;
  const hasAnchors = w.tree.sections.some((s) => s.audio_start !== null);
  const [status, setStatus] = useState<Status | null>(null);
  const [plan, setPlan] = useState<LyricsPlan | null>(null);
  const [auto, setAuto] = useState(!hasAnchors);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async (action: "transcribe" | "plan", autoSections: boolean) => {
      setBusy(action === "transcribe" ? "Listening to the vocals… (this can take up to a minute)" : "Mapping lyrics…");
      setError(null);
      try {
        const res = await fetch(`/api/projects/${pid}/lyrics`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, autoSections }),
        });
        const data = (await res.json()) as { plan?: LyricsPlan; error?: string };
        if (!res.ok || !data.plan) throw new Error(data.error ?? "Something went wrong");
        setPlan(data.plan);
        if (action === "transcribe") setStatus((s) => (s ? { ...s, transcript: { created_at: new Date().toISOString(), words: 0 } } : s));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [pid],
  );

  useEffect(() => {
    fetch(`/api/projects/${pid}/lyrics`)
      .then((r) => r.json())
      .then((s: Status) => {
        setStatus(s);
        if (s.transcript) void call("plan", !hasAnchors);
      })
      .catch(() => setError("Could not load the lyrics status."));
  }, [pid, call, hasAnchors]);

  const apply = async () => {
    setBusy("Writing the lyrics into your sections…");
    const res = await w.mutate(`/api/projects/${pid}/lyrics`, { action: "apply", autoSections: auto });
    setBusy(null);
    if (res) onClose();
  };

  const toggleAuto = (v: boolean) => {
    setAuto(v);
    if (status?.transcript) void call("plan", v);
  };

  // portal: the player bar's backdrop blur would otherwise trap this fixed overlay
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-3 sm:p-8" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl border border-line bg-panel p-4 sm:p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Lyrics from the beat</h2>
            <p className="text-xs text-muted">
              Reads the recorded vocals, splits them into lines per bar and fills only the bars you haven&apos;t written yet. Imported
              lines are marked <em>Suggested</em> so you can approve or edit them.
            </p>
          </div>
          <button className="btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        {status && !status.configured && !status.transcript && (
          <p className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
            Lyrics reading needs an ElevenLabs API key: add <code>ELEVENLABS_API_KEY</code> in Vercel → Settings → Environment Variables and
            redeploy.
          </p>
        )}

        {(status?.configured || status?.transcript) && (
          <div className="flex flex-wrap items-center gap-2">
            {status.configured && (
              <button className={status.transcript ? "btn" : "btn-primary"} disabled={!!busy} onClick={() => void call("transcribe", auto)}>
                🎤 {status.transcript ? "Re-read the song" : "Read the lyrics"} · 1 call
              </button>
            )}
            {status.transcript && (
              <span className="text-xs text-muted">last read {new Date(status.transcript.created_at).toLocaleString()} — previews and applying are free</span>
            )}
          </div>
        )}

        {!hasAnchors && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={auto} onChange={(e) => toggleAuto(e.target.checked)} />
            Detect sections (intro, verses, chorus/hook, outro) and anchor them on the beat
          </label>
        )}
        {hasAnchors && (
          <p className="mt-3 text-xs text-muted">Using your anchored sections. Vocals before the first anchor are skipped.</p>
        )}

        {busy && <p className="mt-3 text-sm text-muted">{busy}</p>}
        {error && <p className="mt-3 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}

        {plan && !busy && (
          <div className="mt-4 space-y-3">
            <p className="text-sm">
              <strong>{plan.filled}</strong> lines to import · {plan.kept} of your lines kept
              {plan.unplaced ? ` · ${plan.unplaced} words outside your sections` : ""}
            </p>
            <div className="max-h-[50vh] space-y-3 overflow-auto rounded-md border border-line p-3">
              {plan.sections.map((s, i) => (
                <div key={i}>
                  <div className="text-xs font-bold uppercase tracking-wide text-accent">
                    {s.name} <span className="font-normal text-muted">· {fmtTime(s.start)}{s.id ? "" : " · new section"}</span>
                  </div>
                  {s.lines.length === 0 && <p className="text-xs italic text-muted">instrumental</p>}
                  {s.lines.map((l) => (
                    <div key={l.index} className={`flex gap-2 text-sm ${l.action === "keep" ? "text-muted" : ""}`}>
                      <span className="w-5 text-right font-mono text-[11px] text-muted">{l.index + 1}</span>
                      <span className="w-4 text-xs">{l.action === "keep" ? "✓" : l.text ? "+" : ""}</span>
                      <span className={l.text ? "" : "italic text-muted"}>{l.text || "(no vocals in this bar)"}</span>
                    </div>
                  ))}
                </div>
              ))}
              {plan.sections.length === 0 && <p className="text-sm text-muted">No section to fill — anchor sections on the beat or enable detection.</p>}
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn-primary" disabled={!plan.filled && !plan.sections.some((s) => !s.id)} onClick={() => void apply()}>
                Apply to free bars
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
