import { presence, projectVersion } from "@/lib/server/repo";
import { body, handle } from "@/lib/server/http";
import { access, currentUserId, userById } from "@/lib/server/users";

/**
 * A stamp of everything in the song (lyrics, parts, takes, flows, options, undo): another device changed it when
 * it changes — and who else has the song open now, where (?d=device&dev=phone&view=&part=&line=&edit=1).
 */
export async function GET(req: Request, ctx: RouteContext<"/api/projects/[id]/version">) {
  return handle(async () => {
    const { id } = await ctx.params;
    await access(id, "view");
    const q = new URL(req.url).searchParams;
    const device = (q.get("d") ?? "").slice(0, 40);
    const v = await projectVersion(id);
    const me = device ? await meFrom(q, device) : null;
    // you on another device too: marked, not named twice
    const here = me ? (await presence(id, me)).map((h) => ({ ...h, self: !!me.userId && h.userId === me.userId })) : [];
    return Response.json({ v, here }, { headers: { "cache-control": "no-store" } });
  });
}

/** { d, leave: true }: this device closed the song (sent as the page goes away) */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/version">) {
  return handle(async () => {
    const { id } = await ctx.params;
    await access(id, "view");
    const b = await body<{ d?: unknown }>(req);
    if (typeof b.d === "string" && b.d) await presence(id, await meFrom(new URLSearchParams(), b.d.slice(0, 40)), true);
    return Response.json({ ok: true });
  });
}

async function meFrom(q: URLSearchParams, device: string) {
  const userId = await currentUserId();
  const s = (k: string) => (q.get(k) || "").slice(0, 60) || null;
  return {
    key: `${userId ?? "anon"}:${device}`,
    userId,
    device: q.get("dev") === "computer" ? "computer" : "phone",
    view: s("view"),
    part: s("part"),
    line: s("line"),
    editing: q.get("edit") === "1",
    name: async () => (userId ? ((await userById(userId))?.name ?? "Someone") : "Another device"),
  };
}
