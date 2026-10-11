@AGENTS.md

# VerseFlow — notes for coding agents

- Read README.md for the feature list and architecture.
- Data access goes through `src/lib/server/repo.ts`; every line mutation must go through `updateLine` / `addLine` /
  `deleteLine` so a `line_events` row is written (undo/redo + history depend on it).
- Mutating API routes return the full project tree (`treeResponse`); the client replaces its state with it.
- Rhyme/syllable logic is pure TS in `src/lib/rhyme` and runs in the browser and on the server. Run `npm test`
  after changing it.
- Schema changes: apply a migration to the Supabase project `verseflow` (ref `vqrwahhhusessvzvqfqb`) and keep
  `src/lib/types.ts` in sync.
- Never let the AI modify lines with status APPROVED / APPROVED_EDITED; AI output is stored as `alternatives`.
- Keep API usage low: next-bar suggestions come from the section's `bank_lines` via `src/lib/suggest.ts` (no API
  call). Only add new AI calls when the user explicitly asks, label them in the UI ("· 1 call"), and log them
  through `callJson` in `src/lib/server/ai.ts` (records `ai_calls`).
