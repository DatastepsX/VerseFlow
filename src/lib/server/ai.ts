import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { analyzeLine, lastWord } from "@/lib/rhyme/analyze";
import { rhymePartners } from "@/lib/scheme";
import { LANGUAGES, PROJECT_TYPES, type ProjectTree } from "@/lib/types";
import { rejectedAlternatives } from "./repo";

const MODEL = "claude-opus-5-5";

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
- Match the requested syllable count closely (±1) so the line is performable on the same beat.
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
      requirements.push(`Line ${n}: free ending (it sets the rhyme for following lines).`);
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
${avgSyl ? `Target length: about ${avgSyl} syllables per line${rhythmRefs.length ? " (from the rhythm reference)" : ""}.` : ""}
${req.instruction ? `Writer's direction: ${req.instruction}` : ""}
${current.length ? `Current text of the target (offer alternatives to it): ${current.join(" / ")}` : ""}
${rejected.length ? `Already rejected — do not repeat or closely paraphrase:\n${rejected.map((r) => `- ${r.text.replace(/\n/g, " / ")}`).join("\n")}` : ""}
Each option's "lines" array must contain exactly ${targetIdx.length} line${targetIdx.length > 1 ? "s" : ""}.`;

  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  if (response.stop_reason === "refusal") throw new Error("The AI declined this request. Try rephrasing the direction.");
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("Empty AI response");
  const parsed = JSON.parse(text.text) as { options: { lines: string[] }[] };
  const options = parsed.options
    .map((o) => o.lines.map((l) => l.trim()).filter(Boolean))
    .filter((o) => o.length === targetIdx.length)
    .slice(0, count);
  return { targetIds: targetIdx.map((k) => lines[k].id), options };
}
