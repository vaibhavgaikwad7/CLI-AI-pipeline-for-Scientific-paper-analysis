import { ensureFetch } from "../utils";
import { ParsedDoc, Sections } from "../types";

export const parseWithUnstructured = async (pdfPath: string, url: string): Promise<ParsedDoc | null> => {
  try {
    const fetchImpl = await ensureFetch();
    const { FormData } = await import("formdata-node");
    const { fileFromPath } = await import("formdata-node/file-from-path");
    const form = new FormData();
    const file = await fileFromPath(pdfPath);
    form.set("files", file);
    form.set("strategy", "hi_res");

    const res = await fetchImpl(url, { method: "POST", body: form as any });
    if (!res.ok) throw new Error(`Unstructured HTTP ${res.status}`);
    const elements = await res.json();

    const getTextByType = (types: string[]) =>
      elements.filter((e: any) => types.includes(e.type)).map((e: any) => e.text).join("\n");

    const sections: Sections = {
      title: elements.find((e: any) => e.type === "Title")?.text,
      abstract: getTextByType(["Abstract"]),
      introduction: getTextByType(["SectionHeader","NarrativeText"]).slice(0,8000),
      methods: getTextByType(["Methods","ListItem"]).slice(0,8000),
      results: getTextByType(["Results","NarrativeText"]).slice(0,8000),
      discussion: getTextByType(["Discussion"]).slice(0,8000),
      conclusion: getTextByType(["Conclusion"]).slice(0,4000),
      body: elements.map((e: any) => e.text).join("\n"),
      headerText: elements.map((e: any) => e.text).join("\n").slice(0,4000)
    };

    const header = sections.body?.slice(0, 2000) || "";
    const authors = extractAuthorsHeuristic(header);
    const date = extractDateHeuristic(header);

    const candidates: Partial<any> = { authors: authors.length ? authors : null, document_date: date };
    return { ok: true, method: "unstructured", sections, candidates };
  } catch (_err) {
    return null;
  }
};

function extractAuthorsHeuristic(headerChunk: string): string[] {
  const lines = headerChunk.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 30);
  const likelyNames: string[] = [];
  const nameRe = /^(?:[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)(?:\s+[A-Z]\.|\s+[A-Z][a-z]+){0,3}$/;
  const stopwords = /university|institute|department|school|college|laboratory|centre|center|press|journal|arxiv|doi/i;
  for (const line of lines) {
    if (stopwords.test(line)) continue;
    for (const part of line.split(/[;,]/)) {
      const p = part.trim();
      if (p.length < 3 || p.length > 60) continue;
      if (nameRe.test(p)) likelyNames.push(p);
    }
  }
  const out: string[] = []; const seen = new Set<string>();
  for (const n of likelyNames) { if (!seen.has(n)) { seen.add(n); out.push(n); } }
  return out.slice(0, 12);
}

function extractDateHeuristic(headerChunk: string): string | null {
  const m = headerChunk.match(/(?:\b|\()((?:19|20)\d{2})(?:[-\/.](\d{1,2}))?(?:[-\/.](\d{1,2}))?/);
  if (!m) return null;
  const y = m[1]; const mo = m[2] ? m[2].padStart(2,"0") : "01"; const d = m[3] ? m[3].padStart(2,"0") : "01";
  return `${y}-${mo}-${d}`;
}
