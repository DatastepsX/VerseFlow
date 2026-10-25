"use client";

import type { CSSProperties } from "react";
import { flowGroups } from "@/lib/flow/display";
import type { LineFlow } from "@/lib/types";

/**
 * A line as it is sung: its word groups with a break (‖) between them, a long note drawn out (its underline
 * runs on, ~), the stressed syllables underlined in the accent colour. A wrapped line breaks between word
 * groups — never inside one — and goes on indented, so it reads as the same line. `lit`: syllables already
 * sung (karaoke); `rhyme`: the last word marked.
 */
export function FlowText({
  text,
  lang,
  flow,
  beat,
  rhyme,
  lit,
  bars = true,
}: {
  text: string;
  lang: string;
  flow?: LineFlow | null;
  beat?: number;
  rhyme?: boolean;
  lit?: (syllable: number) => boolean;
  /** the stress bars under the syllables */
  bars?: boolean;
}) {
  const groups = flowGroups(text, lang, flow, beat);
  if (!groups) return rhyme ? <RhymeEnd text={text} /> : <>{text}</>;
  const all = groups.flatMap((g) => g.syllables);
  // the rhyme word: from where the last word starts (a merged syllable counts as its start)
  let rhymeFrom = all.length - 1;
  while (rhymeFrom > 0 && !all[rhymeFrom].space && !all[rhymeFrom].text.includes(" ")) rhymeFrom--;
  const bar = (on: boolean): CSSProperties =>
    bars
      ? {
          backgroundImage: `linear-gradient(${on ? "var(--accent)" : "color-mix(in srgb, var(--muted) 35%, transparent)"}, ${on ? "var(--accent)" : "color-mix(in srgb, var(--muted) 35%, transparent)"})`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "0 100%",
          backgroundSize: `calc(100% - 3px) ${on ? 3 : 2}px`,
          paddingBottom: 4,
          boxDecorationBreak: "clone",
          WebkitBoxDecorationBreak: "clone",
        }
      : {};
  return (
    <span className="leading-[1.75]" style={{ display: "block", paddingLeft: "1.1em", textIndent: "-1.1em" }}>
      {groups.map((g, gi) => {
        const words = g.syllables.map((s) => (s.space ? " " : "") + s.text).join("");
        return (
          <span key={gi}>
            {gi > 0 && (
              <>
                {" "}
                <span aria-label="break" className="mx-0.5 align-[0.05em] text-[0.7em] font-bold text-accent/45">
                  ‖
                </span>{" "}
              </>
            )}
            {/* a word group stays on one line (unless it's longer than one) */}
            <span style={{ whiteSpace: words.length <= 28 ? "nowrap" : undefined }}>
              {g.syllables.map((s, k) => {
                // drawn out only at the end of a word: inside one ("c'e~ra") it would split the word
                const next = g.syllables[k + 1] ?? groups[gi + 1]?.syllables[0];
                const held = s.long && (!next || next.space);
                const inRhyme = rhyme && (s.i > rhymeFrom || (s.i === rhymeFrom && !s.text.includes(" ")));
                return (
                  <span key={s.i}>
                    {s.space && k > 0 && " "}
                    <span
                      className={`${lit?.(s.i) ? "text-accent" : inRhyme ? "text-accent" : ""}`}
                      style={{ ...bar(s.stressed), ...(held ? { paddingRight: "0.35em" } : {}) }}
                    >
                      {rhyme && s.i === rhymeFrom && s.text.includes(" ") ? (
                        <>
                          {s.text.slice(0, s.text.lastIndexOf(" ") + 1)}
                          <span className="text-accent">{s.text.slice(s.text.lastIndexOf(" ") + 1)}</span>
                        </>
                      ) : (
                        s.text
                      )}
                      {held && (
                        <span aria-label="long" className="ml-[0.05em] text-[0.8em] text-accent/60">
                          ~
                        </span>
                      )}
                    </span>
                  </span>
                );
              })}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** the line with its last word — the rhyme — marked */
function RhymeEnd({ text }: { text: string }) {
  const m = text.match(/^(.*?)(\S+?)([^\p{L}\p{N}']*)$/u);
  if (!m) return <>{text}</>;
  return (
    <>
      {m[1]}
      <span className="font-semibold text-accent">{m[2]}</span>
      {m[3]}
    </>
  );
}
