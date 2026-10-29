"use client";

/**
 * Your settings, kept with your profile (the server), so they are the same in every song and on the iPhone
 * and the Mac: recording, appearance, and the timing — one per kind of device, as each has its own delay.
 * The browser keeps a copy so the app starts with them before the server answers.
 */

/** the settings kept with the profile (others — the microphone, the part you were on — stay on the device) */
const SYNCED = /^(vf\.studio\.(main|countin|metronome|headphones|latency(\.vp)?\.[A-Za-z]+)|vf\.rec\.(size|speed|numbers|approvedOnly)|verseflow\.(theme|flowMode)|vf\.me\.name|vf\.notes\.seen\.[0-9a-f-]{36})$/;

export const isProfileKey = (key: string) => SYNCED.test(key);

/** what kind of device this is: the timing is kept for each */
export function deviceKind(): string {
  if (typeof navigator === "undefined") return "device";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Computer";
}

type Listener = (key: string, value: unknown) => void;
const listeners = new Set<Listener>();
let prefs: Record<string, unknown> | null = null;
let loading: Promise<Record<string, unknown>> | null = null;

/** the profile's settings (once per page); each lands in the browser's copy and goes to whoever listens */
export function loadProfile(): Promise<Record<string, unknown>> {
  if (!loading) {
    loading = fetch("/api/profile")
      .then((r) => (r.ok ? (r.json() as Promise<{ prefs: Record<string, unknown> }>) : { prefs: {} }))
      .then((r) => {
        prefs = r.prefs ?? {};
        for (const [k, v] of Object.entries(prefs)) {
          try {
            localStorage.setItem(k, k === "verseflow.theme" || k === "verseflow.flowMode" ? String(v) : JSON.stringify(v));
          } catch {}
          listeners.forEach((l) => l(k, v));
        }
        migrate(prefs);
        return prefs;
      })
      .catch(() => (prefs = {}));
  }
  return loading;
}

export function onProfile(l: Listener) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** a setting changed here: kept with the profile (null: back to the default) */
export function saveProfilePref(key: string, value: unknown) {
  if (!isProfileKey(key)) return;
  if (prefs) prefs[key] = value;
  listeners.forEach((l) => l(key, value));
  void fetch("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefs: { [key]: value ?? null } }) }).catch(() => {});
}

/** the timing set before it was kept with the profile (this browser only): it moves there for this kind of device */
function migrate(p: Record<string, unknown>) {
  const kind = deviceKind();
  for (const [old, now] of [
    ["vf.studio.latency", `vf.studio.latency.${kind}`],
    ["vf.studio.latency.vp", `vf.studio.latency.vp.${kind}`],
  ]) {
    try {
      const raw = localStorage.getItem(old);
      if (raw === null) continue;
      const v = JSON.parse(raw) as unknown;
      localStorage.removeItem(old);
      if (p[now] !== undefined || typeof v !== "number") continue;
      localStorage.setItem(now, raw);
      saveProfilePref(now, v);
    } catch {}
  }
}

/** a phone or a tablet: with the Mac as the main device it is the remote */
export const isHandheld = (kind = deviceKind()) => kind === "iPhone" || kind === "iPad" || kind === "Android";
