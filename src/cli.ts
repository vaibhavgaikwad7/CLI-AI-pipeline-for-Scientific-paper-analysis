/**
 * CLI entrypoint for the Document AI pipeline.
 *
 * Responsibilities:
 * - Parse CLI flags
 * - Load a single PDF
 * - Run parsing → LLM ensemble → fusion
 * - Write JSON output (stdout or --out path)
 */

import "dotenv/config";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first"); // avoids Cloudflare 525/IPv6 hiccups on some routes

import fs from "fs/promises";
import path from "path";
import pLimit from "p-limit";
import { program } from "commander";

import { exists, sha1, writeJSON } from "./utils";
import { MetadataSchema, Provider } from "./types";
import { parseWithGrobid } from "./parsers/grobid";
import { parseWithUnstructured } from "./parsers/unstructured";
import { parseWithPdfParse } from "./parsers/pdf";

import { providerFactory, runLLMEnsemble } from "./llm";
import { fuseCandidates, guessDocumentType } from "./ensemble";

/** Small structured error for user-facing messages. */
class UserError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/** Map various failures from fs/network/LLM SDKs to a friendlier message. */
function toUserError(err: any): UserError {
  const status = err?.status ?? err?.response?.status;
  const apiMsg = err?.error?.message ?? err?.response?.data?.error?.message;
  const apiType = err?.error?.type ?? err?.response?.data?.error?.type;

  // File not found
  if (err?.code === "ENOENT") {
    return new UserError(
      "ENOENT",
      `PDF file not found: ${(err as any).path}`,
      "Check the path you passed to --pdf (or PDF_FILE)."
    );
  }

  // Anthropic/OpenAI style API error surface
  if (typeof status === "number") {
    // transient (network / edge / rate-limits)
    if ([429, 500, 502, 503, 504, 522, 525, 529].includes(status)) {
      return new UserError(
        "TRANSIENT",
        `Provider transient error (${status})${apiType ? ` [${apiType}]` : ""}`,
        "The CLI will automatically retry/failover—re-run with --debug for details."
      );
    }
    // model not found
    if (status === 404) {
      return new UserError(
        "MODEL_NOT_FOUND",
        apiMsg || "Requested model is not available for this account.",
        "Double check --model and your API access; see README for model IDs."
      );
    }
    // auth misconfig
    if (status === 401 || status === 403) {
      return new UserError(
        "AUTH",
        apiMsg || "API key rejected by provider.",
        "Ensure the correct API key is in your environment (.env)."
      );
    }
  }

  // Fallback: unknown / unclassified
  return new UserError(
    "UNKNOWN",
    err?.message || String(err),
    "Re-run with --debug to print stack traces and payload details."
  );
}

/** CLI flags — intentionally minimal to keep the UX simple. */
program
  .requiredOption("--pdf <path>", "Path to a scientific PDF file")
  .option("--provider <name>", "LLM provider: anthropic|openai|ollama", "anthropic")
  .option("--model <name>", "LLM model id (per provider)")
  .option("--grobid-url <url>", "Optional GROBID server base URL, e.g., http://localhost:8070")
  .option("--unstructured-url <url>", "Optional Unstructured server URL")
  .option("--out <path>", "Write JSON output to path. If omitted, prints to stdout")
  .option("--cache-dir <path>", "Directory for cache (hash-based)", ".cache-doc-pipeline")
  .option("--max-concurrency <n>", "Parallelism for LLM calls", "3")
  .option("--debug", "Verbose logs", false)
  .parse(process.argv);

const opts = program.opts();
/** Gate all debug logs behind a flag so default UX is quiet. */
const log = (...args: any[]) => opts.debug && console.error("[debug]", ...args);

