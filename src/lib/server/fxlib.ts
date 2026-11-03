import "server-only";
import { randomBytes } from "node:crypto";
import { cleanPreset } from "@/lib/fx/match";
import type { FxPreset } from "@/lib/fx/presets";
import { check, db } from "./db";
import { currentUser, Forbidden, isHouse, settingsKey } from "./users";

/**
 * The sound library: sounds made from a voice (or set by hand), as effect presets. "My sounds" belong to one
 * person (kept with them, `fx:<user>`); "shared sounds" are for everyone using the app (`fx:shared`) — anyone
 * may add one, the one who shared it (or the studio's own people) may rename or remove it.
 */

export type LibrarySound = FxPreset & { by?: string | null; byName?: string | null; at?: string };
const SHARED = "fx:shared";

async function read(key: string): Promise<LibrarySound[]> {
  const row = check(await db().from("user_settings").select("prefs").eq("id", key).maybeSingle()) as { prefs: { sounds?: unknown[] } } | null;
  return (row?.prefs?.sounds ?? []).flatMap((x) => {
    const p = cleanPreset(x);
    const o = x as Record<string, unknown>;
    return p ? [{ ...p, by: typeof o.by === "string" ? o.by : null, byName: typeof o.byName === "string" ? o.byName : null, at: typeof o.at === "string" ? o.at : undefined }] : [];
  });
}

async function write(key: string, sounds: LibrarySound[]) {
  check(await db().from("user_settings").upsert({ id: key, prefs: { sounds: sounds.slice(0, 200) }, updated_at: new Date().toISOString() }));
}

export async function library() {
  const me = await currentUser();
  const [mine, shared] = await Promise.all([read(await settingsKey("fx")), read(SHARED)]);
  const house = await isHouse(me?.id ?? null);
  return {
    mine,
    shared: shared.map((s) => ({ ...s, mayEdit: house || !s.by || s.by === me?.id })),
  };
}

const newId = () => `fx-${randomBytes(5).toString("hex")}`;

/** a sound saved: to my sounds, or shared with everyone (a copy, with a new id when it is already there) */
export async function addSound(preset: unknown, scope: "mine" | "shared") {
  const p = cleanPreset(preset);
  if (!p) throw new Error("That sound can't be saved.");
  const me = await currentUser();
  const key = scope === "shared" ? SHARED : await settingsKey("fx");
  const list = await read(key);
  const id = p.id.startsWith("fx-") && !list.some((s) => s.id === p.id) ? p.id : newId();
  list.unshift({ ...p, id, by: me?.id ?? null, byName: me?.name ?? null, at: new Date().toISOString() });
  await write(key, list);
  return id;
}

async function editable(id: string) {
  const me = await currentUser();
  const mineKey = await settingsKey("fx");
  const mine = await read(mineKey);
  if (mine.some((s) => s.id === id)) return { key: mineKey, list: mine };
  const shared = await read(SHARED);
  const s = shared.find((x) => x.id === id);
  if (!s) throw new Error("That sound isn't in the library any more.");
  if (s.by && s.by !== me?.id && !(await isHouse(me?.id ?? null))) throw new Forbidden("Only who shared this sound can change it.");
  return { key: SHARED, list: shared };
}

export async function renameSound(id: string, name: string) {
  const n = name.trim().slice(0, 60);
  if (!n) throw new Error("A name, please.");
  const { key, list } = await editable(id);
  await write(key, list.map((s) => (s.id === id ? { ...s, name: n } : s)));
}

export async function removeSound(id: string) {
  const { key, list } = await editable(id);
  await write(key, list.filter((s) => s.id !== id));
}
