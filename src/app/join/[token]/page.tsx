import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { authEnabled } from "@/lib/auth";
import { currentUser, inviteInfo, roleOf } from "@/lib/server/users";
import { JoinButton } from "./JoinButton";

/** an invitation to work on a song: sign in or make an account (no access code needed), and the song is yours too */
export const metadata: Metadata = { title: "Invitation · VerseFlow", robots: { index: false, follow: false } };

export default function JoinPage(props: PageProps<"/join/[token]">) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-10">
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <Join params={props.params} />
      </Suspense>
    </main>
  );
}

const WHAT = { editor: "write, record and mix", viewer: "listen and leave notes" };

async function Join({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!authEnabled()) redirect("/");
  const invite = await inviteInfo(token);
  if (!invite)
    return (
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-extrabold">This invitation doesn&apos;t work any more</h1>
        <p className="text-sm text-muted">It has expired or was turned off. Ask for a new link.</p>
      </div>
    );
  const me = await currentUser();
  // already on the song: straight in
  if (me && (await roleOf(invite.projectId, me.id))) redirect(`/song/${invite.projectId}`);
  return (
    <div className="space-y-5 rounded-xl border border-line bg-panel p-6">
      <header className="space-y-1">
        <p className="label">{invite.by ? `${invite.by} invited you` : "You're invited"}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">{invite.title}</h1>
        <p className="text-sm text-muted">On VerseFlow — you can {WHAT[invite.role]} on this song.</p>
      </header>
      {me ? (
        <JoinButton invite={token} name={me.name} />
      ) : (
        <AuthForm invite={token} next={`/song/${invite.projectId}`} startWith="signup" />
      )}
    </div>
  );
}
