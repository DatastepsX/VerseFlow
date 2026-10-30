"use client";

import Image from "next/image";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AuthForm } from "@/components/AuthForm";
import { resumeDeviceSignIn } from "@/lib/client/account";

const nextParam = () => new URLSearchParams(window.location.search).get("next") ?? "/";

export default function Login() {
  const next = useSyncExternalStore(
    () => () => {},
    nextParam,
    () => "/",
  );
  // this device signed in before: back in without the password
  const [resuming, setResuming] = useState(true);
  useEffect(() => {
    let gone = false;
    void resumeDeviceSignIn().then((ok) => {
      if (gone) return;
      if (ok) window.location.replace(nextParam().startsWith("/") && !nextParam().startsWith("//") ? nextParam() : "/");
      else setResuming(false);
    });
    return () => {
      gone = true;
    };
  }, []);
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-panel p-6">
        <div className="flex items-center gap-3">
          <Image src="/icon-192.png" alt="" width={48} height={48} priority className="h-12 w-12 rounded-[13px] shadow-md shadow-accent/30" />
          <div>
            <h1 className="text-xl font-bold">VerseFlow</h1>
            <p className="text-sm text-muted">Sign in to your songs.</p>
          </div>
        </div>
        {resuming ? <p className="py-6 text-center text-sm text-muted">Signing you in…</p> : <AuthForm next={next} />}
      </div>
    </main>
  );
}
