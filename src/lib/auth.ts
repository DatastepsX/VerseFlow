/**
 * Minimal access gate until real user accounts exist: one shared password
 * (APP_PASSWORD). The session cookie holds an HMAC of a fixed message keyed by
 * the password, so changing the password logs everyone out.
 */
export const SESSION_COOKIE = "vf_session";

export function authEnabled() {
  return !!process.env.APP_PASSWORD;
}

export async function sessionToken(): Promise<string> {
  const secret = process.env.APP_PASSWORD ?? "";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("verseflow-session-v1"));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
