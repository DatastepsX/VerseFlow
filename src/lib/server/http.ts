import "server-only";
import { AiUnavailable } from "./ai";
import { getTree, NotFound } from "./repo";

export async function treeResponse(projectId: string) {
  return Response.json(await getTree(projectId));
}

export function handle(fn: () => Promise<Response>): Promise<Response> {
  return fn().catch((e: unknown) => {
    const message = e instanceof Error ? e.message : "Unexpected error";
    const status = e instanceof NotFound ? 404 : e instanceof AiUnavailable ? 503 : 500;
    if (status === 500) console.error(e);
    return Response.json({ error: message }, { status });
  });
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export function pick<T extends object>(obj: Record<string, unknown>, keys: (keyof T)[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if ((k as string) in obj) out[k as string] = obj[k as string];
  return out as Partial<T>;
}
