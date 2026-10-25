import { getRemoteHost, getRemoteNav, putRemoteHost, putRemoteNav } from "@/lib/server/repo";
import { body, handle } from "@/lib/server/http";

/**
 * Where the phone is, for the Mac to follow when the Mac is the main device — the whole app, not one song:
 * GET → {nav, host}; POST {path, view?, part?} (from the phone); POST {host: {sound, path}} (from the Mac: it is
 * there, and whether it can play sound yet).
 */
export async function GET() {
  return handle(async () => {
    const [nav, host] = await Promise.all([getRemoteNav(), getRemoteHost()]);
    return Response.json({ nav, host, now: Date.now() }, { headers: { "cache-control": "no-store" } });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{ path?: unknown; view?: unknown; part?: unknown; host?: { sound?: unknown; path?: unknown } }>(req);
    const okPath = (p: unknown): p is string => typeof p === "string" && /^\/[\w\-/]*$/.test(p) && p.length <= 200;
    if (b.host) {
      if ((b.host.sound !== "on" && b.host.sound !== "locked") || !okPath(b.host.path)) return Response.json({ error: "sound and path required" }, { status: 400 });
      return Response.json({ host: await putRemoteHost({ sound: b.host.sound, path: b.host.path }) });
    }
    if (!okPath(b.path)) return Response.json({ error: "path required" }, { status: 400 });
    const str = (x: unknown) => (typeof x === "string" && x.length <= 80 ? x : null);
    return Response.json({ nav: await putRemoteNav({ path: b.path, view: str(b.view), part: str(b.part) }) });
  });
}
