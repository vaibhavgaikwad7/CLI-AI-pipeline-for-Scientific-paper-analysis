# Challenge 2: Document AI Pipeline 

## Overview
This pipeline is designed to process scientific PDFs and extract structured information in a **simple, reproducible, and AI-assisted** way.  

It’s built to be:
- **Simple to run** (one command),
- **Deterministic** where possible (authors/date via heuristics),
- **LLM-assisted** where it helps (summaries),
- **Reproducible** (Docker included).

## Extracted Fields
The pipeline extracts the following:
- `document_type`
- `authors`
- `document_date`
- `summary`
- `methods_summary`
- `findings_summary/conclusions`

---

## How It Works

### 1. PDF Text Extraction
- Uses **pdf-parse** to extract raw text.  
- Normalizes whitespace and builds simple “sections.”

### 2. Header Heuristics (Authors + Date)
- Finds a plausible title line.  
- Takes an author zone just below the title (skipping affiliations/emails).  
- Extracts authors with rules that reject affiliations or degrees.  
- Extracts dates using ranked patterns (e.g., *Published, Posted, Accepted, Received*).  
- Keeps YYYY-MM format for ambiguous dates (e.g., “May 2023”).

### 3. Authority Hints
- If a DOI is found, queries Crossref.  
- Only trusts Crossref if the title matches to avoid pulling references by mistake.

### 4. LLM Ensemble (2 Prompts)
- Two complementary prompts analyze the text and return structured JSON.  
- Providers supported:
  - **Ollama** (offline),,
  - **Anthropic** (Claude 4/5),
  - **No-AI** (heuristics only).  
- The ensemble merges outputs (e.g., longest reasonable summary, union of author lists).

### 5. Fusion & Sanitize
- Heuristic + LLM results are fused with scoring.  
- Dates are sanitized into ISO format, keeping full day precision only when present in the header.

---

## Quickstart (PowerShell)

1. Install dependencies:
   ```powershell
   npm install
   ```
2. Set API key (Anthropic example):
   ```powershell
   $env:ANTHROPIC_API_KEY = "YOUR_KEY"
   ```
3. Run:
   ```powershell
   npx ts-node .\src\cli.ts --pdf ".\reference-docs\<YOUR_FILE>.pdf" --provider anthropic --model claude-4-5-sonnet-20250929 --out .\out.json --debug
   ```

### Offline Optional
- **Ollama**:  
  ```powershell
  ollama serve
  ollama pull llama3.1:8b
  npx ts-node .\src\cli.ts --pdf .\file.pdf --provider ollama --model llama3.1:8b
  ```

### Optional Structured Parsers
- **GROBID**: start service on port 8070 and pass `--grobid-url`.  
- **Unstructured**: run service and pass `--unstructured-url`.

### Compile to JavaScript
```powershell
npm run build
node .\dist\cli.js --pdf .\reference-docs\ssrn-5298091.pdf --out .\out.json --debug
```

---

## Docker (PowerShell)

### Build
```powershell
docker build -t doc-pipeline:latest .
```

### Run (Anthropic)
```powershell
docker run --rm -v ${PWD}:/work `
  -e ANTHROPIC_API_KEY=$env:ANTHROPIC_API_KEY `
  -e PROVIDER=anthropic `
  -e MODEL=claude-sonnet-4-5-20250929 `
  -e PDF_FILE=/work/reference-docs/ssrn-5298091.pdf `
  -e OUT_FILE=/work/out.json `
  doc-pipeline:latest
```

---

## Testing
```powershell
npm run test
```

Test suite includes:
- Unit tests for author/date extraction and numeric date disambiguation.  
- Fusion tests ensuring parser dates beat LLM guesses.  
- Light integration test for pdf-parse on a sample doc.

---

## Error Handling 

I designed the pipeline with fallback layers for reliability. For example, if GROBID or Unstructured parsers fail, the pipeline falls back to pdf-parse. Dates are sanitized conservatively (using `YYYY-MM` for partial matches) instead of guessing missing information. For LLM providers, retries with exponential backoff are built in to handle network/API errors gracefully. On the performance side, I limit concurrent LLM calls with the `--max-concurrency` flag and avoid redundant API calls by preferring heuristics first before invoking LLMs. This balance keeps the solution both efficient and robust.

## Project Structure

```
src/
  cli.ts               # CLI entrypoint
  config.ts            # Config/env setup
  ensemble.ts          # Candidate fusion logic
  llm/
    index.ts           # Provider factory + prompts
    providers/
      anthropic.ts     # Anthropic API integration
      openai.ts        # OpenAI provider
      ollama.ts        # Ollama provider
  parsers/
    pdf.ts             # pdf-parse + heuristics + Crossref
    grobid.ts          # GROBID parser
    unstructured.ts    # Unstructured parser
  resolvers/
    crossref.ts        # DOI → Crossref lookup
  utils.ts             # Helpers (text/date/file)
tests/
  *.spec.ts            # Vitest test specs
reference-docs/
  *.pdf                # Sample PDFs
```

---

## Challenge Questions

**Why did you choose this challenge?**  
I enjoy building end-to-end AI pipelines that handle messy raw data. This challenge felt close to real-world legal AI work and gave me a chance to combine text extraction, heuristics, and LLMs to showcase my skillset which I can bring to Theo AI.

**How long did it take?**  
- 2 hours for core pipeline,  
- 1-1.5 hours for tests/fixes & Docker,  
- 45 minutes for documentation.  
Total: 3 to 4 hours.

**What was the hardest part?**  
Extracting dates from PDFs. They often appear multiple times (received/accepted/published).  
Solution which i used was to look for cues like *Published online* or *Posted*, and when only partial info was found (e.g., “May 2023”), fall back to **YYYY-MM** format.

**Where did you have the most fun?**  
Extracting authors. Initially, the pipeline captured parts of the title as authors, so refining heuristics was challenging and fun. I also added a bit of explainability to show which line was used as the title.

**What would you do with more time?**  
- Add explainability for which lines/pages supported each author/date. Add SHAP values, explaining what factors contributed in the output which we are looking at.  
- Add a RAG step so summaries/methods/findings cite the most relevant snippets.
- Introduce NLP-based evaluation for summaries. for example, using semantic similarity (e.g., cosine similarity on embeddings) or keyword overlap (ROUGE/BERTScore) to automatically compare the generated summaries against reference snippets. This would make summary testing more robust and measurable rather than only relying on manual inspection.
---


### Final Overview
Overall, This challenge was fun and it brought out the best of me, As I learnt more ways to parse scientific papers which can be very difficult to extract tradionally as the papers come in "all kinds of types". This take-home challenge is capable of turning into a fully explainable research document processor, which can generate annotated, citation-aware summaries and benchmarking itself using automated NLP metrics and I would definitely take some more time in future and work on it.
