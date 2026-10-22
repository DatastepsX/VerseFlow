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
}
