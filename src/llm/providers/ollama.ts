import { safeParseJSON } from "../shared";

export class OllamaProvider {
  name = "ollama" as const;
  model: string;
  client: any;
  constructor(model?: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    this.client = require("ollama");
    this.model = model || "llama3.1:8b";
  }
  async callJSON(prompt: string, sys?: string): Promise<any> {
    const res = await this.client.chat({
      model: this.model,
      messages: [sys ? { role: "system", content: sys } : undefined, { role: "user", content: prompt }].filter(Boolean),
      options: { temperature: 0.2 }
    });
    const text = res.message?.content || "{}";
    return safeParseJSON(text);
  }
}
