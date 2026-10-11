"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ProjectTree } from "@/lib/types";

function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      // restoring a saved preference from browser storage after hydration
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw !== null) setV(JSON.parse(raw) as T);
    } catch {}
  }, [key]);
  return [
    v,
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(key, JSON.stringify(nv));
      } catch {}
    },
  ];
}

export function Recorder({ tree }: { tree: ProjectTree }) {
  const [size, setSize] = usePref("vf.rec.size", 30);
  const [numbers, setNumbers] = usePref("vf.rec.numbers", true);
  const [speed, setSpeed] = usePref("vf.rec.speed", 30);
  const [approvedOnly, setApprovedOnly] = usePref("vf.rec.approvedOnly", false);
  const [playing, setPlaying] = useState(false);
  const [controls, setControls] = useState(true);
  const raf = useRef<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // auto-scroll: speed is pixels per second
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let carry = 0;
    const step = (now: number) => {
      carry += ((now - last) / 1000) * speed;
      last = now;
      if (carry >= 1) {
        window.scrollBy(0, Math.floor(carry));
        carry -= Math.floor(carry);
      }
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 2) setPlaying(false);
      else raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, speed]);

  // controls fade out while performing; any tap/mouse move shows them
  const poke = () => {
    setControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControls(false), 3500);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    hideTimer.current = setTimeout(() => setControls(false), 3500);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  let n = 0;
  return (
    <div className="min-h-dvh bg-[#0b0b0d] text-[#f2f2f2]" onMouseMove={poke} onTouchStart={poke}>
      <div
        className={`fixed inset-x-0 top-0 z-10 flex flex-wrap items-center gap-2 bg-[#0b0b0d]/95 px-3 py-2 text-sm transition-opacity ${controls ? "opacity-100" : "pointer-events-none opacity-0"}`}
      >
        <Link href={`/p/${tree.project.id}`} className="rounded px-2 py-1 text-[#bbb] hover:bg-white/10">
          ← Review
        </Link>
        <span className="mr-auto truncate font-semibold">{tree.project.title}</span>
        <button className="rounded px-2 py-1 hover:bg-white/10" onClick={() => setSize(Math.max(16, size - 2))}>
          A−
        </button>
        <button className="rounded px-2 py-1 hover:bg-white/10" onClick={() => setSize(Math.min(72, size + 2))}>
          A+
        </button>
        <button className="rounded px-2 py-1 hover:bg-white/10" onClick={() => setNumbers(!numbers)}>
          {numbers ? "Hide #" : "Show #"}
        </button>
        <button className="rounded px-2 py-1 hover:bg-white/10" onClick={() => setApprovedOnly(!approvedOnly)}>
          {approvedOnly ? "All lines" : "Approved only"}
        </button>
        <select
          className="rounded bg-white/10 px-2 py-1"
          value=""
          onChange={(e) => document.getElementById(`rec-${e.target.value}`)?.scrollIntoView({ behavior: "smooth" })}
        >
          <option value="">Jump to…</option>
          {tree.sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-[#bbb]">
          speed
          <input type="range" min={5} max={120} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
        </label>
        <button className="rounded bg-[#6d4aff] px-3 py-1 font-semibold" onClick={() => setPlaying(!playing)}>
          {playing ? "Pause" : "Auto-scroll"}
        </button>
      </div>

      <main className="mx-auto max-w-4xl px-5 pb-[60vh] pt-36 sm:pt-20" style={{ fontSize: size, lineHeight: 1.25 }}>
        {tree.sections.map((s) => {
          const lines = s.lines.filter(
            (l) =>
              l.kind === "lyric" &&
              l.text.trim() &&
              l.status !== "DECLINED" &&
              (!approvedOnly || l.status === "APPROVED" || l.status === "APPROVED_EDITED"),
          );
          if (!lines.length) return null;
          const g = Math.max(1, s.group_size);
          return (
            <section key={s.id} id={`rec-${s.id}`} className="mb-[1.4em] scroll-mt-16">
              <h2 className="mb-[0.4em] text-[0.5em] font-bold uppercase tracking-[0.2em] text-[#8b7bff]">{s.name}</h2>
              {lines.map((l, i) => {
                n++;
                return (
                  <div key={l.id} className={`flex gap-[0.5em] ${i > 0 && i % g === 0 ? "mt-[0.6em]" : ""}`}>
                    {numbers && <span className="w-[1.6em] shrink-0 pt-[0.35em] text-right font-mono text-[0.45em] text-[#666]">{n}</span>}
                    <span>{l.text}</span>
                  </div>
                );
              })}
            </section>
          );
        })}
      </main>
    </div>
  );
}
