"use client";

import { useEffect, useState } from "react";

/** who is signed in, as the browser needs it (accounts: whether they are on; house: joined with the access code) */
export interface Account {
  accounts: boolean;
  user: { id: string; email: string; name: string } | null;
  house: boolean;
}

let cached: Promise<Account> | null = null;

export function loadAccount(fresh = false) {
  if (fresh || !cached)
    cached = fetch("/api/auth", { cache: "no-store" })
      .then((r) => r.json() as Promise<Account & { device?: string }>)
      .then((a) => {
        keepDeviceSignIn(a.device);
        return a;
      })
      .catch(() => ({ accounts: false, user: null, house: true }));
  return cached;
}

/** null while loading */
export function useAccount() {
  const [account, setAccount] = useState<Account | null>(null);
  useEffect(() => {
    let live = true;
    void loadAccount().then((a) => {
      if (live) setAccount(a);
    });
    return () => {
      live = false;
    };
  }, []);
  return account;
}

/**
 * This device keeps its sign-in (a copy of the signed session, in the browser's storage): if the cookie is lost
 * — iOS sometimes clears a Home-screen app's cookies — the sign-in page signs back in with it, no password.
 */
const DEVICE_KEY = "vf.session.device";

export function keepDeviceSignIn(device: unknown) {
  try {
    if (typeof device === "string" && device) localStorage.setItem(DEVICE_KEY, device);
  } catch {}
}

export function forgetDeviceSignIn() {
  try {
    localStorage.removeItem(DEVICE_KEY);
  } catch {}
}

/** signed back in with the kept sign-in (false: there is none, or it no longer works) */
export async function resumeDeviceSignIn() {
  let device: string | null = null;
  try {
    device = localStorage.getItem(DEVICE_KEY);
  } catch {}
  if (!device) return false;
  const res = await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "resume", device }) }).catch(() => null);
  if (!res?.ok) {
    if (res?.status === 401) forgetDeviceSignIn();
    return false;
  }
  keepDeviceSignIn(((await res.json().catch(() => ({}))) as { device?: string }).device);
  return true;
}
