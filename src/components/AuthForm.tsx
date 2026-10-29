"use client";

import { useState } from "react";
import { loadAccount } from "@/lib/client/account";

/**
 * Sign in, or make an account — with the access code (the studio's own people) or with a song's invitation
 * (then no code is needed, and the song is joined right away).
 */
export function AuthForm({ invite, next, startWith = "signin" }: { invite?: string; next?: string; startWith?: "signin" | "signup" }) {
  const [mode, setMode] = useState<"signin" | "signup">(startWith);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: mode, name, email, password, code: invite ? undefined : code, invite }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(data.error ?? "Couldn't sign in");
      setBusy(false);
      return;
    }
    let to = next;
    // signing in with an invitation: the song is joined too
    if (invite && mode === "signin") {
      const j = await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "join", invite }) });
      const jd = (await j.json().catch(() => ({}))) as { error?: string; projectId?: string };
      if (!j.ok) {
        setError(jd.error ?? "Couldn't join the song");
        setBusy(false);
        return;
      }
      to = `/song/${jd.projectId}`;
    }
    void loadAccount(true);
    window.location.href = to && to.startsWith("/") && !to.startsWith("//") ? to : "/";
  }

  const signup = mode === "signup";
  return (
    <form onSubmit={submit} className="w-full space-y-3">
      <div className="flex rounded-full bg-panel-2 p-1" role="radiogroup" aria-label="Sign in or create an account">
        {(
          [
            ["signin", "Sign in"],
            ["signup", "Create account"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={mode === k}
            className={`flex-1 rounded-full py-2 text-[13px] font-semibold ${mode === k ? "bg-panel text-fg shadow-sm" : "text-muted"}`}
            onClick={() => {
              setMode(k);
              setError(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {signup && <input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (the others see it)" />}
      <input className="input" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
      <input
        className="input"
        type="password"
        autoComplete={signup ? "new-password" : "current-password"}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={signup ? "Password (8 characters or more)" : "Password"}
      />
      {signup && !invite && (
        <>
          <input className="input" type="password" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Access code" />
          <p className="text-xs text-muted">The access code is the studio&apos;s password. Invited to a song? Open the invitation link instead — no code needed.</p>
        </>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
      <button className="btn-primary w-full justify-center" disabled={busy || !email || !password || (signup && (!name.trim() || (!invite && !code)))}>
        {busy ? "One moment…" : signup ? (invite ? "Create account and join" : "Create account") : invite ? "Sign in and join" : "Sign in"}
      </button>
    </form>
  );
}
