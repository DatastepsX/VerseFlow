"use client";

import { createContext, useContext } from "react";
import type { ProjectTree } from "@/lib/types";

export interface GenerateOptions {
  scope?: "line" | "group";
  instruction?: string;
  count?: number;
  rhymeStrength?: "exact" | "loose" | "none";
}

export interface WriterApi {
  tree: ProjectTree;
  lang: string;
  /** call an API endpoint that returns the updated project tree */
  mutate: (path: string, body?: unknown, method?: string) => Promise<Response | null>;
  selectedId: string | null;
  select: (id: string | null) => void;
  generating: Set<string>;
  generate: (lineId: string, opts?: GenerateOptions) => Promise<void>;
  /** the focused text field registers a function that inserts a word into it */
  setInsertTarget: (fn: ((text: string, mode?: "append" | "replace") => void) | null) => void;
  insertWord: (word: string) => void;
  /** put a whole bar into the line being written (replaces its text) */
  placeBar: (text: string) => void;
  lookupRhyme: (text: string) => void;
  /** sections whose bank is being filled */
  filling: Set<string>;
  /** one AI call that stocks a section's suggestion bank */
  fillBank: (sectionId: string, targets?: string[]) => Promise<void>;
  /** fill the bank once, automatically, when a section's first lines are written */
  autoFillBank: (sectionId: string) => void;
  /** the one call that prepares suggestions for the whole song is running */
  songFilling: boolean;
  fillSong: () => Promise<void>;
  aiEnabled: boolean;
}

export const WriterContext = createContext<WriterApi | null>(null);

export function useWriter() {
  const ctx = useContext(WriterContext);
  if (!ctx) throw new Error("useWriter outside WriterContext");
  return ctx;
}
