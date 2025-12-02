import { z } from "zod";

export const ConfigSchema = z.object({
  PROVIDER: z.enum(["anthropic", "openai", "ollama"]).default("anthropic"),
  MODEL: z.string().min(1, "MODEL is required"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv) {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const c = parsed.data;
  if (c.PROVIDER === "anthropic" && !c.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required when PROVIDER=anthropic");
  }
  if (c.PROVIDER === "openai" && !c.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when PROVIDER=openai");
  }
  return c;
}
