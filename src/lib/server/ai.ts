import "server-only";
import { performedBy } from "@/lib/artists";
import { adjustLength } from "@/lib/rhyme/fit";
import { songRhymeDistance } from "@/lib/scheme";
import Anthropic from "@anthropic-ai/sdk";
import { analyzeLine, compareLines, lastWord } from "@/lib/rhyme/analyze";
import { describeRhythm, prosody } from "@/lib/rhyme/prosody";
import { rhymePartners } from "@/lib/scheme";
import { sectionPattern } from "@/lib/pattern";
import { sectionLineTarget } from "@/lib/audio/song-map";
import { LANGUAGES, PROJECT_TYPES, type Line, type ProjectTree } from "@/lib/types";
import { bankTexts, rejectedAlternatives, recordAiCall } from "./repo";

/** Overridable in Vercel env (e.g. claude-sonnet-5-5 or claude-haiku-5-5 for lower cost). */
const MODEL = process.env.AI_MODEL || "claude-opus-5-5";
const EFFORT = (process.env.AI_EFFORT || "medium") as "low" | "medium" | "high";
// server-side refusal fallback is supported on these models only
const FALLBACKS = /^claude-(opus-5|fable-5|sonnet-5-5)/.test(MODEL);

/**
 * The rhythm the new lines must follow: lines marked as rhythm reference, or
 * else the last written lines before `before` (the line before sets the flow).
 */
function rhythmTemplate(
  lines: { text: string; kind: string; status: string }[],
  lang: string,
  before = lines.length,
  pattern: string[] = [],
) {
  const refs = pattern.length ? pattern.map((text) => ({ text })) : lines.filter((l) => l.kind === "rhythm_ref" && l.text.trim());
  const pick = refs.length
    ? refs.slice(-2)
    : lines
        .slice(0, before)
        .filter((l) => l.kind === "lyric" && l.text.trim() && l.status !== "DECLINED")
        .slice(-2);
  if (!pick.length) return "";
  return `RHYTHM TEMPLATE${refs.length ? " (the section's pattern — rhythm only, its words are not lyrics)" : " (the lines just before)"} — every new line must match it:
${pick.map((l) => `  “${l.text}” → ${describeRhythm(prosody(l.text, lang), lang)}`).join("\n")}
Match the syllable count of the last template line (±1 sung syllable, counting vowel merges between words), put the stresses in the same places so it flows on the same beat, and use the same ending type.`;
}

/** how the song rhymes as written: decides for sections too short to tell */
function songRhyme(tree: ProjectTree, lang: string) {
  return songRhymeDistance(
    tree.sections.map((s) => s.lines.filter((l) => l.kind === "lyric" && l.status !== "DECLINED").map((l) => l.text)),
    lang,
  );
}

export class AiUnavailable extends Error {}

export function aiConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

