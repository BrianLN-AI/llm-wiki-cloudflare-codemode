# LLM Wiki

> Andrej Karpathy's [llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) concept running on the Cloudflare developer platform.

An AI-maintained, interlinked personal knowledge base. Upload raw documents; the LLM extracts key concepts and builds a structured, searchable wiki that grows richer over time.

---

## Features

| Feature | Implementation |
|---------|---------------|
| **Multi-wiki** | Each wiki ID gets its own isolated DurableObject — switch wikis with a URL path segment |
| **Persistent wiki** | SQLite (metadata) + R2 (file bytes) inside a Cloudflare DurableObject |
| **AI chat** | `AIChatAgent` + [CodeMode](https://blog.cloudflare.com/code-mode-mcp/) — LLM writes TypeScript to orchestrate tools |
| **Semantic search** | Cloudflare Vectorize + `@cf/baai/bge-small-en-v1.5` embeddings |
| **Full-text search** | SQLite FTS5 |
| **Document ingestion** | R2 storage + `IngestAgent` + Workers AI `toMarkdown` (PDF support) |
| **Wiki linting** | `LintAgent` — orphan detection, broken links, stub articles |
| **MCP server** | Per-wiki `/wiki/:id/mcp` and `/wiki/:id/codemode-mcp` |
| **CDN caching** | `caches.default` with ETag, per-wiki cache partitions, programmatic eviction |
| **Auth** | Optional `API_KEY` Bearer token for write paths; Cloudflare Access for WebSocket |
| **UI** | Vanilla HTML/CSS/JS (no framework) — four tabs: Chat, Browse, Documents, MCP |
| **CI/CD** | GitHub Actions → `wrangler deploy` on push to `main` |

---

## Architecture

```
Browser (Vanilla HTML/CSS/JS)
      │ WebSocket + HTTP
      ▼
Cloudflare Worker (Entry Point)
      ├── GET  /wiki/:id/article/:slug  ◄─── CDN cache (5 min ETag, per-wiki)
      ├── GET  /wiki/:id/articles       ◄─── CDN cache (1 min, stale-while-revalidate)
      ├── GET  /wiki/:id/stats          ◄─── CDN cache (1 min)
      ├── POST /wiki/:id/upload  ─────────────────────► R2 Bucket
      ├── POST /wiki/:id/ingest/:docId  ──────────────► IngestAgent DO
      ├── POST /wiki/:id/lint  ───────────────────────► LintAgent DO
      ├── GET  /wiki/:id/mcp, /wiki/:id/codemode-mcp  ► WikiMcpServer
      └── WS   /agents/wiki-agent/:id  ───────────────► WikiAgent DO
                                                             │
                                                             ├── SQLite (articles, links, docs)
                                                             ├── R2 (raw doc bytes)
                                                             ├── Vectorize (embeddings)
                                                             └── Workers AI + CodeMode
                                                                     └── Dynamic Worker sandbox
```

---

## Multi-Wiki Support

Every API path includes the wiki ID: `/wiki/{wikiId}/...`

```bash
# Default wiki
curl https://YOUR_WORKER.workers.dev/wiki/default/articles

# A separate "research" wiki
curl https://YOUR_WORKER.workers.dev/wiki/research/articles

# Chat with a specific wiki via WebSocket
wss://YOUR_WORKER.workers.dev/agents/wiki-agent/research
```

Each wiki ID maps to its own DurableObject instance (isolated SQLite + R2 prefix + cache partition). The UI header has a wiki ID input to switch at runtime.

---

## Authentication

| Endpoint class | Auth |
|---|---|
| `GET /wiki/:id/*` reads | None (public, CDN-cached) |
| `POST /wiki/:id/*` writes | `Authorization: Bearer <API_KEY>` (if `API_KEY` env var is set) |
| `/wiki/:id/mcp`, `/wiki/:id/codemode-mcp` | Same as writes |
| `/agents/wiki-agent/:id` (WebSocket/chat) | Recommend [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/) |

Set an API key:
```bash
wrangler secret put API_KEY
```

When `API_KEY` is not set the Worker is in **open mode** — fine for local dev, not for production.

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

Connect Claude Desktop, Cursor, or any MCP client to a specific wiki:

```json
{
  "mcpServers": {
    "llm-wiki-default": {
      "type": "http",
      "url": "https://YOUR_WORKER.workers.dev/wiki/default/mcp"
    },
    "llm-wiki-research": {
      "type": "http",
      "url": "https://YOUR_WORKER.workers.dev/wiki/research/mcp"
    }
  }
}
```

If `API_KEY` is set, add `"headers": { "Authorization": "Bearer <key>" }`.

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
