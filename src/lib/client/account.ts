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
      .then((r) => r.json() as Promise<Account>)
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
