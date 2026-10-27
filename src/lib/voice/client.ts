"use client";

import type { PlayLayer } from "@/lib/studio/engine";
import type { ProjectTree } from "@/lib/types";
import { lineSlots, planLine, planSyllables, renderLine, type SpokenWord } from "./guide";
import { slotsWithMarks } from "@/lib/flow/notation";
import { marksFor } from "@/lib/marks";

/**
 * The guide vocal in the browser: the lines spoken in the writer's voice
 * (1 call per line not spoken before, then cached on the server), each laid
 * onto the flow it was sung in, ready to play with the beat.
 */

const rendered = new Map<string, PlayLayer>();
const keyOf = (l: { id: string; text: string; flow: unknown; audio_at: number | null; marks?: unknown }) => `${l.id}|${l.text.trim()}|${l.audio_at}|${JSON.stringify(l.flow)}|${JSON.stringify(l.marks ?? null)}`;

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function lyric(tree: ProjectTree) {
  return tree.sections.flatMap((s) => s.lines.filter((l) => l.kind === "lyric" && l.text.trim()));
}

/** lines spoken in the voice already (playing them is free) */
export async function spokenIds(pid: string, tree: ProjectTree) {
  const ids = lyric(tree).map((l) => l.id);
  if (!ids.length) return [];
  return (await post<{ ids: string[] }>(`/api/projects/${pid}/voice`, { action: "spoken", lineIds: ids })).ids;
}

/** guide-vocal layers for the lines (rendered once per line text + flow) */
export async function guideLayers(pid: string, tree: ProjectTree, lineIds: string[], ctx: AudioContext): Promise<PlayLayer[]> {
  const all = lyric(tree);
  const lines = all.filter((l) => lineIds.includes(l.id));
  const missing = lines.filter((l) => !rendered.has(keyOf(l)));
  if (missing.length) {
    const spoken: { lineId: string; url: string; words: SpokenWord[] }[] = [];
    for (let i = 0; i < missing.length; i += 20) {
      const r = await post<{ lines: typeof spoken }>(`/api/projects/${pid}/voice`, { action: "speak", lineIds: missing.slice(i, i + 20).map((l) => l.id) });
      spoken.push(...r.lines);
    }
    await Promise.all(
      spoken.map(async (s) => {
        const l = missing.find((x) => x.id === s.lineId);
        if (!l) return;
        const buf = await ctx.decodeAudioData(await fetch(s.url).then((r) => r.arrayBuffer()));
        const next = all[all.indexOf(l) + 1];
        const flowSlots = lineSlots(l, next?.audio_at ?? null, tree.project.language);
        if (!flowSlots) return;
        // the writer's symbols (double-time, breaks, holds) move the syllables within the line's stretch
        const marked = slotsWithMarks(flowSlots, l.text, tree.project.language, marksFor(l));
        const slots = marked?.slots ?? flowSlots;
        const flow = marked
          ? { long: [...marked.long, ...(l.flow?.syllables === marked.slots.times.length ? (l.flow.long ?? []) : [])], held: !!l.flow?.held, pauses: [] }
          : l.flow;
        // syllable by syllable on the flow (breaks stay silent, long notes held); else word by word
        const plan = planSyllables(l.text, s.words, tree.project.language, slots, flow) ?? planLine(s.words, tree.project.language, slots);
        const { samples, origin } = renderLine(buf.getChannelData(0), buf.sampleRate, plan);
        if (!samples.length) return;
        const out = ctx.createBuffer(1, samples.length, buf.sampleRate);
        out.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
        rendered.set(keyOf(l), { buffer: out, at: origin, gain: 1 });
      }),
    );
  }
  return lines.map((l) => rendered.get(keyOf(l))).filter((x): x is PlayLayer => !!x);
}
