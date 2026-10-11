# VerseFlow

AI-assisted songwriting and text-writing workspace. You write **line by line / couplet by couplet**, explicitly approve,
edit, decline or ask for alternatives on every line, and the full current version is always visible.
Approved lines are never changed by the AI.

Product spec: see the original `verseflow_product_spec.md` (Phase 1 + core of Phase 2/3 are implemented).

## What works today

- **Projects** (song, rap, poem, speech, …) with language, concept and style settings
- **Sections** (Part I, Hook, Bridge…) with grouping (single lines / couplets / quatrains), rhyme scheme, story beat, intensity, notes
- **Lines** with statuses `OPEN · SUGGESTED · APPROVED · APPROVED_EDITED · DECLINED · NEEDS_NEW_OPTIONS`
  - Use / Edit / Decline / Unlock, insert above/below, move, delete, notes
  - mark a line as **rhythm reference** (prosody template, ignored as lyric)
- **Rhyme engine** (`src/lib/rhyme`) running live in the browser:
  - Italian phonetics: stress (piana / tronca / sdrucciola), rhyme key from the stressed vowel, metric syllables with synalepha
  - perfect rhyme, assonance and multi-syllable (rap) rhyme depth between lines
  - automatic rhyme-scheme letters (A, B, …) per section, partner check (“should rhyme with line 3”), syllable target per section
  - English: heuristic analysis (Datamuse for the rhyme dictionary)
- **Rhyme dictionary** (`/api/rhymes`): Italian index of ~120k words ranked by frequency; English via Datamuse
- **Section pattern & draft workflow**: each section has its own *pattern* (⚙/♩ “Set pattern”: 1–2 lines that only
  define rhythm, length and stresses — not lyrics; copyable between sections). “✨ Fill N bars · K calls” (one call per ~8 bars, all running in parallel with low thinking effort — `AI_DRAFT_EFFORT` — so 40 bars take about as long as 8) drafts every
  open bar of the section (count from its length on the beat) with 3 options each, following the pattern, the rhyme
  scheme and the surrounding text (`draftSection` in `src/lib/server/ai.ts`). Review pass: ✓ keep / ✕ to replace /
  ↻ next option (free) on each row; “↻ Replace N marked” (one call per ~8 bars) rewrites only the ✕ bars to fit the kept ones.
- **Line timing on the beat** (`src/lib/audio/timeline.ts`): the highlight follows each line's real start —
  “🎯 Sync to vocals” aligns the written lines with the transcribed vocals (word-level alignment, no API call; also
  runs after taking lyrics over), “👆 Tap along” lets the writer tap when lines start (stored in `lines.audio_at`);
  lines in between share the time by their syllables, so short lines get less time than long ones.
- **Selecting a bar moves the beat** to that bar; tapping a section (chips / Structure list) moves it to the section start.
- **Suggestion bank (low API usage)**: one AI call writes ~30–40 bars for a section, organised as *rhyme families*
  (lines sharing an end rhyme, written so consecutive pairs form couplets). Next-bar suggestions are then served
  **locally** from the bank (`src/lib/suggest.ts`): a slot that must rhyme only gets bars that the rhyme engine
  confirms rhyme, ranked by **rhythm match with the line before** (`src/lib/rhyme/prosody.ts`: sung syllables
  with synalepha, stress positions aligned from the line end, ending type; bars > 2 syllables off are hidden while
  closer ones exist); an opening slot gets one bar per family, preferring families that still have partners; after
  using a bank bar, its couplet partner ranks first. Rejected bars are never shown again and are sent as
  "avoid" in the next fill. A new AI call is only offered when nothing in the bank fits (e.g. “Get bars rhyming
  with ‘distante’”), or explicitly via a line's “AI options”.
- **AI options on demand** (Claude): 3 options for a line or a whole couplet, with quick directions
  (shorter, more aggressive, better rhyme, fit rhythm, …) — each is one call, labelled in the UI.
- **Usage tracking**: every AI call is logged (`ai_calls`: kind, model, tokens); the header shows calls/tokens per project.
- **History**: every line change is an event → undo / redo (Ctrl/Cmd+Z), restore a previous text, named **versions** with restore
- **Full version** panel with copy / .txt / .md export (all lines or approved only)
- **Beat upload & BPM** (🎵 Beat): upload an MP3/WAV/M4A (≤ 50 MB, stored in Supabase Storage bucket `beats`,
  uploaded directly from the browser via a signed URL). Tempo and the bar grid (bar 1 position) are detected in the
  browser (`src/lib/audio/tempo.ts`, no API cost); correct with ÷2 / ×2, edit the BPM, or “bar 1 here”.
- **Song map**: waveform with section regions; while playing, anchor any section at the current position (snapped to
  the bar) or create “+ New section here”. Each section shows ▶ start time, length in bars, and 🔁 loop. During
  playback the line for the current bar is highlighted (setting “one line = ½ / 1 / 2 / 4 bars”).
- **Lyrics from the beat** (🎤 in the player): one ElevenLabs Scribe call (`src/lib/server/transcribe.ts`; the service
  fetches the beat itself from a signed storage URL) returns timed words, stored in `transcripts`.
  `src/lib/audio/lyrics.ts` turns them into one line per bar (pickups belong to the next bar), detects sections
  (Intro / verses / repeated chorus-hook / Break / Outro) or uses your anchored sections, and fills **only empty or
  missing lines** as *Suggested*. Preview and re-applying the stored transcript are free; “Re-read” is a new call.
- **Recording mode** (`/p/:id/record`) — plays the beat and follows the current line: dark, large type, A−/A+, line numbers, auto-scroll, jump to section
- Mobile layout with bottom tabs (works as a home-screen web app; native iOS app later via the same JSON API)

## Architecture

```
Next.js 16 (App Router, React 19, Tailwind 4)  — deployed on Vercel
├─ src/app/api/*          JSON API (also intended for the future iOS app)
├─ src/lib/server/repo.ts data access + history/undo/versions (Supabase Postgres)
├─ src/lib/server/ai.ts   Claude prompt building + structured output
├─ src/lib/rhyme/*        phonetics, rhyme comparison, scheme detection, dictionary
├─ src/lib/scheme.ts      intended rhyme partners from the section scheme
└─ src/components/writer  the editor UI
```

Database: Supabase project `verseflow` (tables `projects`, `sections`, `lines`, `alternatives`, `line_events`,
`project_versions`, `bank_lines`, `ai_calls`, `audio_tracks`, `transcripts`; storage bucket `beats`). The DB key is used **server-side only**. Until user accounts exist, access is protected by a
single shared password (`APP_PASSWORD`).

## Environment variables

| Name | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase API key (server only) |
| `ANTHROPIC_API_KEY` | enables AI suggestions (optional — the app works without it) |
| `APP_PASSWORD` | shared access password (if unset, the app is open) |
| `ELEVENLABS_API_KEY` | enables “Lyrics from beat” (speech-to-text with ElevenLabs Scribe) |
| `AI_MODEL` | Claude model (default `claude-opus-5-5`; e.g. `claude-sonnet-5-5` / `claude-haiku-5-5` cost less) |
| `AI_EFFORT` | `low` / `medium` (default) / `high` — lower = fewer thinking tokens |
| `AI_DRAFT_EFFORT` | effort for section drafts (Fill / Replace): `low` (default) / `medium` / `high` |

## Development

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # rhyme engine tests
npm run lint
npm run build
```

## Next steps (planned)

User accounts & per-user data (Supabase Auth + RLS), story-arc generation from the concept, style learning from
accepted/rejected options, song map, PDF/DOCX export, collaboration, iOS app.
