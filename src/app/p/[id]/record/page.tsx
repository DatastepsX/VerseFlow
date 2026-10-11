import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getTree, NotFound } from "@/lib/server/repo";
import { Recorder } from "./Recorder";

export default function RecordPage(props: PageProps<"/p/[id]/record">) {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-[#0b0b0d]" />}>
      <RecordView params={props.params} />
    </Suspense>
  );
}

async function RecordView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let tree;
  try {
    tree = await getTree(id);
  } catch (e) {
    if (e instanceof NotFound || (e instanceof Error && /invalid input syntax/.test(e.message))) notFound();
    throw e;
  }
  return <Recorder tree={tree} />;
}
