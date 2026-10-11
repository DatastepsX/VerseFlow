"use client";

import { useEffect } from "react";

/**
 * Keeps the line under the playhead in view while the song plays.
 * - scrolls only the element's own scroll container (side panel, mobile
 *   panel or the page), centring the line
 * - pauses for a few seconds after the writer scrolls by hand, and never
 *   moves the page while a text field is being edited
 */

let manualUntil = 0;
if (typeof window !== "undefined") {
  const pause = () => (manualUntil = Date.now() + 4000);
  window.addEventListener("wheel", pause, { passive: true });
  window.addEventListener("touchmove", pause, { passive: true });
  window.addEventListener("keydown", (e) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) pause();
  });
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

export function followTo(el: HTMLElement | null, force = false) {
  if (!el || el.offsetParent === null) return; // hidden tab
  if (!force) {
    if (Date.now() < manualUntil) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && (a as HTMLInputElement).type === "text"))) return;
  }
  const box = el.getBoundingClientRect();
  const parent = scrollParent(el);
  if (parent) {
    const pb = parent.getBoundingClientRect();
    const target = parent.scrollTop + (box.top - pb.top) - parent.clientHeight / 2 + box.height / 2;
    parent.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  } else {
    // the page: leave room for the sticky header and the player at the bottom
    const target = window.scrollY + box.top - window.innerHeight * 0.4;
    window.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }
}

/** scroll `el()` into view whenever `key` changes while `active` */
export function useFollow(el: () => HTMLElement | null, key: string | null, active: boolean) {
  useEffect(() => {
    if (active && key) followTo(el());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);
}
