/**
 * Phone remote ⇄ studio (Mac). The phone sends commands; the studio runs
 * them (it owns the audio interface) and publishes its state. Both go
 * through the app's API (long-polling), no direct connection needed.
 */

export type RemoteCmd =
  | { t: "select"; sectionId: string }
  | { t: "record"; lane: string }
  | { t: "retake"; lane: string }
  | { t: "discardLast"; lane: string }
  | { t: "choose"; takeId: string }
  | { t: "play" }
  | { t: "playTake"; takeId: string }
  | { t: "stop" }
  | { t: "addLane"; name: string }
  | { t: "countIn"; bars: number };

export interface RemoteTake {
  id: string;
  lane: string;
  take_no: number;
  chosen: boolean;
  duration: number;
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
}

/** the last take of a layer (highest number) — what "retake" / "discard" act on */
export function lastTake<T extends { lane: string; take_no: number }>(takes: T[], lane: string): T | null {
  return takes.filter((t) => t.lane === lane).sort((a, b) => b.take_no - a.take_no)[0] ?? null;
}
