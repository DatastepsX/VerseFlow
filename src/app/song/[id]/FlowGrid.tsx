"use client";

import { useState } from "react";
import { cycle, flowFromGrid, STEPS_PER_BEAT, type FlowGridModel } from "@/lib/flow/grid";
import type { LineFlow } from "@/lib/types";
import { Check, Play } from "@/components/icons";

/**
 * A line's flow on the beat, drum-machine style: one cell per 16th note,
 * a beat = 4 cells. Tap a cell: empty → syllable → stressed → empty.
 * Listen plays the beat with a click on every syllable (stressed louder).
 */
export function FlowGrid({
  initial,
  flow,
  saving,
  onListen,
  onSave,
  onCancel,
}: {
  initial: FlowGridModel;
  flow: LineFlow | null;
  saving: boolean;
  onListen: (g: FlowGridModel) => void;
  onSave: (f: LineFlow) => void;
  onCancel: () => void;
}) {
  const [cells, setCells] = useState(initial.cells);
  const g = { ...initial, cells };
  const count = cells.filter(Boolean).length;
  const stressed = cells.filter((c) => c === 2).length;
  const bars = Math.ceil(cells.length / (4 * STEPS_PER_BEAT));
  return (
    <div className="mt-3 rounded-2xl bg-panel-2/70 p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-semibold">
          {count} syllable{count === 1 ? "" : "s"}
          <span className="font-normal text-muted"> · {stressed} stressed</span>
        </span>
        <span className="flex items-center gap-2 text-muted">
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-accent/35" /> syllable
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-accent" /> stressed
          </span>
        </span>
      </div>
      {Array.from({ length: bars }, (_, b) => (
        <div key={b} className="mb-1.5 grid grid-cols-2 gap-x-2.5 gap-y-1.5">
          {Array.from({ length: 4 }, (_, beat) => (
            <div key={beat} className="grid grid-cols-4 gap-[3px]">
              {Array.from({ length: STEPS_PER_BEAT }, (_, s) => {
                const i = (b * 4 + beat) * STEPS_PER_BEAT + s;
                const c = cells[i];
                return (
                  <button
                    key={s}
                    aria-label={`Beat ${beat + 1}, step ${s + 1}: ${c === 2 ? "stressed" : c === 1 ? "syllable" : "empty"}`}
                    className={`relative h-11 rounded-lg transition-colors ${c === 2 ? "bg-accent" : c === 1 ? "bg-accent/35" : s === 0 ? "bg-panel ring-1 ring-line" : "bg-panel"}`}
                    onClick={() => setCells((prev) => prev.map((x, k) => (k === i ? cycle(x) : x)))}
                  >
                    {s === 0 && c === 0 && <span className="absolute left-1 top-0.5 text-[9px] font-semibold text-muted">{beat + 1}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ))}
      <div className="mt-2 flex gap-1.5">
        <button className="btn flex-1 justify-center rounded-xl border-0 bg-panel py-2" onClick={() => onListen(g)}>
          <Play className="h-4 w-4" /> Listen
        </button>
        <button className="btn justify-center rounded-xl border-0 bg-panel px-3 py-2" onClick={() => setCells(cells.map(() => 0))}>
          Clear
        </button>
        <button className="btn justify-center rounded-xl border-0 bg-panel px-3 py-2" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn-primary flex-1 justify-center rounded-xl py-2" disabled={saving || !count} onClick={() => onSave(flowFromGrid(g, flow))}>
          <Check className="h-4 w-4" /> Save
        </button>
      </div>
    </div>
  );
}
