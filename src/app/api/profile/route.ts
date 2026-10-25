import { getProfile, updateProfile } from "@/lib/server/repo";
import { body, handle } from "@/lib/server/http";

/** your settings, the same in every song and on every device: GET → {prefs}; PATCH {prefs: {key: value | null}} */
export async function GET() {
  return handle(async () => Response.json({ prefs: await getProfile() }));
}

const KEY = /^[a-zA-Z0-9._-]{1,80}$/;

export async function PATCH(req: Request) {
  return handle(async () => {
    const b = await body<{ prefs?: Record<string, unknown> }>(req);
    const patch = Object.fromEntries(
      Object.entries(b.prefs ?? {})
        .filter(([k, v]) => KEY.test(k) && JSON.stringify(v ?? null).length <= 2000)
        .slice(0, 50),
    );
    return Response.json({ prefs: await updateProfile(patch) });
  });
}
