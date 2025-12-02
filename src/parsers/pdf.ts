// @ts-ignore CJS default
import pdfParse from "pdf-parse";
import fs from "fs/promises";
import { normalizeText, parsePdfCreationDate } from "../utils";
import { ParsedDoc, Sections } from "../types";
import { extractDOI, fetchCrossref } from "../resolvers/crossref";

/**
 * Parse a PDF with robust author & date extraction:
 * 1) Prefer authority metadata (Crossref via DOI; header-only DOI to avoid References)
 * 2) Otherwise: ranked in-PDF date detection + heuristic authors (author-zone only)
 * 3) Fallback: PDF creation date (from metadata)
 */
export const parseWithPdfParse = async (pdfPath: string): Promise<ParsedDoc> => {
  const data = await pdfParse(await fs.readFile(pdfPath));
  const raw = normalizeText(data.text || "");

  // Larger header window improves odds to find title/author block
  const sections: Sections = {
    body: raw,
    headerText: raw.slice(0, 12000),
  };
  const headerText = sections.headerText ?? "";

  // ---------- Try authority metadata (Crossref) ----------
  let authorityAuthors: string[] | null = null;
  let authorityDate: string | null = null;

  try {
    // IMPORTANT: scan DOI only in the header (avoid picking it from References)
    const doi = extractDOI(headerText);
    if (doi) {
      const cr = await fetchCrossref(doi).catch(() => null);
      if (cr) {
        // Normalize Crossref title to a single string (string | string[] | undefined)
        const crTitleRaw: unknown = (cr as any).title;
        const crTitle =
          Array.isArray(crTitleRaw) ? crTitleRaw.join(" ")
          : typeof crTitleRaw === "string" ? crTitleRaw
          : "";

        // Only trust Crossref if the title reasonably matches the header text
        if (!crTitle || looksLikeSameWork(crTitle, headerText)) {
          authorityAuthors = (cr as any).authors ?? null;
          authorityDate = (cr as any).date ?? null;
        }
      }
    }
  } catch {
    /* non-fatal; continue with heuristics */
  }

  // ---------- Lightweight section grabs (optional; keeps previous behavior) ----------
  const grab = (names: RegExp) => {
    const re = new RegExp(`\\n\\s*(?:\\d[.\\d\\s]*)?(?:${names.source})\\s*\\n`, "i");
    const idx = raw.search(re);
    if (idx === -1) return "";
    const after = raw.slice(idx + 1000);
    return after.slice(0, 8000);
  };

  sections.abstract = /\babstract\b/i.test(raw) ? grab(/abstract/) : undefined;
  sections.methods = grab(/methods?|methodology|materials and methods|experimental|approach|study design|procedure|procedures?/);
  sections.results = grab(/results?|findings?|evaluation|experiments?/);
  sections.discussion = grab(/discussion/);
  sections.conclusion = grab(/conclusions?|conclusion/);

  // ---------- Authors (prefer authority; else use author-zone heuristic) ----------
  const authorZone = sliceAuthorZone(headerText);
  const authorsHeu = extractAuthorsHeuristic(authorZone);
  const bestAuthors = authorityAuthors && authorityAuthors.length ? authorityAuthors : authorsHeu;

  // ---------- Date (ranked in-PDF incl. top of full, fallback to PDF creation) ----------
  const bestDate =
    authorityDate ||
    findRankedDate(headerText, raw) ||
    parsePdfCreationDate((data as any).info?.CreationDate) ||
    null;

  // Flag when we saw an explicit day-precision date in the header block (helps ensemble keep the day)
  const headerDayFlag = bestDate ? (isDayISO(bestDate) && headerHasExplicitDay(headerText)) : false;
  const meta: Record<string, any> = {};
  if (headerDayFlag) meta.dateFromHeader = true;

  const candidates: any = {
    authors: bestAuthors && bestAuthors.length ? bestAuthors : null,
    document_date: bestDate,
  };

  return {
    ok: true,
    method: authorityAuthors || authorityDate ? "authority" : "heuristic",
    sections,
    candidates,
    meta,
  };
};

/* =========================
   Author zone selection
   ========================= */

/**
 * Return only the likely author block:
 *  - Find a plausible title line near the top (longest among first ~20 lines)
 *  - Return next 1–12 lines until a section cue (Abstract/Keywords/Article info/References/etc.)
 *  - This prevents early reference/citation lines from leaking in
 */
