import { cookies } from "next/headers";
import { authEnabled, SESSION_COOKIE, SESSION_DAYS, signSession } from "@/lib/auth";
import { body, handle } from "@/lib/server/http";
import { acceptInvite, currentUser, currentUserId, isHouse, renameUser, signIn, signUp, Unauthorized } from "@/lib/server/users";

/**
 * Accounts:
 *  GET → {user, accounts}                                     who is signed in (accounts: whether they are on)
 *  POST {action: "signin", email, password}
 *  POST {action: "signup", name, email, password, code? | invite?}   code: the access code; invite: a song's link
 *  POST {action: "join", invite}                             signed in: the invited song joined → {projectId}
 *  PATCH {name}                                                your name
 *  DELETE                                                      sign out
 */
async function startSession(userId: string) {
  (await cookies()).set(SESSION_COOKIE, await signSession(userId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * SESSION_DAYS,
  });
}

export async function GET() {
  return handle(async () => {
    const user = await currentUser();
    return Response.json({ accounts: authEnabled(), user, house: user ? await isHouse(user.id) : !authEnabled() }, { headers: { "cache-control": "no-store" } });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    if (!authEnabled()) return Response.json({ ok: true });
    const b = await body<{ action?: string; email?: unknown; password?: unknown; name?: unknown; code?: unknown; invite?: unknown }>(req);
    const str = (v: unknown) => (typeof v === "string" ? v : "");
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
      await startSession(user.id);
      return Response.json({ ok: true, user });
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
  return Response.json({ ok: true });
}
