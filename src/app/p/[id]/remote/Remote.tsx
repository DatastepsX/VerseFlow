"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { lastTake, type RemoteCmd, type RemoteState } from "@/lib/studio/remote";
import type { ProjectTree } from "@/lib/types";

/**
 * Phone remote for the studio running on the Mac (which owns the sound card
 * and the microphone): pick the section and layer, record, retake, discard,
 * keep, play — while the lyrics follow the beat.
 */
export function Remote({ initialTree }: { initialTree: ProjectTree }) {
  const [tree, setTree] = useState(initialTree);
  const pid = tree.project.id;
  const [studio, setStudio] = useState<RemoteState | null>(null);
  const [age, setAge] = useState<number | null>(null);
  const [lane, setLane] = useState<string>("Lead");
  const [sending, setSending] = useState<string | null>(null);
  const [newLane, setNewLane] = useState<string | null>(null);

  // the studio's state: long-polling, answers as soon as it changes
  useEffect(() => {
    let alive = true;
    let after = 0;
    (async () => {
      while (alive) {
        try {
          const r = (await fetch(`/api/projects/${pid}/remote?state&after=${after}`).then((x) => x.json())) as {
            state: RemoteState | null;
            at: number;
            age: number | null;
          };
          if (!alive) break;
          if (r.state && r.at > after) {
            after = r.at;
            setStudio(r.state);
          }
          setAge(r.age);
        } catch {
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
    })();
    // between answers the studio's last sign of life gets older (it re-sends every 3 s while open)
    const tick = setInterval(() => setAge((a) => (a === null ? a : a + 1000)), 1000);
    return () => {
      alive = false;
      clearInterval(tick);
    };
  }, [pid]);

  // lyrics: refresh now and then (they rarely change while recording)
  useEffect(() => {
    const id = setInterval(async () => {
      const t = (await fetch(`/api/projects/${pid}`).then((r) => r.json()).catch(() => null)) as ProjectTree | null;
      if (t?.project) setTree(t);
    }, 30_000);
    return () => clearInterval(id);
  }, [pid]);

  const send = useCallback(
    async (cmd: RemoteCmd, label: string) => {
      setSending(label);
      try {
        await fetch(`/api/projects/${pid}/remote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd }) });
      } finally {
        setTimeout(() => setSending((s) => (s === label ? null : s)), 900);
      }
    },
    [pid],
  );

  const connected = studio !== null && age !== null && age < 9000;
  const lanes = studio?.lanes?.length ? studio.lanes : ["Lead", "Double", "Ad-libs"];
  const curLane = lanes.includes(lane) ? lane : lanes[0];
  const sections = studio?.sections ?? [];
  const si = sections.findIndex((s) => s.id === studio?.sectionId);
  const section = tree.sections.find((s) => s.id === studio?.sectionId);
  const takes = (studio?.takes ?? []).filter((t) => t.lane === curLane).sort((a, b) => a.take_no - b.take_no);
  const last = studio ? lastTake(studio.takes, curLane) : null;
  const idle = studio?.status === "idle";
  const rec = studio?.status === "recording" || studio?.status === "countin";
  const lyrics = section?.lines.filter((l) => l.kind === "lyric" && l.text.trim() && l.status !== "DECLINED") ?? [];
  const canRecord = connected && !!studio?.armed && !!studio?.beatReady && idle && !!studio?.sectionId;

  const statusText = !studio
    ? ""
    : studio.status === "countin"
      ? `Count-in… ${studio.statusLane ?? ""}`
      : studio.status === "recording"
        ? `● REC ${studio.statusLane ?? ""} · ${studio.statusLabel}`
        : studio.status === "playing"
          ? `▶ ${studio.statusLabel || "Playing"}`
          : studio.status === "saving"
            ? `Saving ${studio.statusLane ?? ""} take…`
            : studio.status === "calibrating"
              ? "Calibrating…"
              : "Ready";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#0b0b0d] text-[#e8e8e8]">
      {/* connection */}
      <header className="flex shrink-0 items-center gap-2 border-b border-[#222] px-3 py-2 text-sm">
        <Link href={`/p/${pid}`} className="text-[#8b7bff]">
          ←
        </Link>
        <strong className="min-w-0 flex-1 truncate">{tree.project.title}</strong>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            !connected ? "bg-[#3b1111] text-[#fca5a5]" : studio?.armed ? "bg-[#0f2e1a] text-[#4ade80]" : "bg-[#2e2408] text-[#fbbf24]"
          }`}
        >
          {!connected ? "Mac studio not open" : studio?.armed ? "● Mac studio ready" : "Mac: click Arm"}
        </span>
      </header>
      {!connected && (
        <p className="shrink-0 bg-[#1a1408] px-3 py-2 text-xs text-[#fbbf24]">
          On the Mac, open this song → 🎚 Studio and click “Arm studio”. Keep that window open — this phone then controls it.
        </p>
      )}
      {studio?.error && connected && <p className="shrink-0 bg-[#3b1111] px-3 py-1.5 text-xs text-[#fca5a5]">{studio.error}</p>}

      {/* section */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[#222] px-3 py-2">
        <button
          className="h-11 w-11 shrink-0 rounded-lg bg-[#1a1a1f] text-lg disabled:opacity-30"
          disabled={!idle || si <= 0}
          onClick={() => void send({ t: "select", sectionId: sections[si - 1].id }, "prev")}
          aria-label="Previous section"
        >
          ◀
        </button>
        <select
          className="h-11 min-w-0 flex-1 rounded-lg bg-[#1a1a1f] px-2 text-center text-base font-bold uppercase tracking-wide"
          value={studio?.sectionId ?? ""}
          disabled={!idle}
          onChange={(e) => void send({ t: "select", sectionId: e.target.value }, "section")}
        >
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.takes ? ` (${s.takes})` : ""}
            </option>
          ))}
        </select>
        <button
          className="h-11 w-11 shrink-0 rounded-lg bg-[#1a1a1f] text-lg disabled:opacity-30"
          disabled={!idle || si < 0 || si >= sections.length - 1}
          onClick={() => void send({ t: "select", sectionId: sections[si + 1].id }, "next")}
          aria-label="Next section"
        >
          ▶
        </button>
      </div>

      {/* lyrics following the beat */}
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[22px] leading-snug">
        {lyrics.length === 0 && <p className="text-base text-[#666]">No lyrics in this section.</p>}
        {lyrics.map((l) => {
          const k = section!.lines.indexOf(l);
          const live = studio?.lineIndex === k;
          return (
            <div key={l.id} className={`rounded px-2 py-0.5 ${live ? "bg-[#6d4aff]/35 text-white" : studio?.lineIndex !== null && studio?.lineIndex !== undefined ? "text-[#777]" : ""}`}>
              {l.text}
            </div>
          );
        })}
      </div>

      {/* status */}
      <div className={`shrink-0 px-3 py-1.5 text-center text-sm font-semibold ${rec ? "bg-[#dc2626] text-white" : "bg-[#141418] text-[#ccc]"}`}>
        {sending && idle ? `Sending ${sending}…` : statusText}
      </div>

      {/* layers + takes */}
      <div className="shrink-0 space-y-2 border-t border-[#222] bg-[#111114] px-3 py-2">
        <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {lanes.map((l) => (
            <button
              key={l}
              className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold ${l === curLane ? "bg-[#6d4aff] text-white" : "bg-[#1a1a1f] text-[#ccc]"}`}
              onClick={() => setLane(l)}
            >
              {l}
              <span className="ml-1 font-normal opacity-70">{(studio?.takes ?? []).filter((t) => t.lane === l).length || ""}</span>
            </button>
          ))}
          {newLane === null ? (
            <button className="shrink-0 rounded-full bg-[#1a1a1f] px-3 py-1.5 text-sm text-[#aaa]" onClick={() => setNewLane("")}>
              + Layer
            </button>
          ) : (
            <form
              className="flex shrink-0 gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (newLane.trim()) {
                  void send({ t: "addLane", name: newLane.trim() }, "layer");
                  setLane(newLane.trim());
                }
                setNewLane(null);
              }}
            >
              <input autoFocus className="w-28 rounded-full bg-[#1a1a1f] px-3 py-1.5 text-base" placeholder="Double 2" value={newLane} onChange={(e) => setNewLane(e.target.value)} />
              <button className="rounded-full bg-[#6d4aff] px-3 text-sm font-semibold">OK</button>
            </form>
          )}
        </div>
        <div className="flex min-h-9 gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {takes.length === 0 && <span className="self-center text-xs text-[#555]">No {curLane} takes in this section yet</span>}
          {takes.map((t) => (
            <span key={t.id} className={`flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-sm ${t.chosen ? "border-[#6d4aff] bg-[#6d4aff]/20" : "border-[#2a2a30]"}`}>
              <button disabled={!idle} onClick={() => void send({ t: "playTake", takeId: t.id }, "play take")} className="disabled:opacity-40">
                ▶ {t.take_no}
              </button>
              <button className={t.chosen ? "text-[#facc15]" : "text-[#666]"} onClick={() => void send({ t: "choose", takeId: t.id }, "keep")} aria-label="Use this take">
                ★
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* transport */}
      <div className="grid shrink-0 grid-cols-4 gap-2 border-t border-[#222] bg-[#0b0b0d] px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {idle || !connected ? (
          <button
            className="col-span-3 h-16 rounded-xl bg-[#dc2626] text-xl font-bold text-white disabled:opacity-40"
            disabled={!canRecord}
            onClick={() => void send({ t: "record", lane: curLane }, "record")}
          >
            ● REC {curLane}
          </button>
        ) : (
          <button className="col-span-3 h-16 rounded-xl bg-[#e8e8e8] text-xl font-bold text-black" onClick={() => void send({ t: "stop" }, "stop")}>
            ■ STOP
          </button>
        )}
        <button
          className="h-16 rounded-xl bg-[#1a1a1f] text-lg font-semibold disabled:opacity-40"
          disabled={!connected || !idle || !studio?.beatReady}
          onClick={() => void send({ t: "play" }, "play")}
        >
          ▶
        </button>
        <button
          className="h-12 rounded-xl bg-[#1a1a1f] text-sm font-semibold disabled:opacity-40"
          disabled={!connected || !studio?.armed || !last || studio?.status === "saving"}
          onClick={() => void send({ t: "retake", lane: curLane }, "retake")}
          title="Delete the last take and record it again"
        >
          ↻ Retake
        </button>
        <button
          className="h-12 rounded-xl bg-[#1a1a1f] text-sm font-semibold text-[#fca5a5] disabled:opacity-40"
          disabled={!connected || !idle || !last}
          onClick={() => {
            if (window.confirm(`Delete ${curLane} take ${last?.take_no}?`)) void send({ t: "discardLast", lane: curLane }, "discard");
          }}
        >
          ✕ Discard
        </button>
        <button
          className="h-12 rounded-xl bg-[#1a1a1f] text-sm font-semibold text-[#facc15] disabled:opacity-40"
          disabled={!connected || !last || last.chosen}
          onClick={() => last && void send({ t: "choose", takeId: last.id }, "keep")}
          title="Use the last take"
        >
          ★ Keep
        </button>
        <select
          className="h-12 rounded-xl bg-[#1a1a1f] px-1 text-center text-xs"
          value={studio?.countIn ?? 1}
          disabled={!connected || !idle}
          onChange={(e) => void send({ t: "countIn", bars: Number(e.target.value) }, "count-in")}
          aria-label="Count-in"
        >
          {[0, 1, 2].map((n) => (
            <option key={n} value={n}>
              Count-in {n}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
