import "server-only";
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { authEnabled, safeEqual, SESSION_COOKIE, verifySession } from "@/lib/auth";
import { check, db } from "./db";
import { NotFound } from "./repo";

/**
 * People and songs: accounts (email + password), who works on which song and how (owner · editor · viewer),
 * invitations by link — and the one check every route makes before it reads or changes a song (`access`).
 *
 * Without APP_PASSWORD (a local copy) there are no accounts: everything is open, as before.
 */

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export class Unauthorized extends Error {}
export class Forbidden extends Error {}

export type Role = "owner" | "editor" | "viewer";
export type Need = "view" | "edit" | "own";
const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
const NEED: Record<Need, number> = { view: 0, edit: 1, own: 2 };

export interface User {
  id: string;
  email: string;
  name: string;
}

// ---------- passwords ----------

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function passwordMatches(password: string, stored: string) {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const key = await scrypt(password, Buffer.from(salt, "hex"), 64);
  const want = Buffer.from(hash, "hex");
  return key.length === want.length && timingSafeEqual(key, want);
}

// ---------- who is signed in ----------

/** the signed-in user's id (null: accounts are off, or nobody is signed in) */
export async function currentUserId() {
  if (!authEnabled()) return null;
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  // the session's age is checked against the clock: at request time, never while a page is prerendered
  await connection();
  return verifySession(cookie);
}

export async function currentUser(): Promise<User | null> {
  const id = await currentUserId();
  return id ? userById(id) : null;
}

export async function userById(id: string) {
  return check(await db().from("users").select("id, email, name").eq("id", id).maybeSingle()) as User | null;
}

const cleanEmail = (e: string) => e.trim().toLowerCase();

// ---------- signing up, signing in ----------

/**
 * A new account. It needs an invitation (it joins that song) or the access code (APP_PASSWORD). The very first
 * account made with the access code becomes the owner of every song that has nobody yet (the songs from before
 * accounts).
 */