const SYSTEM = `You are a co-writer inside VerseFlow, a line-by-line lyric and text writing tool.
The writer has final authority. You only propose options for the requested target line(s); you never rewrite other lines.

Rules:
- Lines marked [LOCKED] are approved by the writer. Never alter them; use them as context.
- Lines marked [RHYTHM] are prosody templates only: match their syllable count and stress feel, ignore their meaning.
- Respect the rhyme requirement exactly as stated (exact rhyme = same sounds from the stressed vowel on; loose = same vowels / assonance).
- Match the rhythm template exactly: same number of sung syllables (±1), stresses in the same places, same ending type — the new line must be singable/rappable on the same beat as the line before.
- Write in the project's language. Keep the vocabulary natural for the style; prefer simple, singable wording unless asked otherwise.
- Every option must be meaningfully different (wording, image or angle), and must not repeat rejected options.
- Each option must fit the story beat and emotional intensity of the section, and connect with the lines around it.
- Return only the lyric text in the options — no numbering, quotes, explanations or stage directions.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    options: {
      type: "array",
      items: {
        type: "object",
        properties: { lines: { type: "array", items: { type: "string" } } },
        required: ["lines"],
        additionalProperties: false,
      },
    },
  },
  required: ["options"],
  additionalProperties: false,
};

export interface GenerateRequest {
  tree: ProjectTree;
  lineId: string;
  /** "line": options for one line; "group": options for the whole couplet/group the line belongs to */
  scope: "line" | "group";
  count: number;
  instruction?: string;
  rhymeStrength?: "exact" | "loose" | "none";
}

function langName(code: string) {
  return LANGUAGES.find((l) => l.value === code)?.label ?? code;
}

export async function generateOptions(req: GenerateRequest): Promise<{ targetIds: string[]; options: string[][] }> {
  if (!aiConfigured()) throw new AiUnavailable("AI is not configured yet (ANTHROPIC_API_KEY missing).");
  const { tree, lineId, scope, count } = req;
  const { project } = tree;
  const section = tree.sections.find((s) => s.lines.some((l) => l.id === lineId));
  if (!section) throw new Error("Line not found in project");
  const lines = section.lines;
  const idx = lines.findIndex((l) => l.id === lineId);
  const g = Math.max(1, section.group_size);
  const groupStart = Math.floor(idx / g) * g;
  const targetIdx =
    scope === "group" ? lines.slice(groupStart, groupStart + g).map((_, k) => groupStart + k) : [idx];
  const targets = new Set(targetIdx);
  const lang = project.language;

  // Rhythm target: a rhythm reference in the section wins, otherwise the average of decided lines.
  const rhythmRefs = lines.filter((l) => l.kind === "rhythm_ref" && l.text.trim());
  const decided = lines.filter(
    (l, k) => !targets.has(k) && l.kind === "lyric" && l.text.trim() && l.status !== "DECLINED",
  );
  const sylSource = rhythmRefs.length ? rhythmRefs : decided;
  const avgSyl = sylSource.length
    ? Math.round(sylSource.reduce((n, l) => n + analyzeLine(l.text, lang).syllables, 0) / sylSource.length)
    : null;

  // Rhyme requirements from the section's scheme
  const partners = rhymePartners(lines.map((l) => l.text), g, section.rhyme_scheme, lang, songRhyme(req.tree, lang));
  const strength = req.rhymeStrength ?? "exact";
  const requirements: string[] = [];
  for (const k of targetIdx) {
    const p = partners[k];
    const n = k + 1;
    if (strength === "none") {
      requirements.push(`Line ${n}: no rhyme required.`);
    } else if (p.partner !== null && !targets.has(p.partner) && lines[p.partner].text.trim()) {
      const other = lines[p.partner].text;
      const a = analyzeLine(other, lang);
      requirements.push(
        `Line ${n} must ${strength === "exact" ? "rhyme exactly" : "rhyme loosely (assonance is fine)"} with line ${p.partner + 1} ` +
          `(ends with “${lastWord(other)}”, rhyme sound “-${a.rhymeKey}”, vowels ${a.vowelTail.split("").join("-")}).`,
      );
    } else if (p.partner !== null && targets.has(p.partner)) {
      requirements.push(`Line ${n} must rhyme with line ${p.partner + 1} (both are part of this option).`);
    } else {
      // an opener sets the rhyme for its partner: make it easy to rhyme, and offer continuity with the previous couplet
      const prevText = lines.slice(0, k).reverse().find((l) => l.kind === "lyric" && l.text.trim() && l.status !== "DECLINED")?.text;
      const prevKey = prevText ? analyzeLine(prevText, lang).rhymeKey : null;
      requirements.push(
        `Line ${n} opens a new ${g === 2 ? "couplet" : "group"}: end it on a word with many natural rhymes in ${langName(lang)}` +
          (prevKey ? ` — at least one option should keep the rhyme of the line before (“${lastWord(prevText!)}”, -${prevKey}), the others may open a new rhyme.` : "."),
      );
    }
  }

  const rejected = await rejectedAlternatives(lineId);
  const current = targetIdx.map((k) => lines[k].text).filter((t) => t.trim());

  const sectionText = lines
    .map((l, k) => {
      const tag = targets.has(k)
        ? "[TARGET]"
        : l.kind === "rhythm_ref"
          ? "[RHYTHM]"
          : l.status === "APPROVED" || l.status === "APPROVED_EDITED"
            ? "[LOCKED]"
            : l.status === "DECLINED"
              ? "[DECLINED]"
              : "[DRAFT]";
      const sep = k > 0 && k % g === 0 ? "\n" : "";
      return `${sep}${k + 1}. ${tag} ${targets.has(k) ? (l.text.trim() ? `(current: ${l.text})` : "(empty)") : l.text || "(empty)"}`;
    })
    .join("\n");

  const otherSections = tree.sections
    .filter((s) => s.id !== section.id && s.lines.some((l) => l.text.trim()))
    .map(
      (s) =>
        `${s.name}:\n` +
        s.lines
          .filter((l) => l.kind === "lyric" && l.text.trim() && l.status !== "DECLINED")
          .map((l) => `  ${l.text}`)
          .join("\n"),
    )
    .join("\n\n");

  const st = project.settings ?? {};
  const prompt = `PROJECT
Title: ${project.title}
Type: ${PROJECT_TYPES.find((t) => t.value === project.type)?.label ?? project.type}
Language: ${langName(lang)}${st.secondaryLanguage ? ` (occasional ${st.secondaryLanguage} words are welcome)` : ""}
${st.genre ? `Genre: ${st.genre}\n` : ""}${st.style ? `Style / references: ${st.style}\n` : ""}${st.mood ? `Mood: ${st.mood}\n` : ""}${st.simpleLanguage ? "Vocabulary: simple, modern, direct — avoid overly poetic words\n" : ""}${st.explicitness ? `Explicit content: ${st.explicitness}\n` : ""}${project.concept ? `Story / concept: ${project.concept}\n` : ""}
${otherSections ? `OTHER SECTIONS (context only)\n${otherSections}\n\n` : ""}CURRENT SECTION: ${section.name}${section.story_beat ? `\nStory beat: ${section.story_beat}` : ""}${section.intensity ? `\nEmotional intensity: ${section.intensity}/10` : ""}${section.notes ? `\nNotes: ${section.notes}` : ""}${performedBy(tree, section)}
Lines are grouped in ${g === 1 ? "single lines" : g === 2 ? "couplets" : `groups of ${g}`}.
${sectionText}

