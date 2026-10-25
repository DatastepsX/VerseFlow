"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { isHandheld } from "@/lib/client/profile";
import { usePref } from "@/lib/client/usePref";

/** a song's tab and part, from the phone: the open song applies it (see SongApp) */
export const NAV_EVENT = "vf-remote-nav";
export interface NavDetail {
  path: string;
  view: string | null;
  part: string | null;
}

/** the phone tells where it is (a song adds its tab and part itself) */
export function postNav(path: string, view: string | null = null, part: string | null = null) {
  void fetch("/api/remote/nav", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, view, part }) }).catch(() => {});
}

/**
 * The Mac as the main device, the phone its remote — for the whole app, not one song: the page the phone opens
 * (home, a song, settings) opens on the Mac, and inside a song its tab and part. Mounted once, on every page.
 */
export function RemoteFollow() {
  const [main] = usePref<"phone" | "mac">("vf.studio.main", "phone");
  const path = usePathname();
  const router = useRouter();
  const handheld = isHandheld();
  const controller = main === "mac" && handheld;
  const host = main === "mac" && !handheld;

  // the phone: every page it opens (a song sends its tab and part as they change)
  useEffect(() => {
    if (!controller || path === "/login") return;
    if (!path.startsWith("/song/")) postNav(path);
  }, [controller, path]);

  // the Mac: follows what the phone opened since this page loaded (or in the last minutes)
  const pathRef = useRef(path);
  useEffect(() => {
    pathRef.current = path;
  });
  useEffect(() => {
    if (!host) return;
    let seen = Date.now() - 10 * 60 * 1000;
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      const r = (await fetch("/api/remote/nav", { cache: "no-store" })
        .then((x) => (x.ok ? x.json() : null))
        .catch(() => null)) as { nav: (NavDetail & { at: number }) | null } | null;
      const nav = r?.nav;
      if (stop || !nav || nav.at <= seen) return;
      seen = nav.at;
      if (nav.path !== pathRef.current) router.push(nav.view ? `${nav.path}?view=${encodeURIComponent(nav.view)}` : nav.path);
      // the song open here: its tab and part (again a moment later: a song just opened is still loading)
      const send = () => window.dispatchEvent(new CustomEvent<NavDetail>(NAV_EVENT, { detail: { path: nav.path, view: nav.view, part: nav.part } }));
      send();
      if (nav.path !== pathRef.current) [1200, 3000].forEach((ms) => setTimeout(send, ms));
    };
    void tick();
    const id = setInterval(() => void tick(), 1500);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [host, router]);

  return null;
}
