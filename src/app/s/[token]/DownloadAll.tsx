"use client";

import { zip } from "fflate";
import { useState } from "react";

/** every file in one ZIP, put together in this browser (the files are stored one by one) */
export function DownloadAll({ title, files, note }: { title: string; files: { name: string; url: string }[]; note: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const all = async () => {
    setErr(null);
    try {
      const out: Record<string, [Uint8Array, { level: 0 }]> = {};
      for (const [i, f] of files.entries()) {
        setBusy(`Downloading ${i + 1}/${files.length} · ${f.name}`);
        const r = await fetch(f.url);
        if (!r.ok) throw new Error(`${f.name}: ${r.status} — reload the page and try again`);
        out[f.name] = [new Uint8Array(await r.arrayBuffer()), { level: 0 }];
      }
      if (note) out["How to open in Logic.txt"] = [new TextEncoder().encode(note), { level: 0 }];
      setBusy("Packing the ZIP…");
      const data = await new Promise<Uint8Array>((res, rej) => zip(out, (e, d) => (e ? rej(e) : res(d))));
      const url = URL.createObjectURL(new Blob([data.buffer as ArrayBuffer], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title.replace(/[\\/:*?"<>|]+/g, "-")} - stems.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The download failed.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-2">
      <button className="btn-primary w-full justify-center rounded-2xl py-3.5 text-[15px] disabled:opacity-70" disabled={!!busy} onClick={() => void all()}>
        {busy ?? `Download all · ZIP`}
      </button>
      {err && <p className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad">{err}</p>}
    </div>
  );
}
