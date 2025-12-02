// src/resolvers/crossref.ts
export interface CrossrefMeta {
  authors: string[] | null;
  date: string | null; // YYYY or YYYY-MM or YYYY-MM-DD
  title?: string | null;
}

const DOI_RE = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i;

function pickDate(obj?: any): string | null {
  // Crossref date precedence: published-print > published-online > issued > created
  const cands = [obj?.["published-print"], obj?.["published-online"], obj?.issued, obj?.created];
  for (const d of cands) {
    const parts: number[] | undefined = d?.["date-parts"]?.[0];
    if (!parts || !parts.length) continue;
    const [y, m, day] = parts;
    if (!y) continue;
    if (m && day) return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (m) return `${y}-${String(m).padStart(2, "0")}`;
    return `${y}`;
  }
  return null;
}

export function extractDOI(text: string): string | null {
  const m = text.match(DOI_RE);
  return m ? m[0] : null;
}

export async function fetchCrossref(doi: string, timeoutMs = 6000): Promise<CrossrefMeta | null> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "doc-pipeline/1.0 (mailto:you@example.com)" }
    });
    if (!res.ok) return null;
    const js = await res.json();
    const m = js?.message;
    if (!m) return null;

    const authors: string[] | null = Array.isArray(m.author)
      ? m.author
          .map((a: any) => [a.given, a.family].filter(Boolean).join(" ").trim())
          .filter((s: string) => s.length > 1)
      : null;

    const date = pickDate(m);

    // NEW: include normalized title so pdf.ts can trust authority metadata
    const title =
      Array.isArray(m?.title) ? m.title.join(" ").trim()
      : typeof m?.title === "string" ? m.title.trim()
      : null;

    return { authors: authors && authors.length ? authors : null, date: date || null, title };
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}
