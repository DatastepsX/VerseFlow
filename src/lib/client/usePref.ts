"use client";

import { useEffect, useState } from "react";
import { isProfileKey, loadProfile, onProfile, saveProfilePref } from "./profile";

/**
 * A setting: your profile's (recording, timing, appearance — the same in every song and on every device,
 * see ./profile) or this device's (the microphone…). Read after the first render: the browser's copy
 * first, then the profile's when it arrives.
 */
export function usePref<T>(key: string, initial: T, override?: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(override ?? initial);
  useEffect(() => {
    try {
      if (override !== undefined) {
        localStorage.setItem(key, JSON.stringify(override));
        return;
      }
      const raw = localStorage.getItem(key);
      // restoring a saved preference from browser storage after hydration
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setV(raw !== null ? (JSON.parse(raw) as T) : initial);
    } catch {}
    if (!isProfileKey(key)) return;
    const off = onProfile((k, val) => k === key && setV((val ?? initial) as T));
    void loadProfile();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per key
  }, [key]);
  return [
    v,
    (nv: T) => {
      setV(nv);
      try {
        if (nv === null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(nv));
      } catch {}
      saveProfilePref(key, nv);
    },
  ];
}

