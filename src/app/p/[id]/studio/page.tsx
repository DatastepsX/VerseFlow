import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getTree, NotFound } from "@/lib/server/repo";
import { Studio } from "./Studio";

export default function StudioPage(props: PageProps<"/p/[id]/studio">) {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-[#0b0b0d]" />}>
      <StudioView params={props.params} />
    </Suspense>
  );
}

async function StudioView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let tree;
  try {
    tree = await getTree(id);
  } catch (e) {
    if (e instanceof NotFound || (e instanceof Error && /invalid input syntax/.test(e.message))) notFound();
    throw e;
  }
  return <Studio initialTree={tree} />;
}
