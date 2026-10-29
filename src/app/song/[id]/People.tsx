"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash } from "@/components/icons";
import { useAccount } from "@/lib/client/account";

/**
 * Who works on the song (More → People): the members and their roles, and invitation links. The owner invites
 * — as an editor (writes, records, mixes) or a listener (listens, leaves notes) — and changes or removes people.
 */

type Role = "owner" | "editor" | "viewer";
interface Member {
  id: string;
  email: string;
  name: string;
  role: Role;
}
interface Invite {
  token: string;
  role: "editor" | "viewer";
  expires_at: string;
}

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", editor: "Can edit", viewer: "Can listen" };
const ROLE_HINT: Record<"editor" | "viewer", string> = { editor: "writes, records, mixes", viewer: "listens, leaves notes" };

const linkOf = (token: string) => `${window.location.origin}/join/${token}`;
const until = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export function People({ pid, title, role }: { pid: string; title: string; role: Role }) {
  const account = useAccount();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const owner = role === "owner";

  const send = useCallback(
    async (method: string, query = "", payload?: unknown) => {
      setBusy(true);
      setErr(null);
      try {
        const res = await fetch(`/api/projects/${pid}/members${query}`, {
          method,
          headers: payload ? { "content-type": "application/json" } : undefined,
          body: payload ? JSON.stringify(payload) : undefined,
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string; members?: Member[]; invites?: Invite[]; token?: string; left?: boolean };
        if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
        if (data.members) setMembers(data.members);
        if (data.invites) setInvites(data.invites);
        return data;
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Something went wrong");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [pid],
  );

  useEffect(() => {
    if (!account?.accounts) return;
    let gone = false;
    void fetch(`/api/projects/${pid}/members`)
      .then((r) => r.json())
      .then((d: { members?: Member[]; invites?: Invite[] }) => {
        if (gone) return;
        setMembers(d.members ?? []);
        setInvites(d.invites ?? []);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [account?.accounts, pid]);

  if (!account) return null;
  if (!account.accounts)
    return (
      <div className="space-y-2">
        <p className="label">People</p>
        <p className="rounded-2xl bg-panel px-4 py-3 text-sm text-muted ring-1 ring-line/60">
          Sharing songs with other musicians needs accounts: set <span className="font-mono">APP_PASSWORD</span> in Vercel (it becomes the access code), then
          everyone signs in with their own account.
        </p>
      </div>
    );

  const invite = async (r: "editor" | "viewer") => {
    const d = await send("POST", "", { role: r });
    if (d?.token) {
      setFresh(d.token);
      void send("GET");
      const link = linkOf(d.token);
      if ("share" in navigator) void navigator.share({ title, text: `Work on “${title}” with me on VerseFlow`, url: link }).catch(() => {});
    }
  };
  const copy = (token: string) =>
    void navigator.clipboard.writeText(linkOf(token)).then(
      () => setCopied(token),
      () => {},
    );

  return (
    <div className="space-y-2">
      <p className="label">People</p>
      <div className="divide-y divide-line/60 rounded-2xl bg-panel ring-1 ring-line/60">
        {(members ?? []).map((m) => {
          const me = m.id === account.user?.id;
          return (
            <div key={m.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {m.name}
                  {me && <span className="font-normal text-muted"> (you)</span>}
                </p>
                <p className="truncate text-xs text-muted">{m.email}</p>
              </div>
              {owner && !me ? (
                <>
                  <select
                    className="rounded-lg bg-panel-2 px-2 py-1.5 text-xs font-semibold"
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => void send("PATCH", "", { userId: m.id, role: e.target.value })}
                    aria-label={`${m.name}'s role`}
                  >
                    {(["owner", "editor", "viewer"] as const).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  <button
                    className="text-muted"
                    disabled={busy}
                    aria-label={`Take ${m.name} off the song`}
                    onClick={() => {
                      if (window.confirm(`Take ${m.name} off “${title}”?`)) void send("DELETE", `?user=${m.id}`);
                    }}
                  >
                    <Trash className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <span className="text-xs font-semibold text-muted">{ROLE_LABEL[m.role]}</span>
              )}
            </div>
          );
        })}
        {members === null && <p className="px-4 py-3 text-sm text-muted">Loading…</p>}
      </div>

      {owner && (
        <>
          <div className="grid grid-cols-2 gap-2">
            {(["editor", "viewer"] as const).map((r) => (
              <button key={r} className="btn flex-col items-start gap-0 rounded-2xl px-4 py-2.5 text-left" disabled={busy} onClick={() => void invite(r)}>
                <span className="text-sm font-semibold">Invite · {ROLE_LABEL[r].toLowerCase()}</span>
                <span className="text-[11px] text-muted">{ROLE_HINT[r]}</span>
              </button>
            ))}
          </div>
          {invites.length > 0 && (
            <div className="space-y-1.5">
              {invites.map((i) => (
                <div key={i.token} className={`flex items-center gap-2 rounded-2xl px-4 py-2 text-sm ring-1 ${i.token === fresh ? "bg-ok-soft ring-ok/30" : "bg-panel ring-line/60"}`}>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">Invitation link · {ROLE_LABEL[i.role].toLowerCase()}</p>
                    <p className="text-xs text-muted">works until {until(i.expires_at)} · for anyone who has it</p>
                  </div>
                  <button className="rounded-lg bg-panel-2 px-2.5 py-1.5 text-xs font-semibold" onClick={() => copy(i.token)}>
                    {copied === i.token ? "Copied" : "Copy"}
                  </button>
                  <button className="text-muted" disabled={busy} aria-label="Turn the link off" onClick={() => void send("DELETE", `?invite=${i.token}`)}>
                    <Trash className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted">
            Whoever opens an invitation makes an account (no access code needed) and the song appears in their list. Their AI writing and voice use
            this app&apos;s keys.
          </p>
        </>
      )}
      {!owner && account.user && (
        <button
          className="text-sm font-semibold text-bad"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm(`Leave “${title}”? You'll need a new invitation to come back.`)) return;
            const d = await send("DELETE", `?user=${account.user!.id}`);
            if (d?.left) window.location.href = "/";
          }}
        >
          Leave this song
        </button>
      )}
      {err && <p className="text-sm text-bad">{err}</p>}
    </div>
  );
}