function sliceAuthorZone(header: string): string {
  const lines = (header || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const stopCues = [
    /^abstract\b/i,
    /^summary\b/i,
    /^keywords?\b/i,
    /^jel\b/i,
    /^article (?:info|information|history)\b/i,
    /^references\b/i,
    /^bibliography\b/i,
    /^introduction\b/i,
  ];

  // 👇 keep your existing blockers
  const ignoreAsTitle = [
    /electronic copy available at/i,
    /this (?:paper|version) (?:was )?posted/i,
    /ssrn/i,
    /^open access$/i,
  ];

  // 👇 affiliation/address/email-ish cues that should NOT be a title
  const AFFIL_CUES = [
    /\b(section|department|dept|school|college|faculty|division|unit|institute|center|centre|laboratory|lab|hospital|nhs)\b/i,
    /\buniversity\b/i,
    /\bimperial\b|\blondon\b|\buk\b/i,
    /\bcampus\b|\broad\b|\bst\.?\b|\bstreet\b|\broad\b/i,
    /\bchelsea\b|\bsw\d{1,2}\b/i,
    /\bcorresponding author\b/i,
    /@|email|telephone|tel\.?/i,
    /\d{2,}[- ,]\d{2,}/,              // phone-like
  ];
  const looksLikeAffil = (s: string) => AFFIL_CUES.some(re => re.test(s));

  // Heuristic: a good title is long, has mostly letters/spaces, no digits,
  // few commas, no affiliation cues.
  const isGoodTitle = (s: string) => {
    if (ignoreAsTitle.some(re => re.test(s))) return false;
    if (looksLikeAffil(s)) return false;
    if (/\d/.test(s)) return false;          // titles rarely have digits on SSRN PDFs
    const commaCount = (s.match(/,/g) || []).length;
    if (commaCount >= 3) return false;       // affiliation lists often have many commas
    const letters = (s.match(/[A-Za-z]/g) || []).length;
    const ratio = letters / Math.max(1, s.length);
    return s.length >= 20 && ratio >= 0.6;
  };

  // ----- Find a plausible title among the first ~20 lines
  let titleIdx = -1;
  let bestLen = 0;
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const L = lines[i];
    if (!isGoodTitle(L)) continue;
    const len = L.length;
    if (len > bestLen) {
      bestLen = len;
      titleIdx = i;
    }
  }

  if (process.env.DEBUG) {
    console.error("[debug] sliceAuthorZone titleIdx:", titleIdx, "bestLen:", bestLen);
    console.error("[debug] chosen title line:", titleIdx >= 0 ? lines[titleIdx] : "(none)");
  }

  // If no title, scan from line 0; else start after title
  let start = titleIdx >= 0 ? titleIdx + 1 : 0;

  // ✅ Minimal addition: skip up to 3 *title-continuation* lines (prevents
  // fragments like "Necrotizing Enterocolitis" from entering the author zone)
  if (titleIdx >= 0) {
    const looksLikeTitleContinuation = (s: string) => {
      if (!s) return false;
      if (/^\s*by\b/i.test(s)) return false;                // "by John Doe"
      if (stopCues.some(re => re.test(s))) return false;    // section starts
      if (looksLikeAffil(s)) return false;                  // affiliations
      if (/[0-9@]/.test(s)) return false;                   // digits/emails
      if (/[,:;|]/.test(s)) return false;                   // author-ish punctuation
      const words = s.split(/\s+/);
      if (words.length < 2 || words.length > 15) return false;
      const letters = (s.match(/[A-Za-z]/g) || []).length;
      const ratio = letters / Math.max(1, s.length);
      return ratio >= 0.6;                                   // mostly letters
    };

    let i = start, skipped = 0;
    while (i < lines.length && skipped < 3 && looksLikeTitleContinuation(lines[i])) {
      i++; skipped++;
    }
    start = i;
  }

  // Find earliest stop cue after start
  let end = Math.min(lines.length, start + 12);
  for (let i = start; i < Math.min(lines.length, start + 40); i++) {
    if (stopCues.some(re => re.test(lines[i]))) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join("\n");
}


/* =========================
   Date helpers (ranked & context-aware)
   ========================= */

const MONTH =
  "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

function monthToMM(m: string) {
  const map: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04", may: "05",
    june: "06", july: "07", august: "08", september: "09", sept: "09",
    october: "10", november: "11", december: "12",
  };
  return map[m.toLowerCase()];
}

function isValidYMD(y: number, m: number, d: number) {
  if (m < 1 || m > 12) return false;
  const dim = new Date(y, m, 0).getDate(); // days in month
  return d >= 1 && d <= dim;
}

