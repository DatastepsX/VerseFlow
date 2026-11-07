import "server-only";
import { after } from "next/server";
import { headers } from "next/headers";
import { authEnabled } from "@/lib/auth";
import { check, db } from "./db";
import { emailConfigured, sendEmail, simpleEmail } from "./email";
import { currentUserId, members } from "./users";

/**
 * Telling the people on a song what the others did, by email: changes are collected per person and sent as one
 * summary — at most every 30 minutes to each, or as soon as the one working closes the song — and a download
 * (an MP3, the stems, a share link opened) right away. Kept in a user_settings row per song
 * ("notify:<song>"); each person can turn the emails off (Settings: vf.notify.email).
 */

import { summary, type Activity, type Entry } from "@/lib/notify-summary";
interface Row {
  log: Entry[];
  /** when each person was last emailed (ms) */
  sent: Record<string, number>;
}

const DIGEST_MS = 30 * 60_000;
const KEEP_MS = 3 * 24 * 3600_000;
/** the same kind of change by the same person within a minute: one entry (a count) */
const MERGE_MS = 60_000;

/** a write noted in this server instance lately: not every keystroke is a database write */
const recent = new Map<string, number>();

/**
 * Notes what the signed-in person did on a song (after the response: it never slows the change down). Accounts
 * off (a local copy): nothing to do.
 */
export function noteActivity(projectId: string, what: Activity, detail?: string, who?: string | null) {
  if (!authEnabled()) return;
  // one change writes many times (a line, its part, the song): noted once
  const pre = `${projectId}:${what}:${detail ?? ""}`;
  const t0 = Date.now();
  if (t0 - (recent.get(pre) ?? 0) < 2_000) return;
  recent.set(pre, t0);
  try {
    after(async () => {
      const u = who !== undefined ? who : await currentUserId().catch(() => null);
      if (u === null && what !== "download") return;
      const key = `${projectId}:${u}:${what}`;
      const now = Date.now();
      if (what !== "download" && now - (recent.get(key) ?? 0) < 15_000) return;
      recent.set(key, now);
      const base = await baseUrl();
      await record(projectId, { u, what, n: 1, at: now, ...(detail ? { detail } : {}) });
      await deliver(projectId, base, what === "download");
    });
  } catch {
    // outside a request (a script): no emails
  }
}

/** the one working left the song: what they did goes out now */
export function flushActivity(projectId: string) {
  if (!authEnabled()) return;
  try {
    after(async () => deliver(projectId, await baseUrl(), true));
  } catch {}
}

async function baseUrl() {
  const h = await headers().catch(() => null);
  const host = h?.get("x-forwarded-host") ?? h?.get("host") ?? null;
  const proto = h?.get("x-forwarded-proto") ?? "https";
  return process.env.APP_URL || (host ? `${proto}://${host}` : "");
}

const rowId = (projectId: string) => `notify:${projectId}`;

async function load(projectId: string): Promise<Row> {
  const r = check(await db().from("user_settings").select("prefs").eq("id", rowId(projectId)).maybeSingle()) as { prefs: Partial<Row> } | null;
  return { log: r?.prefs.log ?? [], sent: r?.prefs.sent ?? {} };
}
async function save(projectId: string, row: Row) {
  check(await db().from("user_settings").upsert({ id: rowId(projectId), prefs: row, updated_at: new Date().toISOString() }));
}

async function record(projectId: string, e: Entry) {
  const row = await load(projectId);
  const last = [...row.log].reverse().find((x) => x.u === e.u && x.what === e.what);
  if (e.what !== "download" && last && e.at - last.at < MERGE_MS) {
    last.n += 1;
    last.at = e.at;
  } else row.log.push(e);
  row.log = row.log.filter((x) => e.at - x.at < KEEP_MS).slice(-400);
  await save(projectId, row);
}

/** each member: what the others did since their last email — sent when it's time (or `now`) */
async function deliver(projectId: string, base: string, now: boolean) {
  if (!emailConfigured()) return;
  const row = await load(projectId);
  const t = Date.now();
  const people = await members(projectId);
  const title = (check(await db().from("projects").select("title").eq("id", projectId).maybeSingle()) as { title: string } | null)?.title ?? "your song";
  const names = new Map(people.map((p) => [p.id, p.name || p.email.split("@")[0]]));
  let changed = false;
  for (const p of people) {
    if (!p.email) continue;
    const since = row.sent[p.id] ?? 0;
    const news = row.log.filter((e) => e.u !== p.id && e.at > since);
    if (!news.length) continue;
    const urgent = news.some((e) => e.what === "download");
    if (!urgent && !now && t - since < DIGEST_MS) continue;
    if (!(await wantsEmails(p.id))) continue;
    const lines = summary(news, (u) => (u ? (names.get(u) ?? "Someone") : "Someone with the share link"));
    const who = [...new Set(news.map((e) => (e.u ? (names.get(e.u) ?? "Someone") : "Someone")))];
    const subject = urgent
      ? `${who.join(", ")} downloaded “${title}”`
      : `${who.join(", ")} worked on “${title}”`;
    const mail = simpleEmail({
      title: subject,
      lines,
      button: { label: "Open the song", url: `${base}/song/${projectId}` },
      footer: "You get this because you're on this song in VerseFlow. Turn these emails off in Settings.",
    });
    if (await sendEmail({ to: p.email, subject, ...mail })) {
      row.sent[p.id] = t;
      changed = true;
    }
  }
  if (changed) await save(projectId, row);
}

async function wantsEmails(userId: string) {
  const r = check(await db().from("user_settings").select("prefs").eq("id", `me:${userId}`).maybeSingle()) as { prefs: Record<string, unknown> } | null;
  return r?.prefs?.["vf.notify.email"] !== false;
}
