import fs from "fs/promises";
import path from "path";
import pLimit from "p-limit";

import { exists, sha1 } from "./utils";
import { MetadataSchema, Provider } from "./types";
import { parseWithGrobid } from "./parsers/grobid";
import { parseWithUnstructured } from "./parsers/unstructured";
import { parseWithPdfParse } from "./parsers/pdf";

import { providerFactory, runLLMEnsemble } from "./llm";
import { fuseCandidates, guessDocumentType } from "./ensemble";

export async function runPipeline(opts: {
  pdf: string;
  provider: Provider | string;
  model?: string;
  grobidUrl?: string;
  unstructuredUrl?: string;
  debug?: boolean;
}) {
  const log = (...args: any[]) => opts.debug && console.log("[debug]", ...args);

  // --- Validate PDF exists
  const pdfPath = path.resolve(process.cwd(), opts.pdf);
  if (!(await exists(pdfPath))) {
    throw new Error(`PDF not found: ${pdfPath}`);
  }

  // --- Concurrency limit
  const limit = pLimit(3);

  // --- Try parsing
  let parsed: any = null;

  try {
    if (opts.grobidUrl) {
      parsed = await parseWithGrobid(pdfPath, opts.grobidUrl);
      log("Parsed via GROBID");
    }
  } catch (e) {
    log("GROBID failed, continuing");
  }

  if (!parsed && opts.unstructuredUrl) {
    try {
      parsed = await parseWithUnstructured(pdfPath, opts.unstructuredUrl);
      log("Parsed via Unstructured");
    } catch (e) {
      log("Unstructured failed, continuing");
    }
  }

  if (!parsed) {
    parsed = await parseWithPdfParse(pdfPath);
    log("Parsed via pdf-parse heuristic");
  }

  // LLM hints
  const hints = {
    authors: parsed.candidates.authors || null,
    document_date: parsed.candidates.document_date || null,
    document_type: guessDocumentType(parsed.sections),
  };

  // Provider + model
  const prov = (opts.provider as Provider) || "anthropic";
  const provider = providerFactory(prov, opts.model);

  // --- Run ensemble
  let llm: any = null;
  try {
    llm = await runLLMEnsemble(provider as any, parsed.sections, hints, limit);
  } catch (e) {
    throw e;
  }

  // Fuse + sanitize
  const fused = fuseCandidates(parsed.candidates, parsed, llm, parsed.sections);

  const finalMeta = MetadataSchema.parse({
    document_type: fused.document_type.value ?? null,
    authors: fused.authors.value ?? null,
    document_date: fused.document_date.value ?? null,
    summary: fused.summary.value ?? null,
    methods_summary: fused.methods_summary.value ?? null,
    findings_summary: fused.findings_summary.value ?? null,
  });

  return finalMeta;
}
