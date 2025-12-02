// src/types.ts
import { z } from "zod";

export type Provider = "anthropic" | "openai" | "ollama";

export interface Sections {
  headerText?: string;
  body?: string;
  title?: string;
  abstract?: string;
  introduction?: string;
  methods?: string;
  results?: string;
  discussion?: string;
  conclusion?: string;
}

export interface Field<T> {
  value: T | null;
  confidence: number; // used internally for fusion
  provenance: "llm" | "heuristic" | "grobid" | "unstructured" | string;
}

export interface Metadata {
  document_type: string | null;
  authors: string[] | null;
  document_date: string | null;
  summary: string | null;
  methods_summary: string | null;
  findings_summary: string | null;
}

export interface ParsedDoc {
  ok: boolean;
  method: "heuristic" | "grobid" | "unstructured" | "authority";
  sections: Sections;
  candidates: Partial<Metadata>;
  /** extra flags from parsers; optional */
  meta?: {
    /** set true when precise date was parsed from header text */
    dateFromHeader?: boolean;
  };
}

/* If you’re using zod elsewhere, keep your existing schemas. Example: */
export const MetadataSchema = z.object({
  document_type: z.string().nullable(),
  authors: z.array(z.string()).nullable(),
  document_date: z.string().nullable(), // ISO "YYYY" | "YYYY-MM" | "YYYY-MM-DD"
  summary: z.string().nullable(),
  methods_summary: z.string().nullable(),
  findings_summary: z.string().nullable(),
});
export type MetadataZ = z.infer<typeof MetadataSchema>;
