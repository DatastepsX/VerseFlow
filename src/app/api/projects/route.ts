import { createProject, listProjects } from "@/lib/server/repo";
import { body, handle } from "@/lib/server/http";
import type { ProjectSettings, ProjectType } from "@/lib/types";

export async function GET() {
  return handle(async () => Response.json(await listProjects()));
}

export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{ title?: string; type?: ProjectType; language?: string; concept?: string; settings?: ProjectSettings }>(req);
    const project = await createProject({
      title: b.title ?? "Untitled",
      type: b.type ?? "song",
      language: b.language ?? "it",
      concept: b.concept ?? null,
      settings: b.settings ?? {},
    });
    return Response.json(project, { status: 201 });
  });
}
