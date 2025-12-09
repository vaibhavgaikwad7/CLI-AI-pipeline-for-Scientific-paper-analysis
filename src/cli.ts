/**
 * CLI entrypoint for the Document AI pipeline.
 *
 * Responsibilities:
 * - Parse CLI flags
 * - Load a single PDF
 * - Call runPipeline() to execute the actual pipeline logic
 * - Write JSON output (stdout or --out path)
 */

import "dotenv/config";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first"); // avoids Cloudflare/IPv6 hiccups

import path from "path";
import fs from "fs/promises";
import { program } from "commander";
import { writeJSON } from "./utils";

import { runPipeline } from "./runPipeline";

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

/** Map internal errors to user-friendly errors */
function toUserError(err: any): UserError {
  const status = err?.status ?? err?.response?.status;
  const apiMsg = err?.error?.message ?? err?.response?.data?.error?.message;
  const apiType = err?.error?.type ?? err?.response?.data?.error?.type;

  // File not found
  if (err?.code === "ENOENT") {
    return new UserError(
      "ENOENT",
      `PDF file not found: ${(err as any).path}`,
      "Check the path you passed to --pdf"
    );
  }

  // API HTTP errors (Anthropic/OpenAI)
  if (typeof status === "number") {
    if ([429, 500, 502, 503, 504, 522, 525, 529].includes(status)) {
      return new UserError(
        "TRANSIENT",
        `Provider transient error (${status})${apiType ? ` [${apiType}]` : ""}`,
        "Retry later or re-run with --debug for details."
      );
    }
    if (status === 404) {
      return new UserError(
        "MODEL_NOT_FOUND",
        apiMsg || "Requested model is not available for this account.",
        "Check --model or your provider access."
      );
    }
    if (status === 401 || status === 403) {
      return new UserError(
        "AUTH",
        apiMsg || "API key rejected by provider.",
        "Check your API key (.env)."
      );
    }
  }

  return new UserError(
    "UNKNOWN",
    err?.message || String(err),
    "Run with --debug to print stack traces."
  );
}

/** CLI flags */
program
  .requiredOption("--pdf <path>", "Path to a scientific PDF file")
  .option("--provider <name>", "LLM provider: anthropic|openai|ollama|noai", "anthropic")
  .option("--model <name>", "LLM model id")
  .option("--grobid-url <url>", "Optional GROBID server URL")
  .option("--unstructured-url <url>", "Optional Unstructured server URL")
  .option("--out <path>", "Write JSON output to file; otherwise prints to stdout")
  .option("--debug", "Verbose logs", false)
  .parse(process.argv);

const opts = program.opts();

/** Debug logger */
const log = (...args: any[]) => opts.debug && console.error("[debug]", ...args);

/**
 * MAIN EXECUTION
 * ---------------------------------------------------------------
 * This block ONLY runs when executed via CLI.
 * It does NOT run when imported (e.g., from Express server),
 * which is exactly what we want.
 */
(async () => {
  try {
    // Prepare final arguments for runPipeline()
    const args = {
      pdf: opts.pdf,
      provider: opts.provider,
      model: opts.model,
      grobidUrl: opts.grobidUrl,
      unstructuredUrl: opts.unstructuredUrl,
      debug: opts.debug
    };

    log("Starting pipeline with args:", args);

    // Run core pipeline
    const result = await runPipeline(args);

    // Output: file or stdout
    if (opts.out) {
      await writeJSON(path.resolve(process.cwd(), opts.out), result);
      console.error(`✓ Wrote ${opts.out}`);
    } else {
      process.stdout.write(JSON.stringify(result, null, 2));
    }

  } catch (err: any) {
    const ue = err instanceof UserError ? err : toUserError(err);
    console.error(`[error] ${ue.code}: ${ue.message}`);
    if (ue.hint) console.error(`[hint] ${ue.hint}`);
    if (opts.debug && err.stack) console.error(err.stack);
    process.exit(1);
  }
})();