function toISO(y: string, m?: string, d?: string) {
  const Y = parseInt(y, 10);
  const nextYear = new Date().getFullYear() + 1;
  if (!Number.isFinite(Y) || Y < 1900 || Y > nextYear) return null;

  if (!m) return `${Y}`;
  const mm = monthToMM(m);
  if (!mm) return `${Y}`;
  if (!d) return `${Y}-${mm}`;
  const dd = String(parseInt(d, 10)).padStart(2, "0");
  if (!isValidYMD(Y, parseInt(mm, 10), parseInt(dd, 10))) return null;
  return `${Y}-${mm}-${dd}`;
}

function isDayISO(iso: string | null | undefined): boolean {
  return !!iso && /^\d{4}-\d{2}-\d{2}$/.test(iso);
}

/** Numeric forms with safe disambiguation. */
function parseNumericDate(s: string): string | null {
  // ISO first: YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  let m = s.match(/\b(20\d{2}|19\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/);
  if (m) {
    const [Y, M, D] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
    if (isValidYMD(Y, M, D)) return `${Y}-${String(M).padStart(2,"0")}-${String(D).padStart(2,"0")}`;
  }

  // DMY or MDY with slash/dot/hyphen
  m = s.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](20\d{2}|19\d{2})\b/);
  if (m) {
    const [a, b, Y] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
    // Prefer DMY if 'a' > 12; else prefer MDY if 'b' > 12; else ambiguous → month only
    if (a > 12 && isValidYMD(Y, b, a)) return `${Y}-${String(b).padStart(2,"0")}-${String(a).padStart(2,"0")}`;
    if (b > 12 && isValidYMD(Y, a, b)) return `${Y}-${String(a).padStart(2,"0")}-${String(b).padStart(2,"0")}`;
    if (a >= 1 && a <= 12) return `${Y}-${String(a).padStart(2,"0")}`; // ambiguous: year-month only
  }

  // Year-Month
  m = s.match(/\b(20\d{2}|19\d{2})[-\/.](\d{1,2})\b/);
  if (m) {
    const [Y, M] = [parseInt(m[1]), parseInt(m[2])];
    if (M >= 1 && M <= 12) return `${Y}-${String(M).padStart(2,"0")}`;
  }

  // Year only
  m = s.match(/\b(20\d{2}|19\d{2})\b/);
  return m ? m[1] : null;
}

function looksLikeRef(s: string) {
  return /\bdoi:|vol\.|issue|pages|pp\.|no\.\b/i.test(s)
      || /^\[\d+\]/.test(s)
      || /^[A-Z][a-z]+,\s*[A-Z]\./.test(s)
      || /\(\d{4}\)/.test(s)
      || /\d{4};\d/.test(s)
      || /\bkeywords?|abstract|references|bibliography\b/i.test(s);
}

/** True if the header contains an explicit day-precision date near the top (MDY, DMY, or ISO),
 *  while avoiding reference-like lines. Used to set meta.dateFromHeader.
 */
