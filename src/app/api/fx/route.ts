import { body, handle } from "@/lib/server/http";
import { addSound, library, removeSound, renameSound } from "@/lib/server/fxlib";

/**
 * The sound library (effect presets made from a voice, or set by hand):
 *  GET → {mine, shared}                         my sounds, and the ones shared with everyone (mayEdit: mine to change)
 *  POST {preset, scope: "mine" | "shared"} → library  a sound saved (sharing one of mine: a copy goes to shared)
 *  PATCH {id, name} → library                   renamed
 *  DELETE ?id= → library                        removed (shared: only by who shared it, or the studio's people)
 */
export async function GET() {
  return handle(async () => Response.json(await library(), { headers: { "cache-control": "no-store" } }));
}

export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{ preset?: unknown; scope?: unknown }>(req);
    const id = await addSound(b.preset, b.scope === "shared" ? "shared" : "mine");
    return Response.json({ ...(await library()), id });
  });
}

export async function PATCH(req: Request) {
  return handle(async () => {
    const b = await body<{ id?: unknown; name?: unknown }>(req);
    if (typeof b.id !== "string" || typeof b.name !== "string") return Response.json({ error: "id and name required" }, { status: 400 });
    await renameSound(b.id, b.name);
    return Response.json(await library());
  });
}

export async function DELETE(req: Request) {
  return handle(async () => {
    await removeSound(new URL(req.url).searchParams.get("id") ?? "");
    return Response.json(await library());
  });
}
