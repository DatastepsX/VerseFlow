import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getTree, NotFound } from "@/lib/server/repo";
import { SongApp } from "./SongApp";

export default function SongPage(props: PageProps<"/song/[id]">) {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-bg" />}>
      <SongView params={props.params} />
    </Suspense>
  );
}

async function SongView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let tree;
  try {
    tree = await getTree(id);
  } catch (e) {
    if (e instanceof NotFound || (e instanceof Error && /invalid input syntax/.test(e.message))) notFound();
    throw e;
  }
  return <SongApp initialTree={tree} />;
}
