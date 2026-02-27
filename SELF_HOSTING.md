# Self-Hosting Guide (No Lyzr)

This project now supports two chat backends:
- Chat LLM: Ollama or NVIDIA NIM/API
- Embeddings: Ollama
- RAG: local JSON index + chunk embeddings
- Scheduler: local persisted scheduler engine
- API protection: bearer/basic auth + per-route rate limiting

## Prerequisites

- Node.js 20+ (see `.nvmrc`)
- npm 10+

## 1. Choose your chat backend

### Option A: NVIDIA NIM/API chat (cloud)

Set in `.env.local`:

```bash
CHAT_PROVIDER=nvidia
NVIDIA_API_KEY=<your-nvidia-api-key>
NVIDIA_API_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_CHAT_MODEL=nvidia/nemotron-nano-12b-v2-vl
```

### Option B: Ollama chat (local)

```bash
ollama serve
ollama pull llama3.1:8b
ollama pull nomic-embed-text
```

## 2. Configure environment

```bash
cp .env.example .env.local
```

Minimum values for production:
- `API_AUTH_TOKEN`
- `NEXT_PUBLIC_API_AUTH_TOKEN` (same value for this prototype UI)
- `CHAT_PROVIDER` and matching chat backend variables
- `OLLAMA_EMBEDDING_MODEL` (for RAG embeddings)

## 3. Run locally

```bash
npm install
npm run dev
```

## 4. Docker deployment

```bash
docker build -t research-twin .
docker run -p 3333:3333 \
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  -e API_AUTH_TOKEN=change-me \
  -e NEXT_PUBLIC_API_AUTH_TOKEN=change-me \
  -v $(pwd)/data:/app/data \
  research-twin
```

## 5. API routes now backed by local stack

- `POST /api/agent`: async submit + poll task execution using Ollama
- `POST /api/agent`: async submit + poll task execution using configured chat backend
- `POST /api/upload`: local asset storage
- `POST/PATCH/DELETE /api/rag`: local document index/crawl/delete
- `POST /api/model-benchmark`: run one prompt across multiple models with latency + quality scoring
- `GET/POST/DELETE /api/scheduler`: local schedule CRUD + trigger/logs
- `GET /api/health`: reports API/chat backend status

## Notes

- PDF uploads are parsed with `pdf-parse` during RAG ingestion.
- Scanned/image-only PDFs may still fail text extraction; use OCR or export text-searchable PDFs.
- Scheduler cron parsing uses 5-field cron and evaluates in UTC.
- Local stores are persisted under `data/` (or `DATA_DIR`).