export async function signUp(o: { name: string; email: string; password: string; code?: string; invite?: string }) {
  const email = cleanEmail(o.email);
  const name = o.name.trim().slice(0, 60);
  if (!name) throw new Error("Your name, please.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("That email doesn't look right.");
  if (o.password.length < 8) throw new Error("The password needs at least 8 characters.");
  const invite = o.invite ? await inviteRow(o.invite) : null;
  const withCode = !!o.code && safeEqual(o.code, process.env.APP_PASSWORD ?? "");
  if (!invite && !withCode) throw new Error(o.invite ? "This invitation doesn't work any more — ask for a new one." : "Wrong access code.");
  const existing = check(await db().from("users").select("id").eq("email", email).maybeSingle());
  if (existing) throw new Error("There's already an account with this email — sign in instead.");
  const firstEver = !(check(await db().from("users").select("id").limit(1)) as unknown[]).length;
  const user = check(
    await db()
      .from("users")
      .insert({ email, name, pass_hash: await hashPassword(o.password) })
      .select("id, email, name")
      .single(),
  ) as User;
  if (withCode) await addHouse(user.id);
  if (firstEver && withCode) {
    // the songs from before accounts: theirs
    const projects = check(await db().from("projects").select("id")) as { id: string }[];
    const taken = new Set((check(await db().from("project_members").select("project_id")) as { project_id: string }[]).map((m) => m.project_id));
    const rows = projects.filter((p) => !taken.has(p.id)).map((p) => ({ project_id: p.id, user_id: user.id, role: "owner" }));
    if (rows.length) check(await db().from("project_members").insert(rows));
  }
  if (invite) await acceptInvite(invite.token, user.id);
  return user;
}

export async function signIn(emailIn: string, password: string) {
  const row = check(await db().from("users").select("id, email, name, pass_hash").eq("email", cleanEmail(emailIn)).maybeSingle()) as (User & { pass_hash: string }) | null;
  // the same wait and answer whether the email exists or not
  const ok = row ? await passwordMatches(password, row.pass_hash) : (await scrypt(password, randomBytes(16), 64), false);
  if (!row || !ok) throw new Unauthorized("Wrong email or password.");
  return { id: row.id, email: row.email, name: row.name } as User;
}

/** nobody has made an account yet (the first one, made with the access code, gets the songs from before) */
export async function noAccountsYet() {
  return !(check(await db().from("users").select("id").limit(1)) as unknown[]).length;
}

export async function renameUser(id: string, name: string) {
  const n = name.trim().slice(0, 60);
  if (!n) throw new Error("Your name, please.");
  check(await db().from("users").update({ name: n }).eq("id", id));
}

// ---------- the people who joined with the access code (they may set up the shared voice and so on) ----------

async function houseIds() {
  const row = check(await db().from("user_settings").select("prefs").eq("id", "house").maybeSingle()) as { prefs: { ids?: string[] } } | null;
  return row?.prefs?.ids ?? [];
}

async function addHouse(id: string) {
  const ids = [...new Set([...(await houseIds()), id])];
  check(await db().from("user_settings").upsert({ id: "house", prefs: { ids }, updated_at: new Date().toISOString() }));
}

/** joined with the access code (not only invited to a song) — accounts off: everyone */
export async function isHouse(userId: string | null) {
  if (!authEnabled()) return true;
  return !!userId && (await houseIds()).includes(userId);
}

// ---------- the check every route makes ----------

/**
 * May the signed-in user do this with the song? view: listen, read, leave notes · edit: write, record, mix ·
 * own: share it, delete it. Returns the user's id (null: accounts off). Someone not on the song gets "not found".
 */
export async function access(projectId: string, need: Need) {
  if (!authEnabled()) return null;
  const uid = await currentUserId();
  if (!uid) throw new Unauthorized("Not signed in");
  const role = await roleOf(projectId, uid);
  if (!role) throw new NotFound("Song not found");
  if (RANK[role] < NEED[need]) throw new Forbidden(need === "own" ? "Only the song's owner can do that." : "You can listen and leave notes on this song — ask its owner to make you an editor.");
  return uid;
}

export async function roleOf(projectId: string, userId: string) {
  if (!/^[0-9a-f-]{36}$/.test(projectId)) return null;
  const row = check(await db().from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle()) as { role: Role } | null;
  return row?.role ?? null;
}

/** the role on a song as the page needs it (accounts off: owner) */
export async function myRole(projectId: string): Promise<Role | null> {
  if (!authEnabled()) return "owner";
  const uid = await currentUserId();
  return uid ? roleOf(projectId, uid) : null;
}

type Table = "sections" | "lines" | "takes" | "alternatives" | "bank_lines" | "project_versions" | "flows";
/** the song a part, a line, a take… belongs to (for the check) */
export async function projectOf(table: Table, id: string) {
  const row = check(await db().from(table).select("project_id").eq("id", id).maybeSingle()) as { project_id: string } | null;
  if (!row) throw new NotFound("Not found");
  return row.project_id;
}

/** a history event's song (through its line) */
export async function projectOfEvent(eventId: number) {
  const ev = check(await db().from("line_events").select("line_id").eq("id", eventId).maybeSingle()) as { line_id: string } | null;
  if (!ev) throw new NotFound("Not found");
  return projectOf("lines", ev.line_id);
}

/** a check for a resource by its id: the song it belongs to, checked */
export async function accessVia(table: Table, id: string, need: Need) {
  if (!authEnabled()) return null;
  return access(await projectOf(table, id), need);
}

/** the songs the signed-in user is on (null: accounts off — all) */
export async function mySongs(): Promise<Map<string, Role> | null> {
  if (!authEnabled()) return null;
  const uid = await currentUserId();
  if (!uid) throw new Unauthorized("Not signed in");
  const rows = check(await db().from("project_members").select("project_id, role").eq("user_id", uid)) as { project_id: string; role: Role }[];
  return new Map(rows.map((r) => [r.project_id, r.role]));
}

// ---------- members ----------

export async function addMember(projectId: string, userId: string, role: Role) {
  const now = await roleOf(projectId, userId);
  // joining again never lowers a role
  if (now && RANK[now] >= RANK[role]) return;
  check(await db().from("project_members").upsert({ project_id: projectId, user_id: userId, role }));
}

export async function members(projectId: string) {
  const rows = check(await db().from("project_members").select("user_id, role, created_at").eq("project_id", projectId).order("created_at")) as {
    user_id: string;
    role: Role;
    created_at: string;
  }[];
  const people = rows.length ? (check(await db().from("users").select("id, email, name").in("id", rows.map((r) => r.user_id))) as User[]) : [];
  return rows.map((r) => ({ ...(people.find((p) => p.id === r.user_id) ?? { id: r.user_id, email: "", name: "?" }), role: r.role, since: r.created_at }));
}

/** a member's role changed or removed — the song always keeps an owner */
export async function setMember(projectId: string, userId: string, role: Role | null) {
  const all = await members(projectId);
  const owners = all.filter((m) => m.role === "owner");
  if (owners.length === 1 && owners[0].id === userId && role !== "owner") throw new Forbidden("A song needs an owner — make someone else owner first.");
  if (role) check(await db().from("project_members").update({ role }).eq("project_id", projectId).eq("user_id", userId));
  else check(await db().from("project_members").delete().eq("project_id", projectId).eq("user_id", userId));
}

// ---------- invitations ----------

interface InviteRow {
  token: string;
  project_id: string;
  role: "editor" | "viewer";
  created_by: string | null;
  expires_at: string;
  revoked: boolean;
}

async function inviteRow(token: string) {
  if (!/^[a-f0-9]{40}$/.test(token)) return null;
  const row = check(await db().from("invites").select("*").eq("token", token).maybeSingle()) as InviteRow | null;
  if (!row || row.revoked || new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export async function createInvite(projectId: string, role: "editor" | "viewer", by: string | null) {
  const token = randomBytes(20).toString("hex");
  check(await db().from("invites").insert({ token, project_id: projectId, role, created_by: by, expires_at: new Date(Date.now() + 14 * 86400_000).toISOString() }));
  return token;
}

export async function invites(projectId: string) {
  return check(
    await db().from("invites").select("token, role, created_at, expires_at").eq("project_id", projectId).eq("revoked", false).gt("expires_at", new Date().toISOString()).order("created_at"),
  ) as { token: string; role: "editor" | "viewer"; created_at: string; expires_at: string }[];
}

export async function revokeInvite(projectId: string, token: string) {
  check(await db().from("invites").update({ revoked: true }).eq("token", token).eq("project_id", projectId));
}

/** what an invitation shows before it is accepted: the song, the role, who invited */
export async function inviteInfo(token: string) {
  const row = await inviteRow(token);
  if (!row) return null;
  const p = check(await db().from("projects").select("title").eq("id", row.project_id).maybeSingle()) as { title: string } | null;
  const by = row.created_by ? await userById(row.created_by) : null;
  return { projectId: row.project_id, title: p?.title ?? "A song", role: row.role, by: by?.name ?? null };
}

/** the invitation used: the user is on the song (a link can be used by several people until it expires) */
export async function acceptInvite(token: string, userId: string) {
  const row = await inviteRow(token);
  if (!row) throw new Error("This invitation doesn't work any more — ask for a new one.");
  await addMember(row.project_id, userId, row.role);
  return row.project_id;
}

// ---------- each person's own settings ----------

/** a settings row of the signed-in person ("me" → "me:<id>"); accounts off: the shared one */
export async function settingsKey(base: "me" | "nav" | "host") {
  const uid = await currentUserId();
  return uid ? `${base}:${uid}` : base;
}
