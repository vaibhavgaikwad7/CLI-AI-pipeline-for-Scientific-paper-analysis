import fs from "fs/promises";
import path from "path";
import pLimit from "p-limit";

import { exists, sha1 } from "../utils";
import { MetadataSchema, Provider } from "../types";

import { parseWithGrobid } from "../parsers/grobid";
import { parseWithUnstructured } from "../parsers/unstructured";
import { parseWithPdfParse } from "../parsers/pdf";

import { providerFactory, runLLMEnsemble } from "../llm";
import { fuseCandidates, guessDocumentType } from "../ensemble";

/**
 * Minimal pipeline for the backend API.
 * Same logic as CLI but simplified for server usage.
 */

export async function runPipeline({
  pdf,
  provider = "anthropic",
  model,
  grobidUrl,
  unstructuredUrl,
}: {
  pdf: string;
  provider: Provider | string;
  model?: string;
  grobidUrl?: string;
  unstructuredUrl?: string;
}) {
  // --- Validate PDF path
  if (!(await exists(pdf))) {
    throw new Error(`PDF not found at path: ${pdf}`);
  }

  // Limit concurrency for LLM requests
  const limit = pLimit(3);

  let parsed: any = null;

  // --- Try parsing stages in order
  try {
    if (grobidUrl) {
      parsed = await parseWithGrobid(pdf, grobidUrl);
      console.log("[parse] GROBID succeeded");
    }
  } catch (e: any) {
    console.log("[parse] GROBID failed, continuing:", e.message);
  }

  try {
    if (!parsed && unstructuredUrl) {
      parsed = await parseWithUnstructured(pdf, unstructuredUrl);
      console.log("[parse] Unstructured succeeded");
    }
  } catch (e: any) {
    console.log("[parse] Unstructured failed, continuing:", e.message);
  }

  // Fallback parser (always works)
  if (!parsed) {
    parsed = await parseWithPdfParse(pdf);
    console.log("[parse] Parsed via pdf-parse fallback");
  }

  // --- Soft hints for LLM
  const hints = {
    authors: parsed.candidates?.authors ?? null,
    document_date: parsed.candidates?.document_date ?? null,
    document_type: guessDocumentType(parsed.sections),
  };

  // --- Initialize provider
  const providerInstance = providerFactory(provider as Provider, model);

  // Cache key (not used now, but can be enabled later)
  const _cacheKey = `${await sha1(await fs.readFile(pdf))}.${provider}.${providerInstance.model}`;

  // --- Run LLM stage with fallback logic
  let llmOutput = null;

  try {
    llmOutput = await runLLMEnsemble(
      providerInstance as any,
      parsed.sections,
      hints,
      limit
    );
  } catch (e: any) {
    const status = e?.status ?? 0;
    const transient = [429, 500, 502, 503, 504, 522, 525, 529].includes(status);

    if (transient) {
      console.log("[warn] Primary provider failed → switching to OpenAI fallback");
      const fallbackProvider = providerFactory("openai", "gpt-4o-mini");
      const slowLimit = pLimit(1);
      llmOutput = await runLLMEnsemble(
        fallbackProvider,
        parsed.sections,
        hints,
        slowLimit
      );
    } else {
      throw e;
    }
  }

  // --- Fuse all signals into final JSON
  const fused = fuseCandidates(parsed.candidates, parsed, llmOutput, parsed.sections);

  const final = MetadataSchema.parse({
    document_type: fused.document_type?.value ?? null,
    authors: fused.authors?.value ?? null,
    document_date: fused.document_date?.value ?? null,
    summary: fused.summary?.value ?? null,
    methods_summary: fused.methods_summary?.value ?? null,
    findings_summary: fused.findings_summary?.value ?? null,
  });

  return final;
}
