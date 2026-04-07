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
Use DurableObject with SQLite (`new_sqlite_classes` migration) for structured metadata and FTS; R2 for raw file bytes.

**Rationale:**
- `AIChatAgent` already runs as a DurableObject; adding SQLite requires zero extra infrastructure
- Strong consistency within the DO (no eventual consistency concerns)
- SQLite FTS5 available for full-text search over article content
- D1 would require cross-service calls, adding latency
- R2 stores the actual file bytes; the DO only stores an `r2_key` pointer plus metadata — keeps the DO lean and lets R2 stream large files without buffering in Worker memory

**Consequences:**
- Wiki data is tied to one geographic location (DO location)
- Storage limit: 10GB per DO (more than sufficient for a personal wiki)
- PDF text extraction: use Workers AI `toMarkdown` API on the R2 object at ingest time

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

## ADR-006: Vanilla HTML/CSS/JS for Frontend

**Status:** Accepted

**Context:**
Frontend for the wiki UI. Options:
1. Vite + React (used in Cloudflare agent examples)
2. Hono JSX (lighter, server-rendered)
3. Plain HTML/CSS/JS (no framework)
4. Next.js (too heavy for Workers)

**Decision:**
Use plain HTML/CSS/JavaScript served as static assets from `public/`. Vite still bundles the Worker; the client is not processed by Vite.

**Rationale:**
- No build step or framework dependency for the UI
- `public/app.js` and `public/styles.css` are served verbatim by Cloudflare Workers Assets
- WebSocket chat via native `WebSocket` API to `/agents/wiki-agent/:wikiId`
- CSS custom properties for theming; no Tailwind needed
- Smaller deployment artifact; simpler dependency graph

**Consequences:**
- No JSX/TypeScript in client code; plain ES module syntax only
- State management is manual (module-level state object + localStorage)
- `@cloudflare/vite-plugin` still handles the Worker bundle; removing React has no impact on Workers Assets serving

---

## ADR-008: MCP Server via Stateless Worker Handler

**Status:** Accepted

**Context:**
External AI clients (Claude Desktop, Cursor, Copilot) need to connect to the wiki via MCP. Options:
1. Stateful `McpAgent` DurableObject per session
2. Stateless `createMcpHandler()` in the main Worker, routing through WikiAgent RPC
3. Separate MCP Worker deployment

**Decision:**
Use option 2: stateless `createMcpHandler()` factory in the main Worker.

**Rationale:**
- WikiAgent already holds all state (SQLite); MCP tools just call `@callable` methods via DO RPC
- No additional DurableObject class required for MCP state
- Both `/mcp` (raw tool calling) and `/codemode-mcp` (CodeMode-wrapped) served from same Worker
- `codeMcpServer()` from `@cloudflare/codemode/mcp` wraps any `McpServer` with Dynamic Workers sandbox

**Consequences:**
- MCP requests hit the main Worker then fan out to WikiAgent DO via RPC
- Session continuity for MCP is handled by the MCP client (standard MCP behaviour)
- If WikiAgent is cold-started, first MCP request may be slow (~100ms)

---

## ADR-009: CDN Caching via caches.default

**Status:** Accepted

**Context:**
Wiki article reads should be served from Cloudflare's CDN edge without hitting the DurableObject on every request. Options:
1. `caches.default` (Workers Cache API) — programmatic control
2. Cloudflare Cache Rules (zone-level) — no programmatic eviction without Zones API
3. KV store as read cache — adds latency vs edge cache
4. No caching — full latency on every request

**Decision:**
Use `caches.default` with `ETag`/conditional-request support and programmatic eviction on writes.

**Rationale:**
- `caches.default` IS the Cloudflare CDN edge cache — responses stored here are served at the PoP nearest the user
- Full programmatic control: `match()`, `put()`, `delete()` from within Workers and DurableObjects
- ETag + `If-None-Match` support reduces bandwidth for unchanged articles (304 responses)
- Cache eviction is triggered synchronously from write paths (create/update/delete article)
- No external API calls needed (unlike Cloudflare Zones API purge)

**Cache TTLs:**
| Endpoint | max-age | stale-while-revalidate |
|----------|---------|----------------------|
| `GET /wiki/:wikiId/article/:slug` | 300s (5 min) | 3600s (1 hr) |
| `GET /wiki/:wikiId/articles` | 60s | 600s (10 min) |
| `GET /wiki/:wikiId/stats` | 60s | 300s |
| `GET /wiki/:wikiId/articles?search=…` | 30s | 120s |

The wikiId is part of the URL path so each wiki instance has a completely separate cache partition automatically.

**Eviction trigger:** Any write (createArticle, updateArticle, deleteArticle) evicts:
- `/wiki/{wikiId}/article/{slug}` (the specific article)
- `/wiki/{wikiId}/articles` (the full list)
- `/wiki/{wikiId}/stats` (counts may have changed)

**`caches.default` scope:**
- **Zone-bound worker (custom domain):** `caches.default` IS the global Cloudflare CDN edge cache. Responses are stored at the PoP nearest each user and served globally.
- **workers.dev subdomain:** `caches.default` is a per-datacenter cache (useful for reducing DO hits within a DC, but not globally shared). For full global CDN benefit, deploy on a custom domain.

**HOST env var:** DurableObjects need `env.HOST` to build absolute URLs for `caches.default.delete()`. This is set as a Worker secret/var (see CI/CD setup).

**Consequences:**
- `caches.default` operations are no-ops in `wrangler dev` (local dev); articles are always fresh locally
- In production, stale-while-revalidate means a write may take up to `max-age` seconds to appear at all PoPs (acceptable for a personal wiki)
- Zone-wide "purge all" is not supported without the Zones API; `evictAll()` only clears list/stats endpoints

**Status:** Accepted

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
