/**
 * Record on "My Mac": the phone sends commands; the Mac runs them (it owns
 * the audio interface and the microphone) and publishes its state. Both go
 * through the app's API (long-polling), no direct connection needed.
 */

export type RemoteCmd =
  | { t: "select"; sectionId: string }
  | { t: "record"; lane: string }
  | { t: "retake"; lane: string }
  | { t: "discardLast"; lane: string }
  | { t: "choose"; takeId: string }
  | { t: "delete"; takeId: string }
  | { t: "shift"; takeId: string; by: number }
  | { t: "play" }
  | { t: "playTake"; takeId: string }
  | { t: "stop" }
  | { t: "addLane"; name: string }
  | { t: "countIn"; bars: number }
  | { t: "sound"; lane: string; preset: string }
  | { t: "key"; key: "chromatic" | { root: number; minor: boolean } };

export interface RemoteTake {
  id: string;
  lane: string;
  take_no: number;
  chosen: boolean;
  duration: number;
  /** a small waveform (0..1) */
  peaks?: number[];
}

export interface RemoteState {
  armed: boolean;
  beatReady: boolean;
  sectionId: string | null;
  /** idle | playing | countin | recording | saving | calibrating */
  status: string;
  statusLane: string | null;
  statusLabel: string;
  /** line under the playhead in the current section */
  lineIndex: number | null;
  sections: { id: string; name: string; takes: number }[];
  lanes: string[];
  /** takes of the current section */
  takes: RemoteTake[];
  countIn: number;
  error: string | null;
  /** which page publishes (a phone ignores a state that isn't from the recording device) */
  host?: string;
  /** "Mac", "PC"… — shown on the phone */
  device?: string;
  /** the take being played */
  playingTake?: string | null;
  /** beats left in the count-in */
  beatsLeft?: number | null;
  /** each layer's sound (effect preset id) and the song's key for autotune */
  sounds?: Record<string, string>;
  songKey?: "chromatic" | { root: number; minor: boolean } | null;
  /** a voice is being tuned (autotune / pitch) */
  tuning?: boolean;
}

/** the last take of a layer (highest number) — what "retake" / "discard" act on */
export function lastTake<T extends { lane: string; take_no: number }>(takes: T[], lane: string): T | null {
  return takes.filter((t) => t.lane === lane).sort((a, b) => b.take_no - a.take_no)[0] ?? null;
}
