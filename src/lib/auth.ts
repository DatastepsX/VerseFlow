/**
 * Signing in: each person has an account (lib/server/users). The session cookie holds the user's id and when it
 * was issued, signed with an HMAC — so the proxy can tell a valid session without asking the database.
 * Accounts are on when APP_PASSWORD is set (it is also the access code for creating an account without an
 * invitation); the signing key is SESSION_SECRET, or else APP_PASSWORD — changing it signs everyone out.
 * WebCrypto only: runs in the proxy and in route handlers alike.
 */
export const SESSION_COOKIE = "vf_session";
/** how long a sign-in lasts without using the app (it renews itself while you do) */
export const SESSION_DAYS = 365;
/** a sign-in older than this is renewed on the next visit */
export const RENEW_AFTER_DAYS = 1;

export function authEnabled() {
  return !!process.env.APP_PASSWORD;
}

async function hmac(message: string) {
  const secret = process.env.SESSION_SECRET || process.env.APP_PASSWORD || "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`verseflow-session-v2:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** the cookie for a signed-in user: v2.<id>.<issued, ms>.<signature> */
export async function signSession(userId: string) {
  const body = `v2.${userId}.${Date.now()}`;
  return `${body}.${await hmac(body)}`;
}

/** the user a cookie belongs to — null when it is missing, forged, old-style or expired */
export async function verifySession(cookie: string | undefined | null): Promise<string | null> {
  return (await readSession(cookie))?.userId ?? null;
}

/** a valid sign-in: whose, and when it was issued (ms) */
export async function readSession(cookie: string | undefined | null): Promise<{ userId: string; issued: number } | null> {
  const m = /^v2\.([0-9a-f-]{36})\.(\d{10,16})\.([0-9a-f]{64})$/.exec(cookie ?? "");
  if (!m) return null;
  const issued = Number(m[2]);
  if (Date.now() - issued > SESSION_DAYS * 86400_000) return null;
  return safeEqual(m[3], await hmac(`v2.${m[1]}.${m[2]}`)) ? { userId: m[1], issued } : null;
}

/** how the sign-in cookie is set (the same everywhere: signing in, renewing) */
export const sessionCookie = (value: string) => ({
  name: SESSION_COOKIE,
  value,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * SESSION_DAYS,
});

export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
