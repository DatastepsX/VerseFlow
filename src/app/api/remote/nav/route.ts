import { getRemoteNav, putRemoteNav } from "@/lib/server/repo";
import { body, handle } from "@/lib/server/http";

/**
 * Where the phone is, for the Mac to follow when the Mac is the main device — the whole app, not one song:
 * GET → {nav}; POST {path, view?, part?} (from the phone).
 */
export async function GET() {
  return handle(async () => Response.json({ nav: await getRemoteNav() }, { headers: { "cache-control": "no-store" } }));
}

export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{ path?: unknown; view?: unknown; part?: unknown }>(req);
    if (typeof b.path !== "string" || !/^\/[\w\-/]*$/.test(b.path) || b.path.length > 200) return Response.json({ error: "path required" }, { status: 400 });
    const str = (x: unknown) => (typeof x === "string" && x.length <= 80 ? x : null);
    return Response.json({ nav: await putRemoteNav({ path: b.path, view: str(b.view), part: str(b.part) }) });
  });
}
