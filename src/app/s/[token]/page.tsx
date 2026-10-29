import { Suspense } from "react";
import type { Metadata } from "next";
import { publicShare } from "@/lib/server/repo";
import { DownloadAll } from "./DownloadAll";

/**
 * A share link: the song's stems (and the mix) to download — for anyone with the link, no account needed.
 * The files' addresses are made fresh on every visit (valid 2 hours); the link itself ends when it expires or
 * is revoked.
 */
export const metadata: Metadata = { title: "Shared song · VerseFlow", robots: { index: false, follow: false } };

export default function SharePage(props: PageProps<"/s/[token]">) {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-lg px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <Share params={props.params} />
      </Suspense>
    </main>
  );
}

const size = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

async function Share({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const s = await publicShare(token);
  if (!s)
    return (
      <div className="space-y-2 pt-10 text-center">
        <h1 className="text-2xl font-extrabold">This link doesn&apos;t work any more</h1>
        <p className="text-sm text-muted">It has expired or was turned off. Ask for a new one.</p>
      </div>
    );
  const total = s.files.reduce((n, f) => n + f.bytes, 0);
  return (
    <div className="space-y-5">
      <header>
        <p className="label">Shared with you</p>
        <h1 className="text-3xl font-extrabold tracking-tight">{s.title || "A song"}</h1>
        <p className="mt-1 text-xs text-muted">
          {s.files.length} file{s.files.length === 1 ? "" : "s"} · {size(total)} · available until {new Date(s.expires_at).toLocaleDateString("en-GB", { day: "numeric", month: "long" })}
        </p>
      </header>
      <DownloadAll title={s.title || "Song"} files={s.files.map((f) => ({ name: f.name, url: f.url }))} note={s.note} />
      <ul className="divide-y divide-line/60 rounded-2xl bg-panel ring-1 ring-line/60">
        {s.files.map((f) => (
          <li key={f.name} className="flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{f.name}</span>
              <span className="text-xs text-muted">{size(f.bytes)}</span>
            </span>
            <a href={f.url} className="shrink-0 rounded-full bg-panel-2 px-3 py-1.5 text-xs font-semibold" download={f.name}>
              Download
            </a>
          </li>
        ))}
      </ul>
      {s.note && <pre className="whitespace-pre-wrap rounded-2xl bg-panel-2/70 px-4 py-3 font-sans text-xs text-muted">{s.note}</pre>}
      <p className="text-center text-[11px] text-muted">Made with VerseFlow</p>
    </div>
  );
}
