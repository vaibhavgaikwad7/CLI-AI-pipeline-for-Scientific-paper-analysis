# 📄 Document AI Pipeline  
### *Hybrid Heuristics + LLM Ensemble System for Scientific PDF Understanding*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)
![Node Version](https://img.shields.io/badge/node-%3E%3D18-blue)
![Build Status](https://img.shields.io/badge/CI-passing-brightgreen)

---

## ⭐ Overview

**Document AI Pipeline** is a production-ready system for extracting structured information from scientific PDFs using a **hybrid architecture**:

- **Deterministic heuristics** for reliable metadata extraction  
- **Crossref authority lookup** for validation  
- **LLM ensemble** (Anthropic, OpenAI, Ollama) for semantic understanding  
- **Reproducible CLI**, **Dockerized**, modular, and built for real-world document processing  

Originally created during a hiring challenge, this project has been expanded into a professional open-source pipeline focused on robustness, explainability, and high-quality scientific document parsing.

---

## 🚀 Features

### 📘 Core Extraction
Extracts structured JSON containing:

- `document_type`  
- `authors`  
- `document_date` (ISO-normalized)  
- `summary`  
- `methods_summary`  
- `findings_summary`

### 🔍 Robust Heuristics Layer
- Title detection using formatting + position cues  
- Author extraction rules ignoring affiliations/emails/degrees  
- Ranked date selection (*Published* > *Posted* > *Accepted* > *Received*)  
- ISO-compliant date sanitization (`YYYY-MM` for partial dates)  

### 🧠 LLM Ensemble System
Two complementary prompt strategies generate semantic fields.

**Supported providers:**
- Anthropic (Claude)
- OpenAI (GPT)
- Ollama (offline)
- Heuristic-only mode

Ensemble logic merges:
- Longest coherent summaries  
- Combined author lists  
- Weighted conflict resolution  

### 📚 Authority Checks
If a DOI is found:
- Query **Crossref**  
- Accept metadata only if **title similarity threshold** is satisfied  
→ Prevents accidental use of reference metadata.

### 🧱 Modular Parsers
- `pdf-parse` (default)
- **GROBID** (optional)
- **Unstructured** (optional)
- Automatic fallback if services fail

### 🐳 Docker Support
Reproducible and environment-independent.

---

## 🏗 Architecture

```
                    ┌──────────────┐
                    │    PDF File   │
                    └───────┬───────┘
                            │
                    ┌───────▼────────┐
                    │  PDF Parser     │
                    │ (pdf-parse /    │
                    │  GROBID /       │
                    │  Unstructured)  │
                    └───────┬────────┘
                            │
            ┌───────────────▼────────────────┐
            │          Heuristics             │
            │ (title, authors, dates, DOI)    │
            └───────────────┬────────────────┘
                            │
                    ┌───────▼────────┐
                    │ Crossref Lookup │
                    └───────┬────────┘
                            │
         ┌──────────────────▼───────────────────┐
         │               LLM Ensemble           │
         │  (summary, methods, findings JSON)   │
         └──────────────────┬───────────────────┘
                            │
                    ┌───────▼────────┐
                    │ Fusion Engine   │
                    │ (scoring/merge) │
                    └───────┬────────┘
                            │
                    ┌───────▼────────┐
                    │   Final JSON    │
                    └─────────────────┘
```

---

## 📦 Installation

### Clone the repository
```bash
git clone https://github.com/<your-username>/document-ai-pipeline.git
cd document-ai-pipeline
```

### Install dependencies
```bash
npm install
```

---

## ▶️ Usage

### Basic CLI
```bash
npx ts-node ./src/cli.ts \
  --pdf "./reference-docs/sample.pdf" \
  --provider anthropic \
  --model claude-3-sonnet \
  --out ./out.json \
  --debug
```

### Offline Mode (Ollama)
```bash
ollama serve
ollama pull llama3.1:8b

npx ts-node ./src/cli.ts \
  --pdf ./paper.pdf \
  --provider ollama \
  --model llama3.1:8b
```

### Using GROBID
```bash
npx ts-node ./src/cli.ts \
  --pdf ./paper.pdf \
  --grobid-url http://localhost:8070/api/processFulltextDocument
```

### Build to JS
```bash
npm run build
node ./dist/cli.js --pdf ./paper.pdf --out ./out.json
```

---

## 🐳 Docker

### Build:
```bash
docker build -t doc-pipeline:latest .
```

### Run (Anthropic Example):
```bash
docker run --rm -v ${PWD}:/work \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e PROVIDER=anthropic \
  -e MODEL=claude-3-sonnet \
  -e PDF_FILE=/work/reference-docs/sample.pdf \
  -e OUT_FILE=/work/out.json \
  doc-pipeline:latest
```

---

## 📁 Project Structure

```
src/
  cli.ts
  config.ts
  ensemble.ts
  llm/
    index.ts
    providers/
      anthropic.ts
      openai.ts
      ollama.ts
  parsers/
    pdf.ts
    grobid.ts
    unstructured.ts
  resolvers/
    crossref.ts
  utils.ts
reference-docs/
examples/
docs/
  architecture.md
  design-decisions.md
  heuristics.md
  llm-prompts.md
Dockerfile
package.json
```

---

## 🧭 Roadmap

- [ ] Line-level explainability (show lines used for title/authors/dates)  
- [ ] Citation-aware RAG enhancement  
- [ ] SHAP-style heuristic explainability  
- [ ] Automatic summary evaluation (ROUGE / BERTScore)  
- [ ] Web dashboard for viewing outputs  
- [ ] Batch processing mode  
- [ ] Layout-aware PDF parsing (PyMuPDF)  

---

## 🤝 Contributing

Open to issues, ideas, and PRs — contributions are welcome.

---

## 📜 License

MIT License – free to use, modify, and distribute.

---

## ⭐ Acknowledgements

This project started as a technical challenge and evolved into a robust hybrid Document AI pipeline, combining traditional heuristics with modern LLM systems for scientific document understanding.

