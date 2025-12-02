// src/llm/index.ts

import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import fetchImpl from "node-fetch";
(globalThis as any).fetch = fetchImpl as any;

import pLimit from "p-limit";
import { FEW_SHOT } from "./shared";
import { Provider } from "../types";
import { truncateForLLM } from "../utils";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAIProvider } from "./providers/openai";
import { OllamaProvider } from "./providers/ollama";

export interface LLMResult {
  document_type: string | null;
  authors: string[] | null;
  document_date: string | null;
  summary: string | null;
  methods_summary: string | null;
  findings_summary: string | null;
}

export interface LLMProvider {
  name: Provider;
  model: string;
  callJSON(prompt: string, sys?: string): Promise<any>;
}

export const providerFactory = (prov: Provider, model?: string): LLMProvider =>
  prov === "anthropic"
    ? new AnthropicProvider(model)
    : prov === "openai"
    ? new OpenAIProvider(model)
    : new OllamaProvider(model);

/* ================================
   PROMPTS (tightened)
   ================================ */

const SYSTEM_PROMPT = `
You extract structured metadata from scientific PDFs.

Rules:
- Use only information present in the provided text (no external knowledge).
- Authors: return an array of full-person names only (no affiliations, roles, degrees, or punctuation like commas with institutions). If none are present, return null.
- Document type: classify as one of {"Preprint","Journal Article","Conference Paper","Thesis","Other"}.
  * If you see cues like "preprint", "has not been peer reviewed", "arXiv", "SSRN", "bioRxiv", "medRxiv", prefer "Preprint".
  * If you see journal cues (journal name, volume/issue/pages/DOI context), consider "Journal Article".
  * If you see conference cues ("Proceedings", "In:", major conference names), consider "Conference Paper".
- Dates: Prefer explicit posted/published/accepted dates visible in the text. If date is unclear, return null.
  * Format dates as ISO if precise (YYYY-MM-DD) or YYYY-MM / YYYY if only partial is visible. If not clearly present, return null.
- Methods summary: Use only what is stated. Do NOT infer instrument brands or modalities (e.g., say "mass spectrometry" if modality is not explicit). Timepoints: report only those explicitly present (e.g., T0/T1/T2). Do not invent additional timepoints.
- Findings summary: Briefly report key outcomes/metrics that are explicitly present (2–4 sentences).
- Keep summaries concise (2–4 sentences).
- Output strict JSON with the exact keys:
  {"document_type": string|null, "authors": string[]|null, "document_date": string|null, "summary": string|null, "methods_summary": string|null, "findings_summary": string|null}
- Output JSON only (no markdown, no commentary).
`.trim();

function buildPromptA(sections: any, hints: any) {
  const text = [
    sections.title,
    sections.abstract,
    sections.introduction,
    sections.methods,
    sections.results,
    sections.discussion,
    sections.conclusion,
  ]
    .filter(Boolean)
    .join("\n\n");

  const clipped = truncateForLLM(text, 12000);
  const hintJSON = JSON.stringify(hints);

  return `
${FEW_SHOT}

Task:
Extract the following fields:
- document_type
- authors
- document_date
- summary (2–4 sentences)
- methods_summary (2–4 sentences)
- findings_summary (2–4 sentences)

HINTS: ${hintJSON}

TEXT:
${clipped}
`.trim();
}

function buildPromptB(sections: any, hints: any) {
  const methodsBlock = sections.methods || sections.body?.slice(0, 6000) || "";
  const resultsBlock = sections.results || sections.discussion || sections.conclusion || "";
  const context = [sections.title, sections.abstract, methodsBlock, resultsBlock]
    .filter(Boolean)
    .join("\n\n");

  const clipped = truncateForLLM(context, 10000);
  const hintJSON = JSON.stringify(hints);

  return `
${FEW_SHOT}

Checklist (answer strictly from TEXT):
1) document_type → {"Preprint","Journal Article","Conference Paper","Thesis","Other"}
2) authors → array of full names only (no affiliations). If none found, null.
3) document_date → ISO if explicit (YYYY-MM-DD / YYYY-MM / YYYY). Else null.
4) summary → concise (2–4 sentences).
5) methods_summary → concise (2–4 sentences). Use only explicit techniques; say "mass spectrometry" if modality unspecified. Only include timepoints that appear in TEXT (e.g., T0/T1/T2).
6) findings_summary → concise (2–4 sentences). Include explicit numbers/metrics if present.

HINTS: ${hintJSON}

TEXT:
${clipped}
`.trim();
}