TASK
Write ${count} options for ${targetIdx.length === 1 ? `line ${targetIdx[0] + 1}` : `lines ${targetIdx.map((k) => k + 1).join(" and ")} (each option contains all ${targetIdx.length} lines, in order)`}.
${requirements.join("\n")}
${rhythmTemplate(lines, lang, targetIdx[0], sectionPattern(section)) || (avgSyl ? `Target length: about ${avgSyl} syllables per line.` : "")}
${req.instruction ? `Writer's direction: ${req.instruction}` : ""}
${current.length ? `Current text of the target (offer alternatives to it): ${current.join(" / ")}` : ""}
${rejected.length ? `Already rejected — do not repeat or closely paraphrase:\n${rejected.map((r) => `- ${r.text.replace(/\n/g, " / ")}`).join("\n")}` : ""}
Each option's "lines" array must contain exactly ${targetIdx.length} line${targetIdx.length > 1 ? "s" : ""}.`;

  const parsed = await callJson<{ options: { lines: string[] }[] }>(project.id, "line_options", prompt, OUTPUT_SCHEMA);
  const options = parsed.options
    .map((o) => o.lines.map((l) => l.trim()).filter(Boolean))
    .filter((o) => o.length === targetIdx.length)
    .slice(0, count);
  return { targetIds: targetIdx.map((k) => lines[k].id), options };
}

async function callJson<T>(projectId: string, kind: string, prompt: string, schema: object, system = SYSTEM, effort = EFFORT): Promise<T> {
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    ...(FALLBACKS ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    output_config: { effort, format: { type: "json_schema", schema: schema as Record<string, unknown> } },
    system,
    messages: [{ role: "user", content: prompt }],
  });
  await recordAiCall(projectId, kind, response.model, response.usage).catch(() => {});
  if (response.stop_reason === "refusal") throw new Error("The AI declined this request. Try rephrasing the direction.");
  if (response.stop_reason === "max_tokens") throw new Error("The AI response was cut off — try again.");
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("Empty AI response");
  return JSON.parse(text.text) as T;
}

// ---------- suggestion bank ----------

const BANK_SCHEMA = {
  type: "object",
  properties: {
    families: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rhyme: { type: "string" },
          lines: { type: "array", items: { type: "string" } },
        },
        required: ["rhyme", "lines"],
        additionalProperties: false,
      },
    },
  },
  required: ["families"],
  additionalProperties: false,
};

export interface BankRequest {
  tree: ProjectTree;
  sectionId: string;
  /** line texts whose ending needs rhyming partners (e.g. an unpaired line) */
  targets: string[];
  /** number of new rhyme families to invent */
  newFamilies: number;
  linesPerFamily: number;
  instruction?: string;
}

/**
 * One API call that stocks a section with many candidate bars, organised as
 * rhyme families. The app then serves next-bar suggestions from this bank
 * locally (rhyme + syllable matching), without further API calls.
 */