function headerHasExplicitDay(header: string): boolean {
  const lines = (header || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 120); // look only near the top

  const reMDY = new RegExp(`\\b(${MONTH})\\s+(\\d{1,2}),\\s*(\\d{4})\\b`, "i");       // Month DD, YYYY
  const reDMY = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH})\\s*,?\\s*(\\d{4})\\b`, "i");  // DD Month YYYY
  const reISO = /\b(20\d{2}|19\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/;               // YYYY-MM-DD

  for (const line of lines) {
    if (looksLikeRef(line)) continue;
    if (reMDY.test(line) || reDMY.test(line)) return true;
    const iso = line.match(reISO);
    if (iso) {
      const y = parseInt(iso[1], 10), m = parseInt(iso[2], 10), d = parseInt(iso[3], 10);
      if (isValidYMD(y, m, d)) return true;
    }
  }
  return false;
}

/**
 * Rank dates found near the top of the PDF AND in the very top of the full text:
 * Order:
 *  - "This version posted"/"Posted" (SSRN)
 *  - "Published online"/"Published"
 *  - "Available online"
 *  - "Accepted"
 *  - "Received"
 *  - Bare Month YYYY / Month DD, YYYY
 *  - Bare YYYY (penalized and near top only)
 * Supports MDY + DMY + numeric forms. Never fabricates a missing day.
 */
function findRankedDate(header: string, full: string): string | null {
  const H = (header || "").slice(0, 12000);
  const T = (full || "").slice(0, 20000);

  // tolerant patterns (punctuation/ordinals optional)
  const reMDY = new RegExp(
    `\\b(${MONTH})\\.?[\\s,.:/\\-–—]*(\\d{1,2})(?:st|nd|rd|th)?[\\s,.:/\\-–—]*(\\d{4})\\b`,
    "i"
  );
  const reDMY = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s,.:/\\-–—]*(${MONTH})\\.?[\\s,.:/\\-–—]*(\\d{4})\\b`,
    "i"
  );
  const reMY = new RegExp(
    `\\b(${MONTH})\\.?[\\s,.:/\\-–—]*(\\d{4})\\b`,
    "i"
  );

  // 1) CUE-WINDOW SCAN (most robust): find cue, then look ahead ~180 chars for a date
  const cueRe = /\b(this\s+version\s+posted|posted|published\s+online|published|available\s+online|accepted|received)\b/i;
  const scanZones = [H, T];
  for (const zone of scanZones) {
    let searchFrom = 0;
    while (true) {
      const m = cueRe.exec(zone.slice(searchFrom));
      if (!m) break;
      const cueIdx = searchFrom + m.index;
      const window = zone.slice(cueIdx, cueIdx + 180); // small lookahead after cue

      const mdy = window.match(reMDY);
      if (mdy) return toISO(mdy[3], mdy[1], mdy[2])!;

      const dmy = window.match(reDMY);
      if (dmy) return toISO(dmy[3], dmy[2], dmy[1])!;

      const my = window.match(reMY);
      if (my) return toISO(my[2], my[1])!;

      const num = parseNumericDate(window);
      if (num) return num;

      searchFrom = cueIdx + 1; // keep searching for next cue
    }
  }

  // 2) FALLBACK: line-based pass (same as before, but cue-first, then reference guard)
  const toLines = (s: string) => s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const lines = [...toLines(H), ...toLines(T).slice(0, 80)];

  type Cand = { iso: string; score: number; ix: number };
  const cands: Cand[] = [];
  const add = (iso: string | null, score: number, ix: number) => { if (iso) cands.push({ iso, score, ix }); };

  lines.forEach((line, i) => {
    // cue-first
    const cue = line.match(cueRe);
    if (cue) {
      const mdy = line.match(reMDY);
      if (mdy) { add(toISO(mdy[3], mdy[1], mdy[2]), 1.0, i); return; }
      const dmy = line.match(reDMY);
      if (dmy) { add(toISO(dmy[3], dmy[2], dmy[1]), 0.95, i); return; }
      const my = line.match(reMY);
      if (my) { add(toISO(my[2], my[1]), 0.85, i); return; }
      const num = parseNumericDate(line);
      if (num) { add(num, 0.8, i); return; }
    }

    // reference-like guard only for non-cue plain patterns
    if (looksLikeRef(line)) return;

    const mdy2 = line.match(reMDY);
    if (mdy2) { add(toISO(mdy2[3], mdy2[1], mdy2[2]), 0.75, i); return; }

    const dmy2 = line.match(reDMY);
    if (dmy2) { add(toISO(dmy2[3], dmy2[2], dmy2[1]), 0.72, i); return; }

    const my2 = line.match(reMY);
    if (my2) { add(toISO(my2[2], my2[1]), 0.65, i); return; }

    const num2 = parseNumericDate(line);
    if (num2) { add(num2, 0.55, i); return; }
  });

  if (!cands.length) return null;

  cands.forEach(c => { c.score += Math.max(0, 0.15 - (c.ix * 0.002)); });
  cands.sort((a, b) => b.score - a.score || a.ix - b.ix);
  return cands[0].iso || null;
}

/* =========================
   Author heuristic (publisher-aware, citation-guarded)
   ========================= */

/**
 * Robust author extraction from a narrowed "author zone":
 *  - Skips labels and affiliation/org lines
 *  - Guards against citation-looking lines
 *  - Joins split names across adjacent single-token lines
 *  - Accepts initials and hyphenated surnames
 */
