import { addRecordingDiag } from "@/lib/server/repo";
import { body, handle } from "@/lib/server/http";

/** POST {diag}: what a device saw while recording a take — kept (the last 20) to find out why a take failed */
export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{ diag?: unknown }>(req);
    const json = JSON.stringify(b.diag ?? null);
    if (!b.diag || typeof b.diag !== "object" || json.length > 4000) return Response.json({ error: "diag required" }, { status: 400 });
    await addRecordingDiag(b.diag as Record<string, unknown>);
    return Response.json({ ok: true });
  });
}
