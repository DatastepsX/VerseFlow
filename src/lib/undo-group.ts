/**
 * Undo steps on the client: an action that takes several requests (a new
 * flow: its lines, then their lyrics) runs inside `undoStep`, and every
 * request made meanwhile carries the same step id and a label — so one tap
 * on Undo takes the whole action back ("Undone: New flow · Part 2").
 */

let current: { id: string; label: string } | null = null;

export async function undoStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
  // inside another step: part of it
  if (current) return fn();
  current = { id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, label };
  try {
    return await fn();
  } finally {
    current = null;
  }
}

/** headers for a request made now */
export function undoHeaders(): Record<string, string> {
  return current ? { "x-undo-step": current.id, "x-undo-label": encodeURIComponent(current.label) } : {};
}