export async function fillBank(req: BankRequest): Promise<{ rhyme: string; lines: string[] }[]> {
  if (!aiConfigured()) throw new AiUnavailable("AI is not configured yet (ANTHROPIC_API_KEY missing).");
  const { tree, sectionId } = req;
  const { project } = tree;
  const section = tree.sections.find((s) => s.id === sectionId);
  if (!section) throw new Error("Section not found");
  const lang = project.language;
  const lines = section.lines;
  const g = Math.max(1, section.group_size);

  const decided = lines.filter((l) => l.kind === "lyric" && l.text.trim() && l.status !== "DECLINED");
  const rhythmRefs = lines.filter((l) => l.kind === "rhythm_ref" && l.text.trim());
  const sylFrom = rhythmRefs.length ? rhythmRefs : decided;
  const avgSyl = sylFrom.length
    ? Math.round(sylFrom.reduce((n, l) => n + analyzeLine(l.text, lang).syllables, 0) / sylFrom.length)
    : null;

  const [rejected, available] = await Promise.all([bankTexts(sectionId, "rejected", 40), bankTexts(sectionId, "available", 60)]);
  const targets = [...new Set(req.targets.map((t) => t.trim()).filter(Boolean))].slice(0, 4);
  const n = req.linesPerFamily;

  const sectionText = lines.length
    ? lines
        .map((l, k) => {
          const tag = l.kind === "rhythm_ref" ? "[RHYTHM] " : l.status === "DECLINED" ? "[DECLINED] " : "";
          return `${k > 0 && k % g === 0 ? "\n" : ""}${k + 1}. ${tag}${l.text || "(empty)"}`;
        })
        .join("\n")
    : "(no lines yet)";

  const otherSections = tree.sections
    .filter((s) => s.id !== section.id && s.lines.some((l) => l.text.trim()))
    .map((s) => `${s.name}:\n` + s.lines.filter((l) => l.kind === "lyric" && l.text.trim() && l.status !== "DECLINED").map((l) => `  ${l.text}`).join("\n"))
    .join("\n\n");

  const st = project.settings ?? {};
  const targetSpec = targets
    .map((t, i) => {
      const a = analyzeLine(t, lang);
      return `  T${i + 1}. ${n} lines that rhyme exactly with “${t}” (ending “${lastWord(t)}”, sound -${a.rhymeKey}); set "rhyme" to "-${a.rhymeKey}".`;
    })
    .join("\n");

  const prompt = `PROJECT
Title: ${project.title}
Type: ${PROJECT_TYPES.find((t) => t.value === project.type)?.label ?? project.type}
Language: ${langName(lang)}${st.secondaryLanguage ? ` (occasional ${st.secondaryLanguage} words are welcome)` : ""}
${st.genre ? `Genre: ${st.genre}\n` : ""}${st.style ? `Style / references: ${st.style}\n` : ""}${st.mood ? `Mood: ${st.mood}\n` : ""}${st.simpleLanguage ? "Vocabulary: simple, modern, direct — avoid overly poetic words\n" : ""}${st.explicitness ? `Explicit content: ${st.explicitness}\n` : ""}${project.concept ? `Story / concept: ${project.concept}\n` : ""}
${otherSections ? `OTHER SECTIONS (context only)\n${otherSections}\n\n` : ""}CURRENT SECTION: ${section.name}${section.story_beat ? `\nStory beat: ${section.story_beat}` : ""}${section.intensity ? `\nEmotional intensity: ${section.intensity}/10` : ""}${section.notes ? `\nNotes: ${section.notes}` : ""}${performedBy(tree, section)}
${sectionText}

TASK — build a bank of candidate bars the writer can pick from while continuing this section.
Organise them as rhyme families: every line in a family ends with the same rhyme sound (exact rhyme).
Inside each family, write the lines so that lines 1+2, 3+4, 5+6 … each form a coherent ${g === 1 ? "pair" : "couplet"}, and every line also works on its own as a next bar.
${targetSpec ? `Families that answer existing lines (write these first):\n${targetSpec}\n` : ""}Then ${req.newFamilies} new families on ${req.newFamilies} different rhyme sounds, ${n} lines each, that continue the story from the last lines and move it forward (vary the images and angles; no filler).
${rhythmTemplate(lines, lang, lines.length, sectionPattern(section)) || (avgSyl ? `Every line about ${avgSyl} syllables (±1).` : "Keep lines a natural, performable length.")}
${req.instruction ? `Writer's direction: ${req.instruction}` : ""}
${available.length ? `Already in the bank — do not repeat:\n${available.map((t) => `- ${t}`).join("\n")}` : ""}
${rejected.length ? `Rejected by the writer — avoid similar lines:\n${rejected.map((t) => `- ${t}`).join("\n")}` : ""}
Do not repeat lines that already exist in the song. "rhyme" is a short label of the shared ending (e.g. "-ore").`;

  const parsed = await callJson<{ families: { rhyme: string; lines: string[] }[] }>(project.id, "bank", prompt, BANK_SCHEMA);
  const existing = new Set(lines.map((l) => l.text.trim().toLowerCase()));
  return parsed.families
    .map((f) => ({ rhyme: f.rhyme.slice(0, 20), lines: f.lines.map((l) => l.trim()).filter((l) => l && !existing.has(l.toLowerCase())) }))
    .filter((f) => f.lines.length > 0);
}

// ---------- fit one line to a length ----------

const FIT_SCHEMA = {
  type: "object",
  properties: { lines: { type: "array", items: { type: "string" } } },
  required: ["lines"],
  additionalProperties: false,
};

/**
 * Rewrite one line (the writer's own text or a chosen bar) so it fits the
 * rhythm of the line before — same meaning, same last word (keeps the rhyme).
 * One small AI call; the results are stored in the bank for reuse.
 */
export async function fitLine(opts: { tree: ProjectTree; sectionId: string; text: string; reference: string; count?: number }) {
  if (!aiConfigured()) throw new AiUnavailable("AI is not configured yet (ANTHROPIC_API_KEY missing).");
  const { tree, text, reference } = opts;
  const lang = tree.project.language;
  const ref = prosody(reference, lang);
  const cur = prosody(text, lang);
  const end = lastWord(text);
  const prompt = `Language: ${langName(lang)}. ${tree.project.settings?.simpleLanguage ? "Simple, modern wording." : ""}
Line before (rhythm template): “${reference}” → ${describeRhythm(ref, lang)}
Line to fit: “${text}” → ${cur.syllables} syllables

Rewrite the line to fit the template: exactly ${ref.syllables} sung syllables (count vowel merges between words), stresses in the same places, same ending type.
Keep its meaning and image, keep the final word “${end}” (it carries the rhyme), sound natural and performable — no filler padding.
Return ${opts.count ?? 3} different versions.`;
  const parsed = await callJson<{ lines: string[] }>(tree.project.id, "fit_line", prompt, FIT_SCHEMA);
  return parsed.lines
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, opts.count ?? 3);
}


// ---------- draft a whole section from its pattern ----------

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    slots: {
      type: "array",
      items: {
        type: "object",
        properties: { line: { type: "integer" }, options: { type: "array", items: { type: "string" } } },
        required: ["line", "options"],
        additionalProperties: false,
      },
    },
  },
  required: ["slots"],
  additionalProperties: false,
};

export interface DraftSlot {
  /** 0-based line index in the section */
  index: number;
  options: string[];
}

/** How many lines a section should have: from its length on the beat, else what is written or 8. */
export function sectionLineCount(tree: ProjectTree, sectionId: string) {
  const s = tree.sections.find((x) => x.id === sectionId)!;
  return sectionLineTarget({ ...s, lines: s.lines.filter((l) => l.kind === "lyric") }, tree.sections, tree.audio);
}

const NEEDS = new Set(["DECLINED", "NEEDS_NEW_OPTIONS"]);

/**
 * Section drafts:
 * - "fill": write every empty bar slot (up to the section's length)
 * - "replace": write only the bars the writer marked to replace (✕)
 * Each slot gets 3 options that follow the section's pattern, the rhyme
 * scheme and the context of the bars that are kept.
 */
/** bars written per call — keeps each call short; a section's chunks run in parallel */
export const DRAFT_CHUNK = 8;
/** drafts think less than single-line options: much faster, the writer reviews them anyway */
const DRAFT_EFFORT = (process.env.AI_DRAFT_EFFORT || "low") as "low" | "medium" | "high";

/**
 * Which bars a fill/replace writes: `n` = bar count of the section,
 * `open` = bar indices to write, `chunks` = those split into whole line
 * groups of about DRAFT_CHUNK bars (couplets stay together), one call each.
 */
export type DraftMode = "fill" | "replace" | "polish" | "refit";

const LOCKED = new Set(["APPROVED", "APPROVED_EDITED"]);

export function draftPlan(tree: ProjectTree, sectionId: string, mode: DraftMode) {
  const section = tree.sections.find((s) => s.id === sectionId);
  if (!section) throw new Error("Section not found");
  const lyrics = section.lines.filter((l) => l.kind === "lyric");
  const n = mode === "fill" ? Math.max(sectionLineCount(tree, sectionId), lyrics.length) : lyrics.length;
  const isSlot = (k: number) => {
    const l = lyrics[k];
    // polish: every written line that isn't approved yet gets improved versions (its text stays)
    if (mode === "polish") return !!l && !!l.text.trim() && !LOCKED.has(l.status) && l.status !== "DECLINED";
    // refit (the pattern changed): every written line — approved ones get the new versions as options only
    if (mode === "refit") return !!l && !!l.text.trim() && l.status !== "DECLINED";
    if (!l || !l.text.trim()) return mode === "fill" || !!l;
    return NEEDS.has(l.status);
  };
  const open = Array.from({ length: n }, (_, k) => k).filter(isSlot);
  const g = Math.max(1, section.group_size);
  const chunks: number[][] = [];
  for (const k of open) {
    const cur = chunks[chunks.length - 1];
    if (cur && (cur.length < DRAFT_CHUNK || Math.floor(k / g) === Math.floor(cur[cur.length - 1] / g))) cur.push(k);
    else chunks.push([k]);
  }
  return { n, lyricCount: lyrics.length, open, chunks };
}

/**
 * Drafts one chunk of a section's open bars: `only` (bar indices) or else the
 * first chunk. Other open bars are left out ([LATER]). `remaining` = open bars
 * not written by this call.
 */
export async function draftSection(tree: ProjectTree, sectionId: string, mode: DraftMode, instruction?: string, only?: number[]) {
  if (!aiConfigured()) throw new AiUnavailable("AI is not configured yet (ANTHROPIC_API_KEY missing).");
  const { project } = tree;
  const lang = project.language;
  const section = tree.sections.find((s) => s.id === sectionId);
  if (!section) throw new Error("Section not found");
  const pattern = sectionPattern(section);
  const lyrics = section.lines.filter((l) => l.kind === "lyric");
  const { n, open, chunks } = draftPlan(tree, sectionId, mode);
  const texts = Array.from({ length: n }, (_, k) => lyrics[k]?.text ?? "");
  const want = only ? new Set(only) : null;
  const slots = want ? open.filter((k) => want.has(k)) : (chunks[0] ?? []);
  if (!slots.length) return { slots: [] as DraftSlot[], remaining: 0 };
  const g = Math.max(1, section.group_size);
  const slotSet = new Set(slots);
  const refit = mode === "refit";
  // polish / refit: the lines keep their text in the prompt (they are rewritten, not written from scratch)
  const polish = mode === "polish" || refit;
  // polish: lines improved in another call are context like any other written line
  const later = polish ? new Set<number>() : new Set(open.filter((k) => !slotSet.has(k)));

  const partners = rhymePartners(texts.map((t, k) => (!polish && (slotSet.has(k) || later.has(k)) ? "x" : t)), g, section.rhyme_scheme, lang, songRhyme(tree, lang));
  const rhymeRules = slots
    .map((k) => {
      if (polish) {
        const p = partners[k].partner;
        if (p === null || !texts[p].trim()) return null;
        return slotSet.has(p)
          ? k < p
            ? `Lines ${k + 1} and ${p + 1} rhyme: option i of both must still rhyme with each other.`
            : null
          : `Line ${k + 1} must keep rhyming with line ${p + 1} “${texts[p]}” (-${analyzeLine(texts[p], lang).rhymeKey}).`;
      }
      const p = partners[k].partner;
      if (p === null || later.has(p)) return null;
      if (slotSet.has(p)) return k < p ? `Lines ${k + 1} and ${p + 1} are both open: they must rhyme exactly with each other (option i of line ${k + 1} pairs with option i of line ${p + 1}).` : null;
      const other = texts[p];
      return other.trim() ? `Line ${k + 1} must rhyme exactly with line ${p + 1} “${other}” (-${analyzeLine(other, lang).rhymeKey}).` : null;
    })
    .filter(Boolean)
    .join("\n");

  const rejected = new Set<string>();
  for (const k of slots) {
    const l = lyrics[k];
    if (l?.text.trim() && !polish) rejected.add(l.text.trim());
    for (const a of l?.alternatives ?? []) rejected.add(a.text.trim());
  }
  for (const k of slots) {
    const l = lyrics[k];
    if (l) for (const r of await rejectedAlternatives(l.id)) rejected.add(r.text.trim());
  }

  const listing = texts
    .map((t, k) =>
      polish
        ? `${k > 0 && k % g === 0 ? "\n" : ""}${k + 1}. ${slotSet.has(k) ? (refit ? "[REFIT]" : "[IMPROVE]") : "[KEEP]"} ${t}`
        : `${k > 0 && k % g === 0 ? "\n" : ""}${k + 1}. ${slotSet.has(k) ? "[OPEN]" : later.has(k) ? "[LATER]" : "[KEEP]"} ${slotSet.has(k) || later.has(k) ? "" : t}`,
    )
    .join("\n");
  const others = tree.sections
    .filter((s) => s.id !== sectionId && s.lines.some((l) => l.kind === "lyric" && l.text.trim()))
    .map((s) => `${s.name}:\n` + s.lines.filter((l) => l.kind === "lyric" && l.text.trim() && l.status !== "DECLINED").map((l) => `  ${l.text}`).join("\n"))
    .join("\n\n");
  const st = project.settings ?? {};
  const template = rhythmTemplate(section.lines, lang, section.lines.length, pattern);

  const prompt = `PROJECT
Title: ${project.title}
Language: ${langName(lang)}${st.secondaryLanguage ? ` (occasional ${st.secondaryLanguage} words are welcome)` : ""}
${st.genre ? `Genre: ${st.genre}\n` : ""}${st.style ? `Style / references: ${st.style}\n` : ""}${st.mood ? `Mood: ${st.mood}\n` : ""}${st.simpleLanguage ? "Vocabulary: simple, modern, direct — avoid overly poetic words\n" : ""}${st.explicitness ? `Explicit content: ${st.explicitness}\n` : ""}${project.concept ? `Story / concept: ${project.concept}\n` : ""}
${others ? `REST OF THE SONG (context — stay consistent with it)\n${others}\n\n` : ""}SECTION: ${section.name}${section.story_beat ? `\nStory beat: ${section.story_beat}` : ""}${section.intensity ? `\nIntensity: ${section.intensity}/10` : ""}${section.notes ? `\nNotes: ${section.notes}` : ""}${performedBy(tree, section)}
Lines grouped in ${g === 2 ? "couplets" : g === 1 ? "single lines" : `groups of ${g}`}. ${
    polish
      ? refit
        ? "The writer's text. The section's rhythm pattern has CHANGED (see the template below): rewrite the [REFIT] lines to fit it."
        : "The writer's own text. [KEEP] lines stay as they are; write improved versions of the [IMPROVE] lines."
      : "[KEEP] lines are fixed — never change them; write only the [OPEN] lines. [LATER] lines are written separately — skip them, but leave room for the text to continue there."
  }
${listing}

${template || "Keep lines a natural, performable length."}
${rhymeRules ? `RHYMES\n${rhymeRules}` : ""}

TASK
${
  refit
    ? `For every [REFIT] line write 3 versions that follow the NEW rhythm template exactly — its number of syllables (±1) and where the stresses fall — while keeping what the line says, its place in the story and its rhyme with its partner line. Change words, add or drop filler, reorder phrases as needed. The first version stays closest to the original wording.`
    : polish
    ? `For every [IMPROVE] line write 3 improved versions of it. Keep what the line says and its place in the story, keep its rhyme and roughly its length (±2 syllables, unless the writer's direction asks otherwise), but make it stronger: more vivid images, fresher and more natural wording, smoother flow, no filler. The 3 versions should differ: one close to the original, one bolder, one in between.`
    : "For every [OPEN] line write 3 different options. Each option must follow the rhythm template, respect its rhyme rule, and connect naturally with the lines before and after it (the section must read as one coherent text that fits the rest of the song). Vary images and wording between options."
}
${instruction ? `Writer's direction: ${instruction}` : ""}
${rejected.size ? `Rejected before — do not repeat or closely paraphrase:\n${[...rejected].slice(0, 40).map((t) => `- ${t}`).join("\n")}` : ""}
Return one entry per ${refit ? "[REFIT]" : polish ? "[IMPROVE]" : "[OPEN]"} line, "line" = its number.`;

  const parsed = await callJson<{ slots: { line: number; options: string[] }[] }>(project.id, `section_${mode}`, prompt, DRAFT_SCHEMA, SYSTEM, DRAFT_EFFORT);
  const drafted = parsed.slots
    .map((x) => ({ index: x.line - 1, options: x.options.map((o) => o.trim()).filter(Boolean).slice(0, 3) }))
    .filter((x) => slotSet.has(x.index) && x.options.length);
  return { slots: drafted, remaining: later.size };
}

/* ---------- flow: suggestions from the writer's sung rhythm ---------- */

/**
 * 3 options for each of the given lines, written to the rhythm the writer
 * sang there (syllables, stresses, held last note), about what the writer
 * sang (recognised words → topic and mood, kept where they fit), rhyming
 * in couplets. Every option is checked with the syllable counter and nudged
 * onto the target length; the best fitting comes first.
 */
export async function flowSuggest(tree: ProjectTree, lineIds: string[]) {
  if (!aiConfigured()) throw new AiUnavailable("AI is not configured yet (ANTHROPIC_API_KEY missing).");
  const { project } = tree;
  const lang = project.language;
  const want = new Set(lineIds);
  const all = tree.sections.flatMap((s) => s.lines.filter((l) => l.kind === "lyric").map((l, k) => ({ l, s, k })));
  const num = new Map(all.map((x, i) => [x.l.id, i + 1]));
  const targets = all.filter((x) => want.has(x.l.id));
  if (!targets.length) return [] as { id: string; options: string[] }[];

  const sang = all.map((x, i) => `${i + 1}. ${x.l.flow?.words?.trim() || "(na-na)"}`).join("\n");
  // from the vocals in the uploaded song: the recorded words are the lyrics and stay — options are alternatives
  const recorded = (l: Line) => l.flow?.source === "vocals" && !!l.text.trim();
  const vocals = targets.some((x) => recorded(x.l));
  const listing = tree.sections
    .map((s) => {
      const lyric = s.lines.filter((l) => l.kind === "lyric");
      const rows = lyric.map((l) => {
        const n = num.get(l.id)!;
        const f = l.flow;
        const rhythm = f ? `${f.syllables} syllables ${patternOf(f)}` : "free";
        const chosen =
          (l.status === "APPROVED" || l.status === "APPROVED_EDITED") && l.text.trim()
            ? ` — written: “${l.text}”`
            : recorded(l)
              ? ` — recorded: “${l.flow!.words}”${l.text.trim() !== l.flow!.words.trim() ? `, now: “${l.text}”` : ""}`
              : "";
        return `${n}. ${want.has(l.id) ? "[WRITE]" : "[KEEP]"} rhythm: ${rhythm}; sang: ${f?.words?.trim() ? `“${f.words}”` : "(na-na)"}${chosen}`;
      });
      return `${s.name}${performedBy(tree, s)}:\n${rows.join("\n")}`;
    })
    .join("\n\n");
  // couplets: as sung (a line ends on its rhyme — flow.pair), else lines 1+2, 3+4… of each section
  const rhymes: string[] = [];
  /** every couplet with a line being written, to keep its options rhyming pairwise */
  const allCouplets: [Line, Line][] = [];
  for (const s of tree.sections) {
    const lyric = s.lines.filter((l) => l.kind === "lyric");
    const sung = lyric.some((l) => l.flow?.pair !== undefined);
    const couplets: [Line, Line][] = [];
    for (let k = 0; k + 1 < lyric.length; k++) {
      if (sung ? lyric[k].flow?.pair === 1 && lyric[k + 1].flow?.pair === 2 : k % 2 === 0) couplets.push([lyric[k], lyric[k + 1]]);
    }
    allCouplets.push(...couplets);
    for (const [a, b] of couplets) {
      if (!want.has(a.id) && !want.has(b.id)) continue;
      // a line that stays (not being written, or recorded from the song's vocals) is what its partner rhymes with
      const stays = (l: Line) => (!want.has(l.id) || recorded(l)) && !!l.text.trim();
      const rule = (l: Line, partner: Line) =>
        `Line ${num.get(l.id)} must rhyme with line ${num.get(partner.id)} “${partner.text}” (-${analyzeLine(partner.text, lang).rhymeKey}).`;
      if (want.has(a.id) && stays(b)) rhymes.push(rule(a, b));
      if (want.has(b.id) && stays(a)) rhymes.push(rule(b, a));
      if (want.has(a.id) && want.has(b.id) && !stays(a) && !stays(b))
        rhymes.push(`Lines ${num.get(a.id)} and ${num.get(b.id)} rhyme with each other (option i with option i).`);
    }
  }
  const st = project.settings ?? {};
  const prompt = `PROJECT
Title: ${project.title}
Language: ${langName(lang)}
${st.genre ? `Genre: ${st.genre}\n` : ""}${st.style ? `Style: ${st.style}\n` : ""}${project.concept ? `Story / concept: ${project.concept}\n` : ""}
WHAT THE WRITER SANG over the beat to find the flow (recognised words per line; "(na-na)" = sounds without words):
${sang}

From these words, work out the song's topic, mood and imagery (e.g. love, longing, the night…) — the lyrics must be about that. Words or phrases the writer sang are their raw material: keep them where they fit.

THE SONG (rhythm per line: DUM = stressed syllable, ~ = the last note is held)
${listing}

${rhymes.length ? `RHYMES\n${rhymes.join("\n")}\n` : ""}
TASK
For every [WRITE] line write 3 options. Each option must:
- have exactly the line's number of syllables (sung syllables, ±1) with the stressed syllables on the DUM positions — it must fit the rhythm the writer sang;
- end on an open, singable vowel when the last note is held (~);
- respect its rhyme rule and continue the lines around it, so the song reads as one coherent text about the writer's topic.
The rhyme matters most: the last words of a couplet must truly rhyme — the same ending from the stressed vowel on (cuore / amore, notte / forte), not just one shared vowel — and in a couplet that is written together, option 1 rhymes with option 1, option 2 with option 2, option 3 with option 3.
When the writer sang real words in a line that isn't recorded, the FIRST option keeps them (completed and corrected into a full line); the others may go further. Make the 3 options clearly different.${
    vocals
      ? `\nLines marked "recorded" are the writer's own lyrics from the vocals in the song — they stay. For those, write 3 ALTERNATIVE lines: same rhythm and rhyme sound, same meaning direction, different wording — never the recorded line itself.`
      : ""
  }
