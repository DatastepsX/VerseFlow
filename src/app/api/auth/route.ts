import { cookies } from "next/headers";
import { authEnabled, readSession, SESSION_COOKIE, sessionCookie, signSession } from "@/lib/auth";
import { body, handle } from "@/lib/server/http";
import { acceptInvite, currentUser, currentUserId, isHouse, noAccountsYet, userById, renameUser, signIn, signUp, Unauthorized } from "@/lib/server/users";

/**
 * Accounts:
 *  GET → {user, accounts, house, firstRun}                    who is signed in (firstRun: no account exists yet)
 *  POST {action: "signin", email, password}
 *  POST {action: "signup", name, email, password, code? | invite?}   code: the access code; invite: a song's link
 *  POST {action: "resume", device}                           the sign-in this device kept: signed in again, no password
 *  POST {action: "join", invite}                             signed in: the invited song joined → {projectId}
 *  PATCH {name}                                                your name
 *  DELETE                                                      sign out
 */
/** signed in: the cookie, and the same sign-in for the device to keep (it signs back in if the cookie is lost) */
async function startSession(userId: string) {
  const value = await signSession(userId);
  (await cookies()).set(sessionCookie(value));
  return value;
}

export async function GET() {
  return handle(async () => {
    const user = await currentUser();
    const firstRun = authEnabled() && !user && (await noAccountsYet());
    // signed in: a fresh copy for the device to keep (it signs back in with it if the cookie is lost)
    const device = user ? await signSession(user.id) : undefined;
    return Response.json(
      { accounts: authEnabled(), user, house: user ? await isHouse(user.id) : !authEnabled(), firstRun, device },
      { headers: { "cache-control": "no-store" } },
    );
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    if (!authEnabled()) return Response.json({ ok: true });
    const b = await body<{ action?: string; device?: unknown; email?: unknown; password?: unknown; name?: unknown; code?: unknown; invite?: unknown }>(req);
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    if (b.action === "resume") {
      // the device's kept sign-in (from signing in on it): valid and the account still there → signed in again
      const kept = await readSession(str(b.device));
      const user = kept ? await userById(kept.userId) : null;
      if (!user) return Response.json({ error: "Sign in again" }, { status: 401 });
      return Response.json({ ok: true, user, device: await startSession(user.id) });
    }
    if (b.action === "join") {
      const uid = await currentUserId();
      if (!uid) throw new Unauthorized("Not signed in");
      try {
        return Response.json({ projectId: await acceptInvite(str(b.invite), uid) });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : "Couldn't join" }, { status: 400 });
      }
    }
    try {
      const user =
        b.action === "signup"
          ? await signUp({ name: str(b.name), email: str(b.email), password: str(b.password), code: str(b.code) || undefined, invite: str(b.invite) || undefined })
          : await signIn(str(b.email), str(b.password));
      return Response.json({ ok: true, user, device: await startSession(user.id) });
    } catch (e) {
      // a wrong guess waits a moment
      await new Promise((r) => setTimeout(r, 500));
      const message = e instanceof Error ? e.message : "Couldn't sign in";
      return Response.json({ error: message }, { status: e instanceof Unauthorized ? 401 : 400 });
    }
  });
}

export async function PATCH(req: Request) {
  return handle(async () => {
    const user = await currentUser();
    if (!user) throw new Unauthorized("Not signed in");
    const b = await body<{ name?: unknown }>(req);
    await renameUser(user.id, typeof b.name === "string" ? b.name : "");
    return Response.json({ ok: true });
  });
}

export async function DELETE() {
  (await cookies()).delete(SESSION_COOKIE);
  // (the device forgets its kept sign-in too: AccountCard)
  return Response.json({ ok: true });
}
