export type LineStatus =
  | "OPEN"
  | "SUGGESTED"
  | "APPROVED"
  | "APPROVED_EDITED"
  | "DECLINED"
  | "NEEDS_NEW_OPTIONS";

export type LineKind = "lyric" | "rhythm_ref";

export type ProjectType =
  | "song"
  | "rap"
  | "poem"
  | "spoken_word"
  | "marketing"
  | "speech"
  | "story"
  | "free_text";

export const PROJECT_TYPES: { value: ProjectType; label: string }[] = [
  { value: "song", label: "Song" },
  { value: "rap", label: "Rap" },
  { value: "poem", label: "Poem" },
  { value: "spoken_word", label: "Spoken word" },
  { value: "marketing", label: "Marketing copy" },
  { value: "speech", label: "Speech" },
  { value: "story", label: "Story" },
  { value: "free_text", label: "Free text" },
];

export const LANGUAGES: { value: string; label: string }[] = [
  { value: "it", label: "Italiano" },
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "de", label: "Deutsch" },
  { value: "fr", label: "Français" },
];

/** a performer of the song (singer, rapper, featured artist…) */
export interface Artist {
  id: string;
  name: string;
  color: string;
  /** voice / style, used by the AI when it writes their parts */
  notes?: string;
}

export interface ProjectSettings {
  /** recording layers (Lead, Double, Ad-libs…) */
  lanes?: string[];
  /** the sound of each layer: an effect preset id (lib/fx/presets; none: raw) */
  fx?: Record<string, string>;
  /** where the song's original vocals are out (once removed): everywhere ("all", the default) or these parts */
  vocalsOff?: "all" | string[];
  /** the song's key for autotune (found in the beat, or chosen); "chromatic": every semitone is a note */
  songKey?: { root: number; minor: boolean } | "chromatic";
  /** the performers; sections list the ids of who performs them */
  artists?: Artist[];
  genre?: string;
  mood?: string;
  style?: string;
  bpm?: number;
  simpleLanguage?: boolean;
  explicitness?: "none" | "medium" | "high";
  rhymePreference?: string;
  secondaryLanguage?: string;
  /** when the whole-song suggestion bank was last prepared, and from which pattern lines */
  songBankAt?: string;
  songBankPattern?: string[];
}

export interface Project {
  id: string;
  title: string;
  type: ProjectType;
  language: string;
  concept: string | null;
  settings: ProjectSettings;
  created_at: string;
  updated_at: string;
}

export interface Section {
  id: string;
  project_id: string;
  name: string;
  position: number;
  /** 1 = single lines, 2 = couplets, 4 = quatrains */
  group_size: number;
  story_beat: string | null;
  intensity: number | null;
  rhyme_scheme: string | null;
  notes: string | null;
  /** where this section starts in the uploaded beat (seconds) */
  audio_start: number | null;
  /** how many musical bars one written line spans (1 = one line per bar) */
  bars_per_line: number;
  /** rhythm template for this section (1–2 lines, not part of the lyrics) */
  pattern: string | null;
  /** ids of the performers (project settings → artists) */
  artists: string[];
}

export interface AudioTrack {
  filename: string;
  duration: number | null;
  bpm: number | null;
  /** time of bar 1, beat 1 (seconds) */
  beat_offset: number;
  beats_per_bar: number;
  /** bar starts where the arrangement changes (detected from the beat) */
  changes: { t: number; s: number }[] | null;
  /** the song without its vocals (stem separation), when made */
  instrumental_path?: string | null;
}

export interface Line {
  id: string;
  project_id: string;
  section_id: string;
  position: number;
  text: string;
  status: LineStatus;
  kind: LineKind;
  note: string | null;
  /** where the line starts in the beat (s): synced from the vocals or tapped; null = estimated */
  audio_at: number | null;
  /** the rhythm the writer sang for this line in a flow take */
  flow: LineFlow | null;
  updated_at: string;
}

