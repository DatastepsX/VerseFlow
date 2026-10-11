import type { LineEvent, ProjectTree, ProjectVersion } from "@/lib/types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const projectApi = {
  tree: (id: string) => api<ProjectTree>(`/api/projects/${id}`),
  history: (id: string, lineId?: string) =>
    api<LineEvent[]>(`/api/projects/${id}/history${lineId ? `?line=${lineId}` : ""}`),
  versions: (id: string) => api<ProjectVersion[]>(`/api/projects/${id}/versions`),
};
