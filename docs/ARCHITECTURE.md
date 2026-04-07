# LLM Wiki — Architecture Decision Records

> Documents key architectural decisions. See [SPEC.md](./SPEC.md) and [DESIGN.md](./DESIGN.md) for context.

---

## ADR-001: Cloudflare DurableObjects with SQLite for Wiki Storage

**Status:** Accepted

**Context:**
Wiki articles need durable persistence with relational queries (article links, FTS search). Options considered:
1. Cloudflare D1 (serverless SQLite)
2. DurableObject with SQLite storage
3. R2 + JSON files
4. KV store

**Decision:**
Use DurableObject with SQLite (`new_sqlite_classes` migration). This colocates the agent state (chat history, agent lifecycle) with the wiki data in a single DurableObject.

**Rationale:**
- `AIChatAgent` already runs as a DurableObject; adding SQLite requires zero extra infrastructure
- Strong consistency within the DO (no eventual consistency concerns)
- SQLite FTS5 available for full-text search
- D1 would require cross-service calls, adding latency

**Consequences:**
- Wiki data is tied to one geographic location (DO location)
- Storage limit: 10GB per DO (more than sufficient for a personal wiki)

---

## ADR-002: CodeMode for LLM Orchestration

**Status:** Accepted

**Context:**
The LLM needs to orchestrate multiple tool calls (e.g., read doc → create 5 articles → link them → embed them). Options:
1. Traditional tool calling (one tool at a time)
2. Cloudflare CodeMode (LLM writes TypeScript code)
3. Custom orchestration layer

**Decision:**
Use `@cloudflare/codemode` with `DynamicWorkerExecutor`.

**Rationale:**
- 81% token reduction for multi-step workflows (Cloudflare benchmark)
- LLMs are better at writing TypeScript than following bespoke tool-call syntax
- Dynamic Workers provide secure sandbox for generated code
- Karpathy's workflow is inherently multi-step (read → extract → link → synthesize)

**Consequences:**
- Dynamic Worker Loaders is in open beta; API may change
- Requires `worker_loaders` binding in wrangler.jsonc
- Generated code errors are caught and returned to the LLM for correction

---

## ADR-003: R2 for Raw Document Storage

**Status:** Accepted

**Context:**
Raw documents (papers, articles, notes) need durable storage. Options:
1. R2 (Cloudflare object storage)
2. KV (key-value; not suitable for large blobs)
3. D1 BLOB column
4. External storage (S3, GCS)

**Decision:**
Use Cloudflare R2.

**Rationale:**
- Native Cloudflare integration (no egress fees)
- Supports large files (PDF, markdown, text)
- Can be accessed from both the main Worker and WikiAgent DO
- Free tier: 10GB storage, 1M Class A ops

**Consequences:**
- R2 bucket must be created before deployment (see setup instructions)
- PDF parsing not supported in v1 (text extraction requires separate tooling)

---

## ADR-004: Vectorize for Semantic Search

**Status:** Accepted  

**Context:**
Semantic search over wiki articles requires vector embeddings. Options:
1. Cloudflare Vectorize (native)
2. Pinecone / Weaviate (external)
3. SQLite FTS only (no semantics)
4. Workers AI embeddings + in-memory similarity (not scalable)

**Decision:**
Use Cloudflare Vectorize with Workers AI embeddings (`@cf/baai/bge-small-en-v1.5`).

**Rationale:**
- Native Cloudflare integration (no external API keys)
- `@cf/baai/bge-small-en-v1.5` is free tier on Workers AI
- Vectorize free tier: 5M vectors (sufficient for personal wiki)
- Fallback to SQLite FTS if Vectorize is not configured

**Consequences:**
- Vectorize index must be created before deployment
- 384-dimensional embeddings (BGE-small)
- Re-embedding required when articles are updated (handled in updateArticle tool)

---

## ADR-005: Workers AI Model Selection

**Status:** Accepted

**Context:**
The LLM for chat and wiki synthesis. Options:
1. `@cf/meta/llama-3.3-70b-instruct` (free, good quality)
2. `@cf/moonshotai/kimi-k2.5` (used in codemode example)
3. External API (OpenAI, Anthropic) via API key
4. `@cf/meta/llama-3.1-8b-instruct` (free, faster, lower quality)

**Decision:**
Default to `@cf/moonshotai/kimi-k2.5` (same as codemode example, strong at code generation) with fallback to `@cf/meta/llama-3.3-70b-instruct`. Allow override via `WORKERS_AI_MODEL` secret.

**Rationale:**
- Kimi K2.5 is particularly strong at code generation (important for CodeMode)
- No external API key required
- Consistent with Cloudflare's own codemode example

**Consequences:**
- Rate limits may be hit during large ingestion batches
- Model availability depends on Workers AI service health

---

## ADR-006: Vite + React for Frontend

**Status:** Accepted

**Context:**
Frontend framework for the wiki UI. Options:
1. Vite + React (used in all Cloudflare agent examples)
2. Hono JSX (lighter, server-rendered)
3. Plain HTML/JS
4. Next.js (too heavy for Workers)

**Decision:**
Use Vite + React, matching the codemode and dynamic-workers examples.

**Rationale:**
- `@cloudflare/vite-plugin` provides seamless local development with `wrangler dev`
- `useAgentChat` from `@cloudflare/ai-chat/react` handles WebSocket + streaming
- Consistent with Cloudflare's agent ecosystem
- Tailwind CSS v4 for rapid styling

**Consequences:**
- Requires Vite build step in CI/CD
- `public/` directory served via Cloudflare Workers Assets

---

## ADR-007: GitHub Actions for CI/CD

**Status:** Accepted

**Context:**
Deployment pipeline. Options:
1. GitHub Actions (free, widely supported)
2. Cloudflare Workers Pages CI (limited customization)
3. Manual deploy only

**Decision:**
GitHub Actions with `wrangler deploy` on push to `main`.

**Rationale:**
- `CLOUDFLARE_API_TOKEN` can be stored as a GitHub secret
- Existing `wrangler` GitHub Action available
- Standard approach for Cloudflare Workers deployment

**Consequences:**
- Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets in GitHub
- One-time manual resource creation required (R2 bucket, Vectorize index)