function extractAuthorsHeuristic(headerChunk: string): string[] {
  // Restrict the search zone to *before* Abstract/Keywords/Introduction
  const cut = headerChunk.search(/\b(abstract|summary|keywords?|introduction)\b/i);
  const zone = (cut > 0 ? headerChunk.slice(0, cut) : headerChunk).slice(0, 4000);

  const lines = zone
    .split("\n")
    .map(s => s.replace(/^\s*by\s+/i, "").trim())
    .filter(Boolean)
    .slice(0, 60);

  // Drop obvious non-author lines
  const isDocLabel = (s: string) => {
    const x = s.toLowerCase().replace(/\s+/g, " ");
    return [
      "original article","research article","review article","systematic review",
      "meta-analysis","meta analysis","brief report","short report","short communication",
      "case report","editorial","commentary","perspective","viewpoint","protocol",
      "special article","open access","letter to the editor","technical note",
      "methods article","article info","article information","article history"
    ].some(p => x === p || x.includes(p));
  };

  const stopLine =
    /\b(abstract|summary|keywords?|correspondence|author\s+information|affiliations?|how to cite|copyright|journal|received|accepted|published|department|dept|university|institute|school|college|hospital|centre|center|laboratory|division|ministry|agency|authority|office|board|bureau)\b/i;

  const parts: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // --- NEW: clean degrees & superscripts before parsing names ---
    // Remove superscript digits (¹²³⁰–⁹) and plain/caret digits used as footnotes
    line = line
      .replace(/[\u00B9\u00B2\u00B3\u2070-\u2079]/g, "")
      .replace(/\^?\d+/g, "");

    // Strip common degree/credential tokens that break name parsing
    line = line.replace(
      /\b(PhD|DPhil|MSc|MS|BSc|BS|MD|DO|MPH|MBA|RN|RM|FMedSci|FRCP|FRCS|FRCPath|FRCA|FRCPC|DDS|DMD|Ph\.?D\.?)\b\.?/gi,
      ""
    );
    // -------------------------------------------------------------

    // Ignore reference-looking lines (fix for SSRN-type leaks)
    if (/^\[\d+\]\s*/.test(line) || /doi:/i.test(line)) continue;
    if (stopLine.test(line) || isDocLabel(line)) continue;

    // Join split names across line breaks (e.g., "Cheryl" + "Battersby")
    if (/^[A-Z][a-z]+$/.test(line) && i + 1 < lines.length && /^[A-Z][a-z]+$/.test(lines[i + 1])) {
      line = `${line} ${lines[i + 1]}`;
      i++;
    }

    // Cleanup
    line = line.replace(/[†*]/g, "").replace(/\d+$/g, "").trim();
    line = line.replace(/\|/g, ",");

    // Split by typical publisher separators
    const segs = line
      .split(/\s*,\s*|\s*;\s*|\/|(?:\s+and\s+)/i)
      .map(s => s.trim())
      .filter(Boolean);

    parts.push(...segs);
  }

  const normalizeCaps = (s: string) =>
    s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : s;

  // Person-like tokens: Abc / Abc-Def / A. / A
  const nameToken =   /^(?:[A-Z][a-zA-Z'\u2019’-]+|[A-Z]\.|[A-Z][a-zA-Z'\u2019’-]+-[A-Z][a-zA-Z'\u2019’-]+)$/;




  const candidates = parts
    .map(normalizeCaps)
    .map(s => s.replace(/\s{2,}/g, " "))
    .filter(s => !isDocLabel(s) && !stopLine.test(s))
    .filter(s => {
      const toks = s.split(/\s+/);
      if (toks.length < 2 || toks.length > 5) return false;
      return toks.every(t => nameToken.test(t));
    });

  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of candidates) if (!seen.has(n)) { seen.add(n); out.push(n); }

  // Fallback: if nothing found in the header zone, try to parse “CRediT author statement”
  if (!out.length) {
    const m = headerChunk.match(/credit author statement\s*:\s*([\s\S]{0,800})/i);
    if (m) {
      const creditBlock = m[1].split(/\n/)[0]; // usually names before the first newline
      const creditNames = creditBlock
        .split(/[.;]/)
        .map(s => s.trim().replace(/:.*$/, ""))
        .filter(Boolean)
        .filter(s => s.split(/\s+/).length >= 2);
      for (const n of creditNames) if (!seen.has(n)) { seen.add(n); out.push(n); }
    }
  }

  return out.slice(0, 24);
}

/* =========================
   Crossref title sanity check
   ========================= */

/**
 * Very lightweight fuzzy match between Crossref title and header text.
 * Returns true if ≥65% of title tokens appear (order-insensitive) within the header.
 */
function looksLikeSameWork(crTitle: string, headerText: string): boolean {
  const t = (crTitle || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const h = (headerText || "").toLowerCase();
  if (!t) return false;

  const toks = t.split(" ").filter(w => w.length >= 3);
  if (!toks.length) return false;

  let hit = 0;
  for (const w of toks) {
    if (h.includes(w)) hit++;
  }
  return hit / toks.length >= 0.65;
}
