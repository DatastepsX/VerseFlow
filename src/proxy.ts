import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, readSession, RENEW_AFTER_DAYS, SESSION_COOKIE, sessionCookie, signSession } from "@/lib/auth";

/** signed in? (which songs a person may open is checked by each route: lib/server/users) */
export async function proxy(request: NextRequest) {
  if (!authEnabled()) return NextResponse.next();
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) {
    const res = NextResponse.next();
    // in use: the sign-in starts its year again (renewed at most once a day)
    if (Date.now() - session.issued > RENEW_AFTER_DAYS * 86400_000) res.cookies.set(sessionCookie(await signSession(session.userId)));
    return res;
  }
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const url = new URL("/login", request.url);
  url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // open without signing in: the sign-in, a share link's download page, an invitation
  matcher: ["/((?!login|api/auth|s/|join/|_next/static|_next/image|favicon.ico|icon|apple-icon|logo.svg|manifest).*)"],
};
