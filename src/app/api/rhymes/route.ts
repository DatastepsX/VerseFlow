import { connection } from "next/server";
import { findRhymes } from "@/lib/rhyme/dictionary";
import { handle } from "@/lib/server/http";

export async function GET(req: Request) {
  await connection();
  return handle(async () => {
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    const lang = url.searchParams.get("lang") ?? "it";
    return Response.json(await findRhymes(q.slice(0, 200), lang), {
      headers: { "cache-control": "private, max-age=3600" },
    });
  });
}