/* ================================
   ENSEMBLE + MERGE HELPERS
   ================================ */

function isNonEmptyString(x: any): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function isNonEmptyArray(x: any): x is any[] {
  return Array.isArray(x) && x.length > 0;
}

function cleanAuthors(arr: any): string[] {
  // If model returned a single string, split it safely into tokens first.
  if (isNonEmptyString(arr)) {
    arr = arr
      .split(/\s*,\s*|\s*;\s*|\s+and\s+/i)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (!Array.isArray(arr)) return [];

  const DEGREE = /\b(PhD|DPhil|MSc|MS|BSc|BS|MD|DO|MPH|MBA|RN|RM|FMedSci|FRCP|FRCS|FRCPath|FRCA|FRCPC|DDS|DMD|Prof\.?)\b\.?/gi;
  const ORG_OR_GEO_LAST_TOK =
    /^(University|College|School|Hospital|Centre|Center|Institute|Laboratory|Lab|Department|Dept|Faculty|District|Province|City|Region|Campus|Authority|Bureau|Committee)$/i;

  const normalized = arr
    .map((v) => (typeof v === "string" ? v : ""))
    .map((s) =>
      s
        .replace(/[\u00B9\u00B2\u00B3\u2070-\u2079]/g, "") // superscripts
        .replace(/\^?\d+/g, "") // footnote digits
        .replace(DEGREE, "")
        .replace(/[|]/g, ",")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((s) => s.length > 0)
    // drop obvious affiliations/snippets
    .filter((s) => !/[,@]\s*(univ|dept|hospital|school|center|centre|institute)/i.test(s))
    .filter((s) => !/\b(department|university|school|hospital|centre|center|institute|laboratory)\b/i.test(s))
    // ensure looks like a personal name
    .filter((s) => {
      const toks = s.split(/\s+/);
      if (toks.length < 2 || toks.length > 5) return false;
      if (!toks.every((t) => /^(?:[A-Z][a-zA-Z'’\-]+|[A-Z]\.)$/.test(t))) return false;
      if (ORG_OR_GEO_LAST_TOK.test(toks[toks.length - 1])) return false;
      return true;
    })
    // title-case if ALLCAPS
    .map((s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s));

  // de-dupe preserving order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of normalized) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.slice(0, 24);
}

function pickString(aVal: any, bVal: any): string | null {
  const aStr = isNonEmptyString(aVal) ? aVal.trim() : "";
  const bStr = isNonEmptyString(bVal) ? bVal.trim() : "";
  if (aStr && !bStr) return aStr;
  if (!aStr && bStr) return bStr;
  if (!aStr && !bStr) return null;
  // prefer the longer one (usually more informative, still concise per prompt)
  return aStr.length >= bStr.length ? aStr : bStr;
}

function pickAuthors(aVal: any, bVal: any): string[] | null {
  const a = cleanAuthors(aVal);
  const b = cleanAuthors(bVal);
  if (a.length && !b.length) return a;
  if (!a.length && b.length) return b;
  if (!a.length && !b.length) return null;
  // union, preserving order from the longer set first
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  const set = new Set<string>(longer);
  for (const x of shorter) set.add(x);
  return Array.from(set);
}

/* ================================
   RUN ENSEMBLE
   ================================ */

export async function runLLMEnsemble(
  provider: LLMProvider,
  sections: any,
  hints: any,
  limit: ReturnType<typeof pLimit>
): Promise<LLMResult> {
  const [a, b] = await Promise.all([
    limit(() => provider.callJSON(buildPromptA(sections, hints), SYSTEM_PROMPT)),
    limit(() => provider.callJSON(buildPromptB(sections, hints), SYSTEM_PROMPT)),
  ]);

  return {
    document_type: pickString(a?.document_type, b?.document_type),
    authors: pickAuthors(a?.authors, b?.authors),
    document_date: pickString(a?.document_date, b?.document_date),
    summary: pickString(a?.summary, b?.summary),
    methods_summary: pickString(a?.methods_summary, b?.methods_summary),
    findings_summary: pickString(a?.findings_summary, b?.findings_summary),
  };
}
