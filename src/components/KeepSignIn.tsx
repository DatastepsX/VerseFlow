"use client";

import { useEffect } from "react";
import { loadAccount } from "@/lib/client/account";

/** signed in: this device keeps a copy of the sign-in (lib/client/account), so a lost cookie doesn't sign you out */
export function KeepSignIn() {
  useEffect(() => {
    if (window.location.pathname.startsWith("/login") || window.location.pathname.startsWith("/s/")) return;
    void loadAccount();
  }, []);
  return null;
}
