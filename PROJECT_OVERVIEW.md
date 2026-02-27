# Project Overview

## 1. High-Level Architecture

This project is a Next.js full-stack application that provides a research-focused chatbot ("Research Twin") over a local RAG corpus.

Core layers:
- **Frontend (App Router UI)**: Chat interface, knowledge-base management, and model benchmark panel.
- **API Layer (`app/api/*`)**: Route handlers for agent execution, RAG ingestion/query plumbing, benchmarking, uploads, health, and schedules.
- **Service Layer (`lib/server/*`)**: Agent runtime orchestration, RAG storage/retrieval, scheduler execution, security/rate-limiting, and LLM/embedding clients.
- **Shared Utilities (`lib/*`)**: Client-side agent wrappers, response parsers, fetch wrappers, and config constants.
- **Data Layer (`data/*`)**: Local JSON-backed persistent stores for RAG, assets, and scheduler state.

## 2. Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript
- **UI**: React 18 + Tailwind CSS + Radix primitives (selected components)
- **Backend Runtime**: Next.js Route Handlers (Node runtime)
- **RAG Store**: Local JSON file store (`data/rag/store.json`)
- **LLM/Embeddings**: Ollama integration via server utilities
- **Tooling**: ESLint, PostCSS, Tailwind

## 3. Directory Structure Explanation

- `app/`
  - `page.tsx`: Main UI page (profile + chat + controls)
  - `layout.tsx`: Global layout wiring (error boundary/interceptor providers)
  - `api/*/route.ts`: Backend HTTP endpoints
- `components/`
  - `ErrorBoundary.tsx`, `AgentInterceptorProvider.tsx`, `IframeLoggerInit.tsx`
  - `ui/`: Only currently used shared UI primitives
- `hooks/`
  - `useAgent.ts`: Agent call lifecycle + global error callback registration
- `lib/`
  - `config/`: Centralized environment defaults and canonical publication metadata
  - `parsers/`: Agent response normalization/parsing helpers
  - `server/`: Runtime services (agent, RAG store, scheduler, security, Ollama, file/text handling)
  - client utilities (`aiAgent.ts`, `ragKnowledgeBase.ts`, `fetchWrapper.ts`, etc.)
- `data/`
  - `rag/`: RAG documents/chunks store and publication corpus files
  - `assets/`: Uploaded user asset metadata/content
  - `scheduler/`: Scheduled task state
- `response_schemas/`: Response format references

## 4. Data Flow (Frontend -> Backend -> LLM -> Response)

1. User submits a chat message in `app/page.tsx`.
2. Frontend calls `callAIAgent()` (`lib/aiAgent.ts`) -> `POST /api/agent`.
3. `/api/agent` creates an async task and executes `executeAgent()` (`lib/server/agentRuntime.ts`).
4. Agent runtime:
   - Detects intent
   - Retrieves relevant chunks from local RAG store (`lib/server/ragStore.ts`)
   - Builds prompt with evidence context
   - Calls Ollama (`lib/server/ollama.ts`)
   - Normalizes/validates output and enforces citation contract
5. Frontend polls task completion and receives structured JSON.
6. Response parser (`lib/parsers/agentResponse.ts`) extracts clean answer text, metadata, citations, and follow-up prompts.
7. UI renders answer text, expandable metadata, and clickable follow-up questions.

## 5. How to Run Locally

1. Install dependencies:
   - `npm install`
2. Configure environment:
   - Copy `.env.example` to `.env.local` and fill required values.
3. Start development server:
   - `npm run dev`
4. Open:
   - `http://localhost:3333`

## 6. Environment Variables

Key variables (see `.env.example` for full list):
- `DEFAULT_RAG_ID`: Server default RAG namespace.
- `RAG_TOP_K`: Default retrieval chunk count.
- `NEXT_PUBLIC_RAG_ID`: Client-side default RAG namespace.
- `NEXT_PUBLIC_AGENT_ID`: Client-side default agent identifier.
- `RATE_LIMIT_*`: Per-route rate limiting controls.
- `AGENT_TASK_TTL_MS`: Async task retention window.
- Ollama/model variables used by `lib/server/ollama.ts` and benchmark runtime.

## 7. Deployment Notes

- App is compatible with standard Next.js deployment targets.
- `netlify.toml` and `@netlify/plugin-nextjs` are included for Netlify deployment.
- Ensure persistent writable storage for `data/*` if deployment target is ephemeral.
- Production environment must provide valid LLM/Ollama connectivity and required env vars.

## 8. Future Extension Points

- Replace local JSON RAG store with a vector database adapter while preserving `ragStore` interfaces.
- Add richer document metadata extraction during ingestion (DOI, authors, links).
- Introduce automated citation validation tests over the canonical publication catalog.
- Add streaming chat responses and partial rendering in frontend.
- Add admin tooling for corpus versioning and audit trails.
