// src/errors.ts
export class UserError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

function isNodeFsErr(e: any, code: string) {
  return e && typeof e === "object" && (e as any).code === code;
}

export function toUserError(err: any): UserError {
  // Anthropic/OpenAI style
  const status = err?.status ?? err?.response?.status;
  const reqId = err?.request_id ?? err?.response?.data?.request_id;
  const apiType = err?.error?.type ?? err?.response?.data?.error?.type;

  // File not found
  if (isNodeFsErr(err, "ENOENT")) {
    return new UserError(
      "ENOENT",
      `PDF file not found: ${(err as any).path}`,
      "Check the path you passed to --pdf (or PDF_FILE)."
    );
  }

  // API key missing/invalid
  if (status === 401) {
    return new UserError(
      "AUTH",
      "The API rejected your request (401).",
      "Verify ANTHROPIC_API_KEY / OPENAI_API_KEY is set and correct."
    );
  }

  // Wrong model
  if (status === 404 || apiType === "not_found_error") {
    return new UserError(
      "MODEL_NOT_FOUND",
      `Model not found: ${(err?.error?.message ?? "unknown model")}`,
      "Try MODEL=claude-sonnet-4-5-20250929 or another available model."
    );
  }

  // Rate limits/transient
  if (status === 429 || (status && status >= 500)) {
    return new UserError(
      "RETRYABLE",
      `The model API is busy (status ${status}).`,
      "Re-running usually fixes it. You can also lower concurrency."
    );
  }

  // Network timeouts / resets
  if (/ETIMEDOUT|ECONNRESET|ENETUNREACH|EAI_AGAIN/i.test(String(err?.code))) {
    return new UserError(
      "NETWORK",
      "Network issue talking to the model API.",
      "Check your connection and retry."
    );
  }

  // Default generic
  const msg = (err?.message ?? String(err)).slice(0, 400);
  const hint = reqId ? `Request ID: ${reqId}` : undefined;
  return new UserError("UNKNOWN", msg, hint);
}

export function printUserError(e: UserError) {
  console.error(`✖ ${e.message}`);
  if (e.hint) console.error(`Hint: ${e.hint}`);
}
