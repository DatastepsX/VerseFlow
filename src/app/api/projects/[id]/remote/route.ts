import { getRemoteState, postRemoteCommand, putRemoteState, remoteCommandsAfter } from "@/lib/server/repo";
import { body, handle } from "@/lib/server/http";
import { access } from "@/lib/server/users";

export const maxDuration = 30;

const WAIT_MS = 20_000;
const STEP_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Long-polling (answers as soon as there is something new, at the latest after ~20 s):
 *  ?cmds&after=ID   → { last, cmds }   the studio waits for the phone's commands (after=-1: start from now)
 *  ?state&after=MS  → { state, at, age } the phone waits for a newer studio state
 */
export async function GET(req: Request, ctx: RouteContext<"/api/projects/[id]/remote">) {
  return handle(async () => {
    await access((await ctx.params).id, "edit");
    const { id } = await ctx.params;
    const q = new URL(req.url).searchParams;
    const after = Number(q.get("after") ?? -1);
    const deadline = Date.now() + WAIT_MS;
    if (q.has("cmds")) {
      for (;;) {
        const r = await remoteCommandsAfter(id, after);
        if (r.cmds.length || after < 0 || Date.now() > deadline || req.signal.aborted) return Response.json(r);
        await sleep(STEP_MS);
      }
    }
    for (;;) {
      const s = await getRemoteState(id);
      if ((s && s.at > after) || Date.now() > deadline || req.signal.aborted)
        return Response.json({ state: s?.state ?? null, at: s?.at ?? 0, age: s ? Date.now() - s.at : null });
      await sleep(STEP_MS);
    }
  });
}

/** { cmd } from the phone, or { state } from the studio */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/remote">) {
  return handle(async () => {
    await access((await ctx.params).id, "edit");
    const { id } = await ctx.params;
    const b = await body<{ cmd?: { t?: unknown }; state?: unknown }>(req);
    if (b.cmd && typeof b.cmd.t === "string") await postRemoteCommand(id, b.cmd);
    else if (b.state && typeof b.state === "object") await putRemoteState(id, b.state);
    else return Response.json({ error: "cmd or state required" }, { status: 400 });
    return Response.json({ ok: true });
  });
}
