import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, SESSION_COOKIE, verifySession } from "@/lib/auth";

/** signed in? (which songs a person may open is checked by each route: lib/server/users) */
export async function proxy(request: NextRequest) {
  if (!authEnabled()) return NextResponse.next();
  if (await verifySession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const url = new URL("/login", request.url);
  url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // open without signing in: the sign-in, a share link's download page, an invitation
  matcher: ["/((?!login|api/auth|s/|join/|_next/static|_next/image|favicon.ico|icon|manifest).*)"],
};