Return one entry per [WRITE] line, "line" = its number.`;

  const parsed = await callJson<{ slots: { line: number; options: string[] }[] }>(project.id, "flow_suggest", prompt, DRAFT_SCHEMA, SYSTEM, DRAFT_EFFORT);
  const byNum = new Map(all.map((x, i) => [i + 1, x.l]));
  type Opt = { text: string; off: number; i: number };
  const opts = new Map<string, Opt[]>();
  for (const slot of parsed.slots) {
    const line = byNum.get(slot.line);
    if (!line || !want.has(line.id)) continue;
    const target = line.flow?.syllables ?? null;
    const fitted = slot.options
      .map((o) => o.trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((o, i) => {
        let text = o;
        // nudge a near miss onto the sung length (fillers / small cuts)
        if (target) {
          for (let step = 0; step < 3; step++) {
            const d = prosody(text, lang).syllables - target;
            if (Math.abs(d) <= 1) break;
            const next = adjustLength(text, lang, d > 0 ? -1 : 1);
            if (!next) break;
            text = next;
          }
        }
        return { text, off: target ? Math.abs(prosody(text, lang).syllables - target) : 0, i };
      });
    if (fitted.length) opts.set(line.id, fitted);
  }
  const rhymeScore = (x: string, y: string) => compareLines(analyzeLine(x, lang), analyzeLine(y, lang)).score;
  const fit = (o: Opt) => Math.min(o.off, 2);
  const done = new Set<string>();
  for (const [a, b] of allCouplets) {
    const oa = opts.get(a.id);
    const ob = opts.get(b.id);
    if (oa && ob) {
      // both written: option i of one goes with option i of the other — keep the pairs together, best rhyme first
      const n = Math.min(oa.length, ob.length);
      const order = Array.from({ length: n }, (_, k) => k).sort(
        (x, y) => rhymeScore(oa[y].text, ob[y].text) * 2 - (fit(oa[y]) + fit(ob[y])) * 0.5 - (rhymeScore(oa[x].text, ob[x].text) * 2 - (fit(oa[x]) + fit(ob[x])) * 0.5) || x - y,
      );
      opts.set(a.id, [...order.map((k) => oa[k]), ...oa.slice(n)]);
      opts.set(b.id, [...order.map((k) => ob[k]), ...ob.slice(n)]);
      done.add(a.id).add(b.id);
    } else {
      // one written, its partner stays: the options that rhyme with the partner first
      const [mine, partner] = oa ? [a, b] : [b, a];
      const o = opts.get(mine.id);
      if (!o || !partner.text.trim()) continue;
      opts.set(mine.id, [...o].sort((x, y) => rhymeScore(y.text, partner.text) * 2 - fit(y) * 0.5 - (rhymeScore(x.text, partner.text) * 2 - fit(x) * 0.5) || x.i - y.i));
      done.add(mine.id);
    }
  }
  return [...opts.entries()].map(([id, o]) => ({
    id,
    // not in a couplet: best fit first; the writer's own words (first option) win ties
    options: (done.has(id) ? o : [...o].sort((x, y) => fit(x) - fit(y) || x.i - y.i)).map((x) => x.text),
  }));
}

function patternOf(f: { syllables: number; stress: number[]; held: boolean }) {
  const s = new Set(f.stress);
  const parts = Array.from({ length: f.syllables }, (_, i) => (s.has(i + 1) ? "DUM" : "da"));
  if (f.held && parts.length) parts[parts.length - 1] += "~";
  return parts.join("-");
}
