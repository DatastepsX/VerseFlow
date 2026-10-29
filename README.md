# VerseFlow

AI-assisted songwriting and text-writing workspace. You write **line by line / couplet by couplet**, explicitly approve,
edit, decline or ask for alternatives on every line, and the full current version is always visible.
Approved lines are never changed by the AI.

Product spec: see the original `verseflow_product_spec.md` (Phase 1 + core of Phase 2/3 are implemented).

## The app (mobile, `/` → `/song/[id]`)

The home screen is a simple, app-like flow for the phone:

1. **＋ New song** → choose the beat (name, language; more options are tucked away).
2. **Record your flow**: the beat plays and you sing or rap anything over it (headphones recommended; without them,
   echo cancellation is used). The recording is analysed in the browser (`src/lib/flow`):
   - syllable onsets, strength and length come from the vocal energy envelope (`detectSyllables`);
   - the lines: when words were recognised, **your singing breaks the lines** — a pause (a breath) and the punctuation
     the recognition put there end a line; where you sing on without a break, **the rhyme decides**: lines pair up in
     couplets whose last words rhyme ("…la notte / …più forte"). Lines stay about a bar long and never end on "e",
     "che", "la"… (`rhymeSegments` in `src/lib/flow/rhymelines.ts`; `lines.flow.pair`). Suggestions rhyme with the
     sung partner; the Lyrics view shows each couplet together with its rhyme words marked. With only "na-na" ("pam pam
     para…"), your pauses break the lines too; where you sing on without a pause, lines are cut at the deepest dips
     near your own phrase length, learned from the phrases with clear pauses (`phraseSegments` in
     `src/lib/flow/phrases.ts`). Faint bumps in the pauses (breaths) don't count as syllables;
     stresses are the syllables that stand out from their neighbours or are leaned into (`flowLines`);
     each line stores its sung rhythm in `lines.flow` (syllables, stresses, held last note, recognised words);
   - the take is saved as a 16 kHz WAV (lane "Flow") and the words are recognised by ElevenLabs Scribe (1 call);
     if that fails, the lyrics follow the rhythm alone.
3. **A first version of the song**: 3 options per line, written to the sung rhythm and about what you sang
   (`flowSuggest`, 1 AI call per 8 lines, all running in parallel).
4. **Bar by bar**: the lyrics read like a sheet (just the text, a ✓ on kept lines); tap a line to open it — Play, its
   flow, Hear, ✓ keep · ↻ next option (free) · ✨ 3 new options (1 call) · ✎ edit · 🗑 remove — one line open at a time.
   The player plays the beat with your flow and highlights the line being sung.

**A track that already has vocals** (a demo with your voice) **is recognised automatically**: after uploading, the track
is listened to once (1 ElevenLabs call, stored and reused — also when there are no lyrics). Fewer than 8 recognised
words (after dropping sounds like "yeah", "oh") = a beat: the Flow tab asks for your flow. Otherwise the lyrics are
read from the track, every sung bar becomes a line with **your recorded words as its text** and their rhythm as its pattern
(`vocalLines` in `src/lib/flow/vocals.ts`; `lines.flow.source = "vocals"`), then 3 alternatives per line that fit that
rhythm and rhyme with the recorded partner line. **Parts without vocals** (4+ bars of silence between sung lines, 8+
before the first / after the last) become empty parts — placeholder lines at the song's line spacing (`emptyParts`).
They are written later: "🎤 Record your flow for this part" (the beat starts a bar before the part, recording stops at
its end, only that part's lines are replaced — `buildFlowPart`), or "✨ Write them" without a flow. Any part can be
redone the same way ("🎤 new flow" on its header). ↻ cycles through the alternatives and back to your recording; ✨ adds new
alternatives without replacing the line. Every line shows its flow (one mark per syllable, stressed ones tall, a held last
note long).

**Your voice (guide vocal)**: More → "My voice" (or 🗣 Hear the first time) records about a minute of your voice
(or takes uploaded acapella files) and makes a copy of it with ElevenLabs Instant Voice Cloning (1 call, needs a paid
ElevenLabs plan and the key's "Text to Speech" + "Voices" permissions; table `voices`). Then:
- **🗣 Hear** on a line: the line is spoken in your voice (1 call the first time; cached in `tts_cache` by voice + text,
  so replaying is free) and laid onto your flow in the browser (`src/lib/voice/guide.ts`): every word starts on the
  sung syllable it falls on (`lines.flow.times`) and is time-stretched with the pitch kept (WSOLA) to fit.
- **🗣 on** in the player: the whole song in your voice with the beat (asks first when lines still need a call).
It's a demo-quality guide for hearing whether lyrics fit — rap works best; it doesn't sing melodies.

**Flows** (the **Flow** button on each part, "Flow from here" on an opened line, "Set the flow" on an empty part, and
"Flow part by part" on the Flow tab): a flow is a pattern of **2 or 4 lines** (4: AABB or ABAB) that the part — or,
from a line on, the stretch until the next flow change — follows, one line per bar. Made by **Write** (the default:
type the lines; each syllable is a chip — tap: stressed, hold: long note, “+” between two: a pause), **Sing**, **Tap**
or **Sing+tap** (the part's first 2 or 4 bars after a count-in bar; example words until you write your own). Always
shown as text first; **Listen** plays the bars with clicks; **Use** lays the lines out again (`applyFlow`): your
written lines are the first lines (kept), the rest are written by the AI in the flow, rhyming (1 call per 8 lines);
earlier lyrics become drafts to rewrite. Every flow gets a name (Flow A, B…) and is in the list at the top of the
sheet, to reuse in any part (its rhythm). A change within a part shows a "Flow B from here" marker. Data: table
`flows` (`tree.flows`), `lines.flow.flowId / patternLine / scheme`; logic in `src/lib/flow/pattern.ts`.

**Sing + tap** (Flow tab, third option): you sing or rap while you tap. The taps decide the number of syllables and
(with "Next line") the lines; the voice moves each tap onto the syllable sung there (±0.12 s), gives its stress, and the
recognised words go to the AI (`processTaps` with a recording).

**Lyrics with their syllables**: every line reads as written, with one short segment under each sung syllable
(stressed ones in the accent colour, vowels merging across words sharing one — "tiene ancora" = tie·ne an·co·ra) and the
rhyme word coloured in a couplet — split with the same rules that count the syllables (`syllableParts` in
`src/lib/rhyme/syllabify.ts`, Romance languages), so the segments match the flow.

**Sing it or tap it** — every flow can be set either way: the Flow tab has a "Sing it | Tap it" switch (whole song or one
part; tapped on two pads: the big one once per syllable while the beat plays, "Next line" when a line is done — the
lines are exactly as marked; without "Next line", pauses start the lines — `processTaps`, no microphone, no word
recognition), empty parts offer "Sing it" / "Tap it", and each line's "Flow" panel offers "Sing" (that bar is
recorded and its syllables found on the phone, free) or "Tap".

**Tap one line** ("Flow" under a line → Tap): one bar of count-in (clicks), then the line's bar plays and you tap a
big pad once per syllable. Taps snap to 16th notes (two quick taps never merge); a tap on a beat is stressed. Right away
you see example words with exactly that rhythm — real words from a small built-in bank, no AI
(`exampleWords` in `src/lib/flow/example.ts`), e.g. "Ricordo piano passo" — "Other example" for another one. "Save"
makes it the line's flow (undoable like a text edit); "Write · 1 call" also writes 3 lyrics options for it. Empty
lines with a flow show example words as a placeholder, so you see how long each bar is. Grid logic:
`src/lib/flow/grid.ts`.

**Always rhymes**: every line has a rhyme partner — couplets as sung (`flow.pair`), the lines left over paired in order
(`coupletsOf` in `src/lib/flow/couplets.ts`, the same pairs on the screen and for the AI). A couplet whose endings
don't rhyme is marked ("“perché” and “passi” don't rhyme") with **Make it rhyme**: the best rhyming option of either
line goes in (free); when none rhymes, 3 new options for the 2nd line (1 call) and the best rhyming one goes in.
Options of a couplet written together stay paired (option i with option i), the best rhyming pair first.
↻ (next option) on a couplet line takes the options that rhyme with the other line *as it is now* first; the button
shows how many do ("2 · 1 rhyme").

**A new flow for a part with lyrics** (e.g. your recording): new line i gets the part's earlier line i as `flow.draft`,
and the AI rewrites it to the new rhythm — meaning and key words kept ("Ti scrivo piano senza chiedere perché" →
6 tapped syllables: "Ti scrivo dentro me").

**Record** (tab; `Record.tsx`, `recorder.ts`): your voice for each part on layers (Lead, Double, Ad-libs, + your
own), over the beat with the part's lyrics following. One big button: count-in (the beats left) → recording →
stop (the take is saved and used) · "Again" throws the take away and starts over. Every layer keeps its takes:
▶ play (with the other layers), "Use" the one in the song, delete. On a phone you choose **This phone** or
**My Mac**: with "My Mac" the phone is the remote for the Mac (its microphone or sound card) — same screen, the Mac
records. Settings: count-in, click, lyrics size, microphone (+ interface input), headphones (off: the beat from the
speaker is filtered out), timing (estimated, or measured once). The old `/p/[id]/studio` and `/p/[id]/remote` URLs
redirect there.

**Sound library** (Record → "Sound of the Lead"; `src/lib/fx`): every layer gets a sound from a library of
modern vocal chains — Clean (Studio vocal, Pop shine, Rap upfront), Space (R&B smooth, Dreamy), Autotune (Trap
autotune = hard-tuned to the song's key, Melodic rap, Soft tune), Character (Phone / lo-fi, Megaphone, Dark & close,
Deep voice, High voice) and for layers (Wide double, Ad-lib echo). Tap one: it's saved for the song
(`settings.fx`) and plays at once on the layer's take. Built with Web Audio (EQ, compressor, saturation, a
generated reverb, echoes on the song's tempo, stereo width; loudness-matched presets); autotune and voice up /
down re-pitch the take in the browser (YIN pitch + TD-PSOLA, `tune.ts`) to the key found in the beat (`key.ts`,
changeable). The recording itself never changes. No API calls.

**Remove the vocals** (More → "The song's vocals"; `separateVocals` in `src/lib/server/transcribe.ts`): one
ElevenLabs stem-separation call (`two_stems_v1`) splits the uploaded song into its vocals and the music without them;
both are stored next to the song (`audio_tracks.instrumental_path` / `vocals_path`), which stays as uploaded. Then
"Music only" / "With the vocals" chooses what plays, records and flows use (saved per song on the device).

**Sync words to a take** (Record → a take → "Sync words · 1 call"; `alignTake` in `src/lib/server/transcribe.ts`,
`src/lib/flow/align.ts`): one ElevenLabs forced-alignment call with the take and the written lines it sings (those
starting inside it, else its part's). Every sung syllable gets the time it was rapped: the lines' `flow.times` (karaoke,
guide voice, flow grid) and `audio_at` follow the take. One undo step; logged as `ai_calls.kind = "align"`.

**Parts** (tap a part's name in Lyrics): rename; merge with the part before / after; **make it longer** (+2/4/8
bars, `extendSection` in `repo.ts`): the part's last bars of the beat repeat where it ends, everything after moves
later (parts, lines, flows, takes, beat changes), and the new bars get empty lines. The uploaded file stays as it is:
`settings.extensions` lists the added bars and `src/lib/audio/arrange.ts` applies them when the song loads. One undo
step (the version saved before keeps the timing too). Each part's header also has **Vocals** (the original vocals
on/off there) and **Hear** (the whole part in your voice on its flow, 1 call per line not spoken yet).

**Writing a part after its flow** (flow sheet → "This is the flow · next"): confirm the flow, keep your sung lines
or use only their rhythm, and give the part a **brief** — mood, perspective (me / to you / us / a story), words
(modern, street, poetic, simple, + English, images), rhymes (clean / multi-syllable / inner), what it is about, words
to use (`src/lib/brief.ts`). The brief is kept per part (`settings.briefs`) and every AI writing for the part follows
it (`partBrief` / `flowSuggest` in `ai.ts`). "Flow only, write later" applies the flow without a call.

**Several devices:** a song open on more than one device follows the changes made on any of them within ~3 s
(`project_version` in the database, `/api/projects/[id]/version`). **Main device** (Settings, or This phone / My Mac
in Record — `vf.studio.main`, kept with the profile): with the Mac as the main device the phone is its remote for the
whole song — the tab and part opened on the phone open on the Mac, play / stop / Hear play there (remote commands
`nav`, `songPlay`, `songStop`).

**Cutting a take** (Record → a take → ✂ Cut): its start and end (`takes.trim_in` / `trim_out`); the recording stays
whole, only the cut plays (`PlayLayer.clip`), and "The whole take again" undoes it.

**Your settings** (`/settings`: the slider button on Home, More → Your settings, Record → Settings): recording
(count-in, click, lyrics size, headphones), timing, your voice, the ElevenLabs account, appearance — the same in every
song and on every device. Kept with the profile (table `user_settings`, one row; `/api/profile`), with a copy in the
browser for a fast start (`src/lib/client/profile.ts`, `usePref`). The timing is kept per kind of device
(`vf.studio.latency[.vp].iPhone`, `.Mac`…): each has its own delay. The microphone choice stays on the device.

**Undo / redo** (top bar, ⌘Z): one step per action (`undo_steps`; a multi-request action sends one `x-undo-step`).
A rebuilt song is undone by restoring the version saved before it.

**Appearance** (More): Automatic / Light / Dark, saved on the device (`ThemePicker.tsx`, `data-theme` on `<html>`).

**Working together** (More → People): with accounts on (`APP_PASSWORD` set), everyone signs in with their own
account (`/login`; email + password, `users`, scrypt; a signed `vf_session` cookie, `src/lib/auth.ts`). Making an
account needs the access code (`APP_PASSWORD`) or a song's invitation link (`/join/[token]`, `invites`, 14 days). The
first account made with the code becomes the owner of every song from before accounts. Roles per song
(`project_members`): owner (shares, deletes), editor (writes, records, mixes), listener (listens, leaves notes). Every
route checks the role first (`access()` in `src/lib/server/users.ts`); someone not on a song gets "not found". Takes
remember who recorded them (`takes.created_by`), notes carry the account's name. Settings, the main device and the
remote are per person (`user_settings` rows `me:<id>`, `nav:<id>`, `host:<id>`); the shared voice is changed only by
people who joined with the code. Without `APP_PASSWORD` there are no accounts and everything is open, as before.

The full editor (`/p/[id]`) is still there under **More → Advanced**.

## What works today (full editor)

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
- **Beat grid & beat changes** (`src/lib/audio/structure.ts`, in the browser): exact tempo (no rounding) and bar 1
  fitted over the whole song (bar 1 = where the arrangement changes + kick), plus the bars where the beat changes
  (bar-synchronous timbre/harmony self-similarity). Typing the BPM or ÷2/×2 refits the grid; “🧲 Snap sections to
  the beat” also moves every section start onto the nearest beat change (≤ ~1 bar / 2.5 s) or bar line. Sections
  created from the lyrics start on beat changes too.
- **Studio — record takes** (the song app's **Record** tab; `src/lib/studio/`): record vocals per section
  over the beat on layers (Lead, Double, Ad-libs, + your own), any number of takes, "Use" the one in the song. One audio
  clock drives beat, other layers and the recorder (AudioWorklet, raw input: no echo cancellation / noise
  suppression / auto gain), so takes land on the beat to the sample; count-in (0–2 bars, optional click), auto-stop
  a bar after the section, latency compensation (reported by the hardware or measured once: clicks
  played and recorded back). Takes are 24-bit WAVs in storage (`takes` table, `start_at` = where they start on the
  beat). Lyrics follow the beat while recording. Keys on a computer: R = record, Space = play / stop.
- **Phone as remote** (Record → My Mac): the computer that records publishes its state and runs the phone's
  commands (part, layer, record, stop, again, play a take, use, delete, new layer, count-in). Both go through the API
  with long-polling (`/api/projects/[id]/remote`, tables `studio_commands` / `studio_state`), so the phone needs no
  direct connection; the Mac just keeps the song open on Record.
- **Performers** (`src/lib/artists.ts`, `Artists.tsx`): a song's singers / rappers (name, colour, voice/style note) in
  `projects.settings.artists`; sections list who performs them (`sections.artists`, several allowed — e.g. a chorus
  sung by two). 🎤 next to a section name assigns them, and they carry on to the following sections until a section gets
  new ones (carried performers show outlined); Settings → Performers renames / recolours / removes. Shown
  in the section chips, Full text and exports (“CHORUS (Marco & Anna)”), and Record mode can show one performer's
  parts with the others dimmed. AI prompts write each section in its performers' voice.
- **Start from existing text** (`src/lib/text-import.ts`): paste lyrics or a poem in the new-project form —
  `[Verse 1]` / `Chorus:` / `## Hook` headings or blank lines between stanzas become sections (a repeated stanza is the
  chorus); lines come in as drafts. Pasting several lines into “Write the next line…” adds them all.
- **New pattern → adapt the lines** (refit draft mode): after a section's pattern changes, “♩ Adapt N lines” rewrites
  every line to the new syllables / stresses keeping meaning and rhyme (1 call per ~8 lines, parallel). Drafts take the
  new version and keep the old one as an option (↻); approved lines are never changed — they get the versions as
  options. “♩ fit lines” next to the pattern does the same any time.
- **Remove / renew suggestions**: a line's options box has “🗑 Remove all”; the next-bar suggestions have “✨ New
  suggestions · 1 call” (replaces the unused set) and “🗑 Clear suggestions” (free).
- **✨ Polish N lines** (section panel, 1 call per ~8 lines, parallel): 3 improved versions of every line not yet
  approved, stored as options (↻ on the line) — the text itself is never replaced.
- **New project with its song**: the new-project form takes the MP3 (title from the file name); optionally it reads
  the lyrics right away (1 ElevenLabs call) and rebuilds the song from them. Upload logic: `src/lib/client/beat.ts`.
- **Rebuild the song from the vocals** (`src/lib/audio/song-lines.ts`, Lyrics dialog, free): lines as they are sung
  (every sentence starts a new line, pauses end lines, double-length lines split at their comma, lone words join the
  next line) and sections as they are performed — fast delivery (≥ ~6 syllables/s) is **Rap**, repeated blocks are
  **Chorus** / **Bridge** (lines that recur together), the rest **Verse**, long gaps **Break**, starts on the beat.
  A version is saved first. By hand: a line's ⋯ → “✂ New section from here”, a section's ⚙ → “Merge into previous”.
- **Line timing on the beat** (`src/lib/audio/timeline.ts`): the highlight follows each line's real start —
  “🎯 Sync to vocals” aligns the written lines with the transcribed vocals (word-level alignment, no API call; also
  runs after taking lyrics over), “👆 Tap along” lets the writer tap when lines start (stored in `lines.audio_at`);
  lines in between share the time by their syllables, so short lines get less time than long ones.
- **Follow the song**: while the beat plays, the current line is highlighted and kept in view in Write, Full text
  and Bars (the section's bars), with a “now playing” strip (line + next line); scrolling by hand pauses following
  for a few seconds, and typing never moves the page (`follow.ts`, `NowPlaying.tsx`).
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
`project_versions`, `bank_lines`, `ai_calls`, `audio_tracks`, `transcripts`; storage bucket `beats`). The DB key is used **server-side only**. Access: user accounts and roles per song (see "Working
together"); `users`, `project_members`, `invites`, `line_notes`, `shares`.

## Environment variables

| Name | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase API key (server only) |
| `ANTHROPIC_API_KEY` | enables AI suggestions (optional — the app works without it) |
| `APP_PASSWORD` | turns accounts on; also the access code for making an account without an invitation (if unset, the app is open) |
| `SESSION_SECRET` | optional, signs the sign-in cookie (default: `APP_PASSWORD`; changing it signs everyone out) |
| `ELEVENLABS_API_KEY` | lyrics recognition (Scribe), your cloned voice and the guide vocal (needs the Speech to Text, Text to Speech and Voices permissions) |
| `TTS_MODEL` | optional, ElevenLabs voice model for the guide vocal (default `eleven_multilingual_v2`) |
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
