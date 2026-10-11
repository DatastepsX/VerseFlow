import { cookies } from "next/headers";
import { authEnabled, safeEqual, SESSION_COOKIE, sessionToken } from "@/lib/auth";
import { body } from "@/lib/server/http";

export async function POST(req: Request) {
  if (!authEnabled()) return Response.json({ ok: true });
  const { password } = await body<{ password?: string }>(req);
  if (!password || !safeEqual(password, process.env.APP_PASSWORD ?? "")) {
    await new Promise((r) => setTimeout(r, 600));
    return Response.json({ error: "Wrong password" }, { status: 401 });
  }
  (await cookies()).set(SESSION_COOKIE, await sessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
  });
  return Response.json({ ok: true });
}

export async function DELETE() {
  (await cookies()).delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
