# LLM Wiki

> Andrej Karpathy's [llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) concept running on the Cloudflare developer platform.

An AI-maintained, interlinked personal knowledge base. Upload raw documents; the LLM extracts key concepts and builds a structured, searchable wiki that grows richer over time.

---

## Features

| Feature | Implementation |
|---------|---------------|
| **Persistent wiki** | SQLite inside a Cloudflare DurableObject |
| **AI chat** | `AIChatAgent` + [CodeMode](https://blog.cloudflare.com/code-mode-mcp/) — LLM writes TypeScript to orchestrate tools |
| **Semantic search** | Cloudflare Vectorize + `@cf/baai/bge-small-en-v1.5` embeddings |
| **Full-text search** | SQLite FTS5 |
| **Document ingestion** | R2 storage + `IngestAgent` (background AI extraction) |
| **Wiki linting** | `LintAgent` — orphan detection, broken links, stub articles |
| **MCP server** | `/mcp` (standard) and `/codemode-mcp` (CodeMode-wrapped) |
| **CDN caching** | `caches.default` with ETag, stale-while-revalidate, programmatic eviction |
| **CI/CD** | GitHub Actions → `wrangler deploy` on push to `main` |

---

## Architecture

```
Browser (React SPA)
      │ WebSocket + HTTP
      ▼
Cloudflare Worker (Entry Point)
      ├── /mcp, /codemode-mcp  ─────────────────► WikiMcpServer
      │                                            (stateless, routes to WikiAgent RPC)
      ├── GET  /api/article/:slug  ◄──── CDN cache (5 min ETag)
      ├── GET  /api/articles       ◄──── CDN cache (1 min, stale-while-revalidate)
      ├── GET  /api/stats          ◄──── CDN cache (1 min)
      ├── POST /api/upload  ────────────────────► R2 Bucket
      ├── POST /api/ingest/:id  ────────────────► IngestAgent DO
      ├── POST /api/lint  ──────────────────────► LintAgent DO
      └── /api/agent/*  ────────────────────────► WikiAgent DO
                                                      │
                                                      ├── SQLite (articles, links, docs)
                                                      ├── R2 (raw doc content)
                                                      ├── Vectorize (embeddings)
                                                      └── Workers AI + CodeMode
                                                              └── Dynamic Worker sandbox
```

---

## Quick Start (Local Dev)

```bash
npm install
cp .env.example .dev.vars
# Edit .dev.vars with your settings
npm run dev
# → http://localhost:8787
```

---

## Deployment

See **[docs/SETUP.md](docs/SETUP.md)** for the one-time Cloudflare + GitHub setup (R2 bucket, Vectorize index, API token, GitHub secrets).

Once configured, every push to `main` deploys automatically via GitHub Actions.

---

## MCP Configuration

Connect Claude Desktop, Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "type": "http",
      "url": "https://YOUR_WORKER.workers.dev/mcp"
    }
  }
}
```

**Available tools:** `wiki_search`, `wiki_get_article`, `wiki_list_articles`, `wiki_get_stats`, `wiki_create_article`, `wiki_update_article`, `wiki_delete_article`, `wiki_list_documents`, `wiki_process_document`, `wiki_lint`

**Resources:** `wiki://articles/{slug}`, `wiki://stats`

---

## Documentation

| Document | Purpose |
|----------|---------|
| [docs/SPEC.md](docs/SPEC.md) | Specification — **source of truth** |
| [docs/DESIGN.md](docs/DESIGN.md) | Technical design |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture decision records |
| [docs/SETUP.md](docs/SETUP.md) | One-time setup instructions for @brian-ln |

---

## Inspiration

- [Karpathy's llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [Cloudflare CodeMode blog post](https://blog.cloudflare.com/code-mode-mcp/)
- [Cloudflare Dynamic Workers blog post](https://blog.cloudflare.com/dynamic-workers/)

