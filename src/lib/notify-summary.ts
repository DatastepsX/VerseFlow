/** What the others did on a song, as told in the email (lib/server/notify). Pure. */

export type Activity = "lyrics" | "takes" | "song" | "download";

export interface Entry {
  /** who (a user id; null: someone with the share link) */
  u: string | null;
  what: Activity;
  n: number;
  at: number;
  /** a download: what it was */
  detail?: string;
}

/** "Ana: changed the lyrics (12 times), recorded 2 takes, downloaded the MP3 of the mix" */
export function summary(news: Entry[], name: (u: string | null) => string, timeZone = "Europe/Rome") {
  const by = new Map<string | null, Entry[]>();
  for (const e of news) by.set(e.u, [...(by.get(e.u) ?? []), e]);
  return [...by.entries()].map(([u, es]) => {
    const count = (w: Activity) => es.filter((e) => e.what === w).reduce((n, e) => n + e.n, 0);
    const parts: string[] = [];
    const lyrics = count("lyrics");
    const takes = count("takes");
    if (lyrics) parts.push(`changed the lyrics${lyrics > 1 ? ` (${lyrics} times)` : ""}`);
    if (takes) parts.push(`recorded ${takes === 1 ? "a take" : `${takes} takes`}`);
    if (!lyrics && !takes && count("song")) parts.push("made changes to the song");
    for (const d of es.filter((e) => e.what === "download")) parts.push(`downloaded ${d.detail ?? "the song"}`);
    const last = new Date(Math.max(...es.map((e) => e.at)));
    return `${name(u)}: ${parts.join(", ")} — last at ${last.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone })}.`;
  });
}

