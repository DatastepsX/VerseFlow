/**
 * The brief for a part's lyrics: what the writer wants before the AI writes it — the mood, whose voice, the
 * kind of words and rhymes, what it is about and words to use. Kept per part (project settings `briefs`), so
 * every later rewrite of the part follows it too. Pure data + the text the AI gets.
 */

export interface LyricsBrief {
  moods?: string[];
  perspective?: string;
  words?: string[];
  rhymes?: string;
  /** what the part is about, in the writer's words */
  about?: string;
  /** words, names, images to use */
  keywords?: string;
}

interface Choice {
  id: string;
  label: string;
  /** what the AI is told */
  prompt: string;
}

export const MOODS: Choice[] = [
  { id: "romantic", label: "Romantic", prompt: "romantic, tender, in love" },
  { id: "melancholic", label: "Melancholic", prompt: "melancholic, bittersweet, missing someone" },
  { id: "hopeful", label: "Hopeful", prompt: "hopeful, uplifting, looking forward" },
  { id: "nostalgic", label: "Nostalgic", prompt: "nostalgic, memories, how it used to be" },
  { id: "passionate", label: "Passionate", prompt: "passionate, intense, burning" },
  { id: "aggressive", label: "Aggressive", prompt: "aggressive, angry, hard-hitting punchlines" },
  { id: "confident", label: "Confident", prompt: "confident, proud, braggadocio — winning" },
  { id: "dark", label: "Dark", prompt: "dark, raw, the night side of life" },
  { id: "party", label: "Party", prompt: "party, carefree, the club, dancing" },
  { id: "playful", label: "Playful", prompt: "playful, ironic, light wordplay" },
  { id: "reflective", label: "Reflective", prompt: "reflective, thoughtful, honest with oneself" },
  { id: "rebellious", label: "Rebellious", prompt: "rebellious, against the rules, freedom" },
];

export const PERSPECTIVES: Choice[] = [
  { id: "me", label: "From me", prompt: "first person: the writer speaks about themself (I / me)" },
  { id: "you", label: "To you", prompt: "spoken to someone (you): a message to a person" },
  { id: "we", label: "Us", prompt: "first person plural: us / we, the two of us or the crew" },
  { id: "story", label: "A story", prompt: "storytelling: a scene with characters (he / she / they), something happens, line by line" },
];

export const WORDS: Choice[] = [
  { id: "modern", label: "Modern", prompt: "modern, current words — how people talk today" },
  { id: "street", label: "Street", prompt: "street language and slang (as the genre uses it)" },
  { id: "poetic", label: "Poetic", prompt: "poetic: images and metaphors" },
  { id: "simple", label: "Simple", prompt: "simple, direct everyday words, easy to sing along" },
  { id: "english", label: "+ English", prompt: "a few English words or phrases mixed in where they sound natural" },
  { id: "images", label: "Images", prompt: "concrete pictures: places, objects, colours — show, don't tell" },
];

export const RHYMES: Choice[] = [
  { id: "simple", label: "Clean end rhymes", prompt: "clean end rhymes, nothing forced" },
  { id: "multi", label: "Multi-syllable", prompt: "multi-syllable rhymes: the last two or three syllables rhyme" },
  { id: "inner", label: "Inner rhymes", prompt: "end rhymes plus internal rhymes and assonance inside the lines" },
];

const label = (list: Choice[], id: string | undefined) => list.find((c) => c.id === id);

/** a brief with nothing in it */
export function emptyBrief(b: LyricsBrief | null | undefined) {
  return !b || (!b.moods?.length && !b.perspective && !b.words?.length && !b.rhymes && !b.about?.trim() && !b.keywords?.trim());
}

/** the brief as the AI reads it (lines of "Mood: …"), or "" */
export function briefPrompt(b: LyricsBrief | null | undefined): string {
  if (!b || emptyBrief(b)) return "";
  const out: string[] = [];
  const moods = (b.moods ?? []).map((m) => label(MOODS, m)?.prompt).filter(Boolean);
  if (moods.length) out.push(`Mood: ${moods.join("; ")}`);
  const p = label(PERSPECTIVES, b.perspective);
  if (p) out.push(`Perspective: ${p.prompt}`);
  const words = (b.words ?? []).map((w) => label(WORDS, w)?.prompt).filter(Boolean);
  if (words.length) out.push(`Words: ${words.join("; ")}`);
  const r = label(RHYMES, b.rhymes);
  if (r) out.push(`Rhymes: ${r.prompt}`);
  if (b.about?.trim()) out.push(`What it is about (the writer's words): ${b.about.trim().slice(0, 600)}`);
  if (b.keywords?.trim()) out.push(`Use these words / images: ${b.keywords.trim().slice(0, 300)}`);
  return out.join("\n");
}

/** a brief from the browser: only known choices, texts cut to size */
export function cleanBrief(v: unknown): LyricsBrief | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const pick = (list: Choice[], x: unknown) => (typeof x === "string" && list.some((c) => c.id === x) ? x : undefined);
  const many = (list: Choice[], x: unknown) => (Array.isArray(x) ? [...new Set(x.filter((y) => pick(list, y)) as string[])] : []);
  const text = (x: unknown, n: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, n) : undefined);
  const out: LyricsBrief = {
    moods: many(MOODS, b.moods),
    perspective: pick(PERSPECTIVES, b.perspective),
    words: many(WORDS, b.words),
    rhymes: pick(RHYMES, b.rhymes),
    about: text(b.about, 600),
    keywords: text(b.keywords, 300),
  };
  return emptyBrief(out) ? null : out;
}
