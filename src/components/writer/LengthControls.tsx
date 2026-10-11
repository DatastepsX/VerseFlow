"use client";

import { adjustLength } from "@/lib/rhyme/fit";
import { prosody, type Prosody } from "@/lib/rhyme/prosody";

/**
 * "11 syl / ≈12  [−] [+]" — shorten or lengthen a line by one small step
 * (filler words, truncation) towards the reference line's length. Local, free.
 */
export function LengthControls({
  text,
  lang,
  reference,
  onChange,
}: {
  text: string;
  lang: string;
  reference: Prosody | null;
  onChange: (next: string) => void;
}) {
  if (!text.trim()) return null;
  const p = prosody(text, lang);
  const shorter = adjustLength(text, lang, -1, reference);
  const longer = adjustLength(text, lang, 1, reference);
  const diff = reference ? p.syllables - reference.syllables : 0;
  const tone = !reference ? "text-muted" : Math.abs(diff) <= 1 ? "text-ok" : Math.abs(diff) <= 2 ? "text-warn" : "text-bad";
  const btn = "inline-flex h-6 w-6 items-center justify-center rounded border border-line bg-panel text-sm font-bold hover:border-accent hover:text-accent disabled:opacity-30";
  return (
    <span className="inline-flex items-center gap-1">
      <button className={btn} disabled={!shorter} title={shorter ? `Shorter: “${shorter}”` : "Nothing more to remove"} onClick={() => shorter && onChange(shorter)}>
        −
      </button>
      <span className={`font-mono text-xs tabular-nums ${tone}`} title={reference ? `${p.syllables} syllables — the line before has ${reference.syllables}` : `${p.syllables} syllables`}>
        {p.syllables}
        {reference ? `/${reference.syllables}` : ""} syl
      </span>
      <button className={btn} disabled={!longer} title={longer ? `Longer: “${longer}”` : "No natural spot for a filler word"} onClick={() => longer && onChange(longer)}>
        +
      </button>
    </span>
  );
}
