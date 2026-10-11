import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { analyzeLine, lastWord } from "@/lib/rhyme/analyze";
import { describeRhythm, prosody } from "@/lib/rhyme/prosody";
import { rhymePartners } from "@/lib/scheme";
import { sectionPattern } from "@/lib/pattern";
import { sectionLineTarget } from "@/lib/audio/song-map";
import { LANGUAGES, PROJECT_TYPES, type ProjectTree } from "@/lib/types";
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
  const partners = rhymePartners(lines.map((l) => l.text), g, section.rhyme_scheme);
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
${otherSections ? `OTHER SECTIONS (context only)\n${otherSections}\n\n` : ""}CURRENT SECTION: ${section.name}${section.story_beat ? `\nStory beat: ${section.story_beat}` : ""}${section.intensity ? `\nEmotional intensity: ${section.intensity}/10` : ""}${section.notes ? `\nNotes: ${section.notes}` : ""}
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

async function callJson<T>(projectId: string, kind: string, prompt: string, schema: object, system = SYSTEM): Promise<T> {
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    ...(FALLBACKS ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: schema as Record<string, unknown> } },
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
${otherSections ? `OTHER SECTIONS (context only)\n${otherSections}\n\n` : ""}CURRENT SECTION: ${section.name}${section.story_beat ? `\nStory beat: ${section.story_beat}` : ""}${section.intensity ? `\nEmotional intensity: ${section.intensity}/10` : ""}${section.notes ? `\nNotes: ${section.notes}` : ""}
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
 * One call for a section:
 * - "fill": write every empty bar slot (up to the section's length)
 * - "replace": write only the bars the writer marked to replace (✕)
 * Each slot gets 3 options that follow the section's pattern, the rhyme
 * scheme and the context of the bars that are kept.
 */
/** bars written per call — keeps each call well inside the function time limit */
export const DRAFT_CHUNK = 8;

/**
 * Drafts the next chunk of a section's open bars (whole line groups, about
 * DRAFT_CHUNK bars). `remaining` = open bars left for the next call.
 */
export async function draftSection(tree: ProjectTree, sectionId: string, mode: "fill" | "replace", instruction?: string) {
  if (!aiConfigured()) throw new AiUnavailable("AI is not configured yet (ANTHROPIC_API_KEY missing).");
  const { project } = tree;
  const lang = project.language;
  const section = tree.sections.find((s) => s.id === sectionId);
  if (!section) throw new Error("Section not found");
  const pattern = sectionPattern(section);
  const lyrics = section.lines.filter((l) => l.kind === "lyric");
  const n = mode === "fill" ? Math.max(sectionLineCount(tree, sectionId), lyrics.length) : lyrics.length;
  const texts = Array.from({ length: n }, (_, k) => lyrics[k]?.text ?? "");
  const isSlot = (k: number) => {
    const l = lyrics[k];
    if (!l || !l.text.trim()) return mode === "fill" || !!l;
    return NEEDS.has(l.status);
  };
  const open = Array.from({ length: n }, (_, k) => k).filter(isSlot);
  if (!open.length) return { slots: [] as DraftSlot[], remaining: 0 };
  const g = Math.max(1, section.group_size);
  // take whole groups (couplets stay together) until the chunk is full
  const slots: number[] = [];
  for (const k of open) {
    if (slots.length >= DRAFT_CHUNK && Math.floor(k / g) !== Math.floor(slots[slots.length - 1] / g)) break;
    slots.push(k);
  }
  const slotSet = new Set(slots);
  const later = new Set(open.filter((k) => !slotSet.has(k)));

  const partners = rhymePartners(texts.map((t, k) => (slotSet.has(k) || later.has(k) ? "x" : t)), g, section.rhyme_scheme);
  const rhymeRules = slots
    .map((k) => {
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
    if (l?.text.trim()) rejected.add(l.text.trim());
    for (const a of l?.alternatives ?? []) rejected.add(a.text.trim());
  }
  for (const k of slots) {
    const l = lyrics[k];
    if (l) for (const r of await rejectedAlternatives(l.id)) rejected.add(r.text.trim());
  }

  const listing = texts
    .map((t, k) => `${k > 0 && k % g === 0 ? "\n" : ""}${k + 1}. ${slotSet.has(k) ? "[OPEN]" : later.has(k) ? "[LATER]" : "[KEEP]"} ${slotSet.has(k) || later.has(k) ? "" : t}`)
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
${others ? `REST OF THE SONG (context — stay consistent with it)\n${others}\n\n` : ""}SECTION: ${section.name}${section.story_beat ? `\nStory beat: ${section.story_beat}` : ""}${section.intensity ? `\nIntensity: ${section.intensity}/10` : ""}${section.notes ? `\nNotes: ${section.notes}` : ""}
Lines grouped in ${g === 2 ? "couplets" : g === 1 ? "single lines" : `groups of ${g}`}. [KEEP] lines are fixed — never change them; write only the [OPEN] lines. [LATER] lines are written in a later step — skip them, but leave room for the text to continue there.
${listing}

${template || "Keep lines a natural, performable length."}
${rhymeRules ? `RHYMES\n${rhymeRules}` : ""}

TASK
For every [OPEN] line write 3 different options. Each option must follow the rhythm template, respect its rhyme rule, and connect naturally with the lines before and after it (the section must read as one coherent text that fits the rest of the song). Vary images and wording between options.
${instruction ? `Writer's direction: ${instruction}` : ""}
${rejected.size ? `Rejected before — do not repeat or closely paraphrase:\n${[...rejected].slice(0, 40).map((t) => `- ${t}`).join("\n")}` : ""}
Return one entry per [OPEN] line, "line" = its number.`;

  const parsed = await callJson<{ slots: { line: number; options: string[] }[] }>(project.id, mode === "fill" ? "section_fill" : "section_replace", prompt, DRAFT_SCHEMA);
  const drafted = parsed.slots
    .map((x) => ({ index: x.line - 1, options: x.options.map((o) => o.trim()).filter(Boolean).slice(0, 3) }))
    .filter((x) => slotSet.has(x.index) && x.options.length);
  return { slots: drafted, remaining: later.size };
}
