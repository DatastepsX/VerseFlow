"use client";

import { useEffect, useRef, useState } from "react";
import { useWriter } from "./context";
import { usePlayer } from "./Player";
import { sectionArtists } from "@/lib/artists";

/** desktop outline entry: scrolls to the section and moves the beat to its start */
export function SectionLink({ section }: { section: { id: string; name: string; lines: unknown[]; artists: string[] } }) {
  const player = usePlayer();
  const w = useWriter();
  return (
    <a
      href={`#section-${section.id}`}
      className="truncate rounded px-2 py-1 text-sm hover:bg-panel-2"
      onClick={() => player.cueSection(section.id)}
    >
      {sectionArtists(w.tree, section).map((a) => (
        <span key={a.id} className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: a.color }} title={a.name} />
      ))}
      {section.name} <span className="text-xs text-muted">{section.lines.length}</span>
    </a>
  );
}

/**
 * Sticky row of section chips (phones/tablets): tap to jump to a section — the beat moves there too.
 * The section in view is highlighted; ♪ marks the one the beat is playing.
 */
export function SectionNav() {
  const w = useWriter();
  const player = usePlayer();
  const [inView, setInView] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const sections = w.tree.sections;
  const ids = sections.map((s) => s.id).join(",");

  // which section is at the top of the screen
  useEffect(() => {
    const els = ids
      .split(",")
      .map((id) => document.getElementById(`section-${id}`))
      .filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = e.target.id.replace("section-", "");
          if (e.isIntersecting) visible.set(id, e.boundingClientRect.top);
          else visible.delete(id);
        }
        const top = [...visible.entries()].sort((a, b) => a[1] - b[1])[0];
        if (top) setInView(top[0]);
      },
      { rootMargin: "-110px 0px -55% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [ids]);

  // keep the active chip visible in the row
  useEffect(() => {
    if (!inView) return;
    rowRef.current?.querySelector<HTMLElement>(`[data-chip="${inView}"]`)?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [inView]);

  if (sections.length < 2) return null;
  const playingId = player.playing ? player.position?.sectionId : null;

  return (
    <div className="sticky top-[57px] z-20 border-b border-line bg-bg/95 backdrop-blur lg:hidden">
      <div ref={rowRef} className="flex gap-1.5 overflow-x-auto px-2 py-1.5 [scrollbar-width:none]">
        {sections.map((s) => (
          <button
            key={s.id}
            data-chip={s.id}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
              inView === s.id ? "border-accent bg-accent text-white" : "border-line bg-panel text-fg"
            }`}
            onClick={() => {
              document.getElementById(`section-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
              setInView(s.id);
              player.cueSection(s.id);
            }}
          >
            {playingId === s.id ? "♪ " : ""}
            {sectionArtists(w.tree, s).map((a) => (
              <span key={a.id} className="mr-1 inline-block h-2 w-2 rounded-full align-middle ring-1 ring-white/60" style={{ background: a.color }} title={a.name} />
            ))}
            {s.name}
            <span className="ml-1 font-normal opacity-70">{s.lines.length}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
