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
- **AI alternatives** (Claude): 3 options for a line, a whole couplet, or the next line; quick directions
  (shorter, more aggressive, better rhyme, fit rhythm, …). The prompt receives locked lines, rhyme requirement,
  syllable target, story beat, style settings and previously rejected options.
- **History**: every line change is an event → undo / redo (Ctrl/Cmd+Z), restore a previous text, named **versions** with restore
- **Full version** panel with copy / .txt / .md export (all lines or approved only)
- **Recording mode** (`/p/:id/record`): dark, large type, A−/A+, line numbers, auto-scroll, jump to section
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
`project_versions`). The DB key is used **server-side only**. Until user accounts exist, access is protected by a
single shared password (`APP_PASSWORD`).

## Environment variables

| Name | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase API key (server only) |
| `ANTHROPIC_API_KEY` | enables AI suggestions (optional — the app works without it) |
| `APP_PASSWORD` | shared access password (if unset, the app is open) |

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