export interface Alternative {
  id: string;
  line_id: string;
  text: string;
  source: "ai" | "user";
  state: "pending" | "selected" | "rejected";
  instruction: string | null;
  created_at: string;
}

/** A pre-generated bar in a section's suggestion bank (served locally, no API call). */
export interface BankLine {
  id: string;
  section_id: string;
  /** lines of the same family share an end rhyme; consecutive pairs (0-1, 2-3…) were written as couplets */
  family: string;
  family_pos: number;
  text: string;
  state: "available" | "used";
}

export interface AiUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

export interface ProjectTree {
  project: Project;
  sections: (Section & { lines: (Line & { alternatives: Alternative[] })[] })[];
  /** bank lines (available + used) of all sections */
  bank: BankLine[];
  usage: AiUsage;
  audio: AudioTrack | null;
  /** recorded vocal takes */
  takes: Take[];
  /** the song's flows (patterns parts follow) */
  flows: SongFlow[];
  /** undo / redo: how many steps each way, and what the next one is */
  history?: { undo: number; redo: number; undoLabel: string | null; redoLabel: string | null };
}

/** a recorded vocal take of a section on one layer (Lead, Double, Ad-libs…) */
export interface Take {
  id: string;
  section_id: string | null;
  lane: string;
  take_no: number;
  /** where the recording starts on the beat (seconds, latency-compensated) */
  start_at: number;
  duration: number;
  sample_rate: number;
  peaks: number[] | null;
  /** the take used for playback and exports (one per section + layer) */
  chosen: boolean;
  created_at: string;
}

export interface LineEvent {
  id: number;
  line_id: string;
  action: string;
  before: Partial<Line> | null;
  after: Partial<Line> | null;
  undone: boolean;
  created_at: string;
  /** the undo step (user action) it belongs to */
  step_id?: number | null;
}

export interface ProjectVersion {
  id: string;
  label: string;
  created_at: string;
}

/** what the writer sang in a line's place while recording the flow */
export interface LineFlow {
  syllables: number;
  /** stressed syllables, 1-based */
  stress: number[];
  /** the last note is held */
  held: boolean;
  /** recognised words ("" = only "na-na") */
  words: string;
  /** "vocals": read from the vocals in the uploaded song — the words are the writer's lyrics and stay */
  source?: "flow" | "vocals";
  /** song time where each sung syllable starts, and where the line's singing ends (the guide voice follows them) */
  times?: number[];
  end?: number;
  /** 1 / 2 = first / second line of a rhyming couplet (the line ends on the rhyme), 0 = on its own */
  pair?: 0 | 1 | 2;
  /** the line's text before a new flow was set for its part: rewritten to the new rhythm (meaning and key words kept) */
  draft?: string;
  /** the song flow this line follows (flows table), which of its pattern lines, and its rhyme scheme */
  flowId?: string;
  patternLine?: number;
  scheme?: "AABB" | "ABAB";
}

/** one line of a flow pattern: its syllables as written, sung or tapped */
export interface PatternLine {
  /** the words (written, or example words) */
  text: string;
  /** the writer wrote these words: they become the lyrics where the flow is first used (see ownWords) */
  written: boolean;
  /** sung or tapped: its timing is the recording's (example words until the writer types their own) */
  sung?: boolean;
  syllables: number;
  /** stressed syllables, 1-based */
  stress: number[];
  /** long (held) syllables, 1-based */
  long: number[];
  /** a pause after these syllables, 1-based */
  pauses: number[];
  /** where each syllable starts, seconds from the bar line */
  offsets: number[];
}

/** a flow: 2 or 4 pattern lines that repeat through a part (or a stretch of it) */
export interface FlowPattern {
  lines: PatternLine[];
  /** 4 lines: two couplets (AABB) or crossed (ABAB) */
  scheme: "AABB" | "ABAB";
  /** the bar length (s) the offsets were made for */
  bar: number;
  source: "write" | "sing" | "tap" | "both";
}

export interface SongFlow {
  id: string;
  /** "Flow A", "Flow B"… */
  name: string;
  pattern: FlowPattern;
  created_at: string;
}
