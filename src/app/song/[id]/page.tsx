import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getTree, NotFound } from "@/lib/server/repo";
import { SongApp } from "./SongApp";

export default function SongPage(props: PageProps<"/song/[id]">) {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-bg" />}>
      <SongView params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

async function SongView({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  // ?detect=1 (a new song with a track): check whether the track has lyrics; if so, read them and the flow right away
  const q = await searchParams;
  const autoDetect = q.detect === "1";
  // ?view=record (&on=mac: this phone is the remote for the Mac)
  const view = (["flow", "lyrics", "record", "mix", "more"] as const).find((v) => v === q.view);
  const on = q.on === "mac" ? "mac" : undefined;
  let tree;
  try {
    tree = await getTree(id);
  } catch (e) {
    if (e instanceof NotFound || (e instanceof Error && /invalid input syntax/.test(e.message))) notFound();
    throw e;
  }
  return <SongApp initialTree={tree} autoDetect={autoDetect} initialView={view} recordOn={on} />;
}
