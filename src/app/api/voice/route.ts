import { body, handle } from "@/lib/server/http";
import { cloneVoice, deleteVoice, getVoice, voiceUploadUrl } from "@/lib/server/voice";

export const maxDuration = 120;

const pub = (v: Awaited<ReturnType<typeof getVoice>>) => (v ? { name: v.name, created_at: v.created_at } : null);

/** the writer's cloned voice: GET → {voice} */
export async function GET() {
  return handle(async () => Response.json({ voice: pub(await getVoice()) }));
}

/**
 *  uploadUrl {ext}                → {path, signedUrl}  the browser PUTs a voice sample straight to storage
 *  clone {paths, name, consent}   → {voice}            1 ElevenLabs call (replaces an older voice)
 */
export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{ action: string; paths?: string[]; name?: string; consent?: boolean; ext?: string }>(req);
    if (b.action === "uploadUrl") return Response.json(await voiceUploadUrl(b.ext?.toLowerCase()));
    if (b.action === "clone") {
      if (b.consent !== true) return Response.json({ error: "Confirm that this is your own voice." }, { status: 400 });
      const paths = (b.paths ?? []).filter((p) => typeof p === "string").slice(0, 5);
      if (!paths.length) return Response.json({ error: "Record or upload your voice first." }, { status: 400 });
      return Response.json({ voice: pub(await cloneVoice(paths, b.name?.trim() || "My voice")) });
    }
    return Response.json({ error: "Unknown action" }, { status: 400 });
  });
}

export async function DELETE() {
  return handle(async () => {
    await deleteVoice();
    return Response.json({ voice: null });
  });
}
