import { body, handle } from "@/lib/server/http";
import { access, createInvite, invites, members, revokeInvite, setMember, type Role } from "@/lib/server/users";

/**
 * Who works on the song (the owner shares it):
 *  GET → {members, invites, me}                 everyone on the song sees who else is on it; invites: owner only
 *  POST {role: "editor" | "viewer"} → {token}   a new invitation link (14 days, can be used by several people)
 *  PATCH {userId, role} → {members}             a member's role
 *  DELETE ?user= | ?invite= → {members, invites} someone taken off the song, or a link turned off
 */
const ROLES: Role[] = ["owner", "editor", "viewer"];

async function state(id: string, owner: boolean) {
  return { members: await members(id), invites: owner ? await invites(id) : [] };
}

export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[id]/members">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await access(id, "view");
    const all = await state(id, true);
    const role = me ? all.members.find((m) => m.id === me)?.role : "owner";
    return Response.json({ ...all, invites: role === "owner" ? all.invites : [], me });
  });
}

export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]/members">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await access(id, "own");
    const b = await body<{ role?: unknown }>(req);
    return Response.json({ token: await createInvite(id, b.role === "viewer" ? "viewer" : "editor", me) });
  });
}

export async function PATCH(req: Request, ctx: RouteContext<"/api/projects/[id]/members">) {
  return handle(async () => {
    const { id } = await ctx.params;
    await access(id, "own");
    const b = await body<{ userId?: unknown; role?: unknown }>(req);
    const role = ROLES.find((r) => r === b.role);
    if (typeof b.userId !== "string" || !role) return Response.json({ error: "userId and role required" }, { status: 400 });
    await setMember(id, b.userId, role);
    return Response.json(await state(id, true));
  });
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/projects/[id]/members">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await access(id, "view");
    const q = new URL(req.url).searchParams;
    const user = q.get("user");
    // anyone may leave a song; taking someone else off it, or turning a link off, is the owner's
    if (user && user === me) {
      await setMember(id, user, null);
      return Response.json({ left: true });
    }
    await access(id, "own");
    if (user) await setMember(id, user, null);
    const invite = q.get("invite");
    if (invite) await revokeInvite(id, invite);
    return Response.json(await state(id, true));
  });
}
