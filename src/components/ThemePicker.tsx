"use client";

import { useEffect, useState } from "react";
import { loadProfile, onProfile, saveProfilePref } from "@/lib/client/profile";

export type Theme = "auto" | "light" | "dark";
const KEY = "verseflow.theme";

/** read the stored theme (this device) */
export function storedTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

/** apply and store the theme: "auto" follows the device's light / dark setting (kept with your profile) */
export function chooseTheme(t: Theme) {
  setTheme(t);
  saveProfilePref(KEY, t);
}

/** apply the theme here (this device's copy) */
export function setTheme(t: Theme) {
  try {
    if (t === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {}
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  // the status bar colour: the chosen theme's, or (automatic) each tag's own light / dark one
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const dark = t === "dark" || (t === "auto" && m.media.includes("dark"));
    m.content = dark ? "#111113" : "#f7f6f3";
  });
}

/** your profile's theme, applied on every page as it loads (and when it changes on another screen) */
export function ProfileTheme() {
  useEffect(() => {
    const off = onProfile((k, v) => k === KEY && setTheme(v === "light" || v === "dark" ? v : "auto"));
    void loadProfile();
    return off;
  }, []);
  return null;
}

/** Automatic · Light · Dark — kept with your profile (every device) */
export function ThemePicker() {
  const [theme, set] = useState<Theme>(() => (typeof window === "undefined" ? "auto" : storedTheme()));
  useEffect(() => onProfile((k, v) => k === KEY && set(v === "light" || v === "dark" ? v : "auto")), []);
  return (
    <div className="flex rounded-full bg-panel-2 p-1" role="radiogroup" aria-label="Appearance">
      {(
        [
          ["auto", "Automatic"],
          ["light", "Light"],
          ["dark", "Dark"],
        ] as const
      ).map(([t, label]) => (
        <button
          key={t}
          role="radio"
          aria-checked={theme === t}
          className={`flex-1 rounded-full py-2 text-sm font-semibold transition-colors ${theme === t ? "bg-panel text-fg shadow-sm" : "text-muted"}`}
          onClick={() => {
            set(t);
            chooseTheme(t);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
