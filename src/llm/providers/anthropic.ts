// src/llm/providers/anthropic.ts
import type { Anthropic as AnthropicType } from "@anthropic-ai/sdk";
import { safeParseJSON } from "../shared";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function isRetryable(err: any): boolean {
  const status = err?.status ?? err?.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  // Anthropic/edge/CDN specials we’ve seen in the wild
  if ([522, 525, 529].includes(status)) return true;
  // Network/Node-level transient errors
  const code = String(err?.code || "").toUpperCase();
  if (/(ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH)/.test(code)) return true;
  // Some SDKs surface a boolean header
  if (String(err?.headers?.["x-should-retry"]).toLowerCase() === "true") return true;
  return false;
}

function withBackoffDelay(attempt: number): number {
  // ~700ms, 1400ms, 2800ms (+ random jitter). Cap around 5s.
  const base = 700 * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 300);
  return Math.min(base + jitter, 5000);
}

function cleanJSONText(text: string): string {
  // remove simple ```json ... ``` fences and trim
  return text.replace(/^\s*```json\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

export class AnthropicProvider {
  name = "anthropic" as const;
  model: string;
  client: AnthropicType;

  constructor(model?: string) {
    const { Anthropic } = require("@anthropic-ai/sdk");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Fast, clear failure if the key isn’t present
      throw Object.assign(new Error("ANTHROPIC_API_KEY is not set"), { code: "CONFIG" });
    }
    this.client = new Anthropic({ apiKey });
    this.model = model || "claude-sonnet-4-5-20250929";
  }

  async callJSON(prompt: string, sys?: string): Promise<any> {
    const maxRetries = 3;

    for (let i = 0; i <= maxRetries; i++) {
      try {
        const msg = await this.client.messages.create({
          model: this.model,
          system: sys,
          max_tokens: 1200,
          temperature: 0.2,
          messages: [{ role: "user", content: prompt }],
          // You can add a client-side timeout if desired:
          // timeout: 60_000,
        });

        // Join all text blocks (Anthropic returns an array of blocks)
        const textBlocks = Array.isArray((msg as any).content)
          ? (msg as any).content
              .filter((b: any) => b?.type === "text" && typeof b.text === "string")
              .map((b: any) => b.text)
          : [];

        const rawText = textBlocks.length > 0 ? textBlocks.join("\n") : "{}";
        const cleaned = cleanJSONText(rawText);

        // Let your existing helper do the heavy lifting
        return safeParseJSON(cleaned);
      } catch (err: any) {
        const retryable = isRetryable(err);
        if (i < maxRetries && retryable) {
          await sleep(withBackoffDelay(i));
          continue;
        }
        // Let the CLI map this to a friendly message / fallback
        throw err;
      }
    }

    // Should be unreachable, but keeps TypeScript happy
    throw new Error("AnthropicProvider.callJSON: exhausted retries");
  }
}
