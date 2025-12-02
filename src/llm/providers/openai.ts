import type { OpenAI as OpenAIType } from "openai";
import { safeParseJSON } from "../shared";

export class OpenAIProvider {
  name = "openai" as const;
  model: string;
  client: OpenAIType;
  constructor(model?: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OpenAI = require("openai").OpenAI as typeof OpenAIType;
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.model = model || "gpt-4o-mini";
  }
  async callJSON(prompt: string, sys?: string): Promise<any> {
    const res = await this.client.chat.completions.create({
      model: this.model, temperature: 0.2, response_format: { type: "json_object" },
      messages: [sys ? { role: "system", content: sys } : undefined, { role: "user", content: prompt }].filter(Boolean) as any
    });
    const text = res.choices?.[0]?.message?.content || "{}";
    return safeParseJSON(text);
  }
}