(async () => {
  // --- Input validation
  const pdfPath = path.resolve(process.cwd(), opts.pdf);
  if (!(await exists(pdfPath))) {
    throw new UserError("ENOENT", `PDF not found: ${pdfPath}`, "Check the --pdf path.");
  }

  // Limit concurrent provider calls (useful if we fan out prompts in future)
  const limit = pLimit(parseInt(opts.maxConcurrency, 10) || 3);

  // --- Parse stage: prefer strong structure → fallback to robust heuristic
  // We try GROBID, then Unstructured, then a built-in pdf-parse based parser.
  let parsed: any = null;

  try {
    if (opts.grobidUrl) {
      parsed = await parseWithGrobid(pdfPath, opts.grobidUrl);
      log("Parsed via GROBID");
    }
  } catch (e) {
    log("GROBID failed, continuing:", (e as Error).message);
  }

  if (!parsed && opts.unstructuredUrl) {
    try {
      parsed = await parseWithUnstructured(pdfPath, opts.unstructuredUrl);
      log("Parsed via Unstructured");
    } catch (e) {
      log("Unstructured failed, continuing:", (e as Error).message);
    }
  }

  if (!parsed) {
    parsed = await parseWithPdfParse(pdfPath);
    log("Parsed via pdf-parse heuristic");
  }

  // --- Hints for the LLM (soft guidance, not hard constraints)
  // These reduce hallucinations and stabilize outputs when PDFs are messy.
  const hints = {
    authors: parsed.candidates.authors || null,
    document_date: parsed.candidates.document_date || null,
    document_type: guessDocumentType(parsed.sections),
  };

  // --- Provider selection & model
  const prov = (opts.provider as Provider) || "anthropic";
  const provider = providerFactory(prov, opts.model);

  // (Reserved) fs cache key — cheap way to dedupe calls by file+model.
  // If you wire a disk cache later, this key is ready.
  const _cacheKey = `${await sha1(await fs.readFile(pdfPath))}.${prov}.${provider.model}.llm`;

  // --- LLM ensemble with resilient failover
  // The Anthropic/OpenAI provider wrappers already do retries + backoff.
  // Here we catch a provider-level failure and failover to OpenAI if transient.
  let llm: any = null;
  try {
    llm = await runLLMEnsemble(provider as any, parsed.sections, hints, limit);
  } catch (e: any) {
    const status = e?.status ?? 0;
    const transient = [522, 525, 500, 502, 503, 504, 529, 429].includes(status);
    if (transient) {
      console.error("[warn] Provider error", status, "→ switching to OpenAI fallback");
      const fallback = providerFactory("openai", "gpt-4o-mini");
      // fallback at low concurrency to minimize pressure on flaky networks
      const fallbackLimit = pLimit(1);
      llm = await runLLMEnsemble(fallback as any, parsed.sections, hints, fallbackLimit);
    } else {
      throw e;
    }
  }

  // --- Fuse all signals into one consistent struct (and sanitize formats)
  const fused = fuseCandidates(parsed.candidates, parsed, llm, parsed.sections);

  // Validate and coerce to the expected wire format using zod schema.
  const finalMeta = MetadataSchema.parse({
    document_type: fused.document_type.value ?? null,
    authors: fused.authors.value ?? null,
    document_date: fused.document_date.value ?? null,
    summary: fused.summary.value ?? null,
    methods_summary: fused.methods_summary.value ?? null,
    findings_summary: fused.findings_summary.value ?? null,
  });

  const output = {
    ...finalMeta,
    // space left intentionally if you want to add parser/llm provenance in the future
  };

  if (opts.out) {
    await writeJSON(path.resolve(process.cwd(), opts.out), output);
    console.error(`✓ Wrote ${opts.out}`);
  } else {
    process.stdout.write(JSON.stringify(output, null, 2));
  }
})().catch((err) => {
  // Make errors useful for the person running the CLI
  const ue = err instanceof UserError ? err : toUserError(err);
  console.error(`[error] ${ue.code}: ${ue.message}`);
  if (ue.hint) console.error(`[hint] ${ue.hint}`);
  // for CI/debugging, allow stack with --debug
  if (program.opts().debug && err?.stack) console.error(err.stack);
  process.exit(1);
});
