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
  setInsertTarget: (fn: ((word: string) => void) | null) => void;
  insertWord: (word: string) => void;
  lookupRhyme: (text: string) => void;
  aiEnabled: boolean;
}

export const WriterContext = createContext<WriterApi | null>(null);

export function useWriter() {
  const ctx = useContext(WriterContext);
  if (!ctx) throw new Error("useWriter outside WriterContext");
  return ctx;
}
