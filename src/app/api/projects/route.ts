import { parseText } from "@/lib/text-import";
import { createProject, importSections, listProjects } from "@/lib/server/repo";
import { body, handle } from "@/lib/server/http";
import type { ProjectSettings, ProjectType } from "@/lib/types";

export async function GET() {
  return handle(async () => Response.json(await listProjects()));
}

export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{
      title?: string;
      type?: ProjectType;
      language?: string;
      concept?: string;
      settings?: ProjectSettings;
      /** pasted lyrics / poem: becomes the project's sections and lines */
      text?: string;
    }>(req);
    const project = await createProject({
      title: b.title ?? "Untitled",
      type: b.type ?? "song",
      language: b.language ?? "it",
      concept: b.concept ?? null,
      settings: b.settings ?? {},
    });
    const sections = b.text?.trim() ? parseText(b.text.slice(0, 50000), project.type) : [];
    if (sections.length) await importSections(project.id, sections, project.type === "song" || project.type === "rap" ? 2 : 1, true);
    return Response.json(project, { status: 201 });
  });
}
