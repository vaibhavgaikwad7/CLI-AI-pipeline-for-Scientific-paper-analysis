import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

export const exists = async (p: string) => !!(await fs.stat(p).catch(() => null));
export const ensureDir = async (p: string) => { await fs.mkdir(p, { recursive: true }); };
export const writeJSON = async (p: string, obj: any) => { await ensureDir(path.dirname(p)); await fs.writeFile(p, JSON.stringify(obj, null, 2), "utf8"); };
export const sha1 = (buf: Buffer | string) => crypto.createHash("sha1").update(buf).digest("hex");

export const truncateForLLM = (text: string, maxChars: number) => text.length <= maxChars ? text : text.slice(0, maxChars);

export const normalizeText = (txt: string) =>
  txt.replace(/[\r\t]+/g, " ").replace(/\u00A0/g, " ").replace(/\s+-\s*\n/g, "").replace(/-\n/g, "").replace(/\n{2,}/g, "\n").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

export const toISODate = (s?: string | null): string | null => {
  if (!s) return null;
  const m1 = s.match(/(20\d{2}|19\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m1) { const y=m1[1].padStart(4,"0"); const mo=m1[2].padStart(2,"0"); const d=m1[3].padStart(2,"0"); return `${y}-${mo}-${d}`; }
  const m2 = s.match(/(20\d{2}|19\d{2})/); return m2 ? `${m2[1]}-01-01` : null;
};

export const parsePdfCreationDate = (d?: string): string | null => {
  if (!d) return null; const m = d.match(/D:(\d{4})(\d{2})(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

export const ensureFetch = async () => {
  if (typeof fetch !== "undefined") return fetch;
  const mod = await import("node-fetch");
  return (mod.default || mod) as unknown as typeof fetch;
};
