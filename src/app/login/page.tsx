"use client";

import { useSyncExternalStore } from "react";
import { AuthForm } from "@/components/AuthForm";

const nextParam = () => new URLSearchParams(window.location.search).get("next") ?? "/";

export default function Login() {
  const next = useSyncExternalStore(
    () => () => {},
    nextParam,
    () => "/",
  );
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-panel p-6">
        <div>
          <h1 className="text-xl font-bold">VerseFlow</h1>
          <p className="text-sm text-muted">Sign in to your songs.</p>
        </div>
        <AuthForm next={next} />
      </div>
    </main>
  );
}
