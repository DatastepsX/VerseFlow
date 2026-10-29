"use client";

import { useState } from "react";
import { loadAccount, useAccount } from "@/lib/client/account";

/** Settings → You: your name (shown on your notes and to the people you work with), signing out */
export function AccountCard({ card }: { card: string }) {
  const account = useAccount();
  const [saved, setSaved] = useState(false);
  if (!account?.user) return null;
  const user = account.user;
  const rename = async (name: string) => {
    if (!name.trim() || name.trim() === user.name) return;
    const res = await fetch("/api/auth", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    if (res.ok) {
      setSaved(true);
      void loadAccount(true);
    }
  };
  return (
    <section className="space-y-2">
      <p className="label">You</p>
      <div className={card}>
        <input className="input text-base" defaultValue={user.name} onBlur={(e) => void rename(e.target.value)} aria-label="Your name" />
        <p className="text-xs text-muted">
          {saved ? "Saved — " : ""}
          {user.email} · your name is shown on your notes and to the people you work with.
        </p>
        <button
          className="btn w-full justify-center rounded-xl py-2.5 text-sm"
          onClick={async () => {
            await fetch("/api/auth", { method: "DELETE" });
            window.location.assign("/login");
          }}
        >
          Sign out
        </button>
      </div>
    </section>
  );
}
