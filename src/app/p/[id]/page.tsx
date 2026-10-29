import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Writer } from "@/components/writer/Writer";
import { aiConfigured } from "@/lib/server/ai";
import { getTree, NotFound } from "@/lib/server/repo";
import { myRole } from "@/lib/server/users";

export default function ProjectPage(props: PageProps<"/p/[id]">) {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted">Loading…</p>}>
      <ProjectWriter params={props.params} />
    </Suspense>
  );
}

async function ProjectWriter({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await myRole(id))) notFound();
  let tree;
  try {
    tree = await getTree(id);
  } catch (e) {
    if (e instanceof NotFound || (e instanceof Error && /invalid input syntax/.test(e.message))) notFound();
    throw e;
  }
  return <Writer initial={tree} aiEnabled={aiConfigured()} />;
}
