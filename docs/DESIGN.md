# LLM Wiki — Technical Design

> Derives from [SPEC.md](./SPEC.md). Code must trace to spec requirements.

## 1. System Architecture

```
Browser (React SPA)
      │
      │ WebSocket + HTTP
      ▼
Cloudflare Worker (Entry Point)
      │
      ├── POST /api/upload ──────────► R2 Bucket (raw documents)
      │
      ├── GET  /api/documents ───────► WikiAgent.listRawDocuments()
      │
      ├── GET  /api/health
      │
      └── /api/agent/* ─────────────► WikiAgent (DurableObject)
                                            │
                                            ├── SQLite (articles, links, docs)
                                            ├── R2 (read raw docs for processing)
                                            ├── Vectorize (semantic search)
                                            ├── Workers AI (LLM + embeddings)
                                            │
                                            └── CodeMode ──► DynamicWorkerExecutor
                                                                    │
                                                                    └── LOADER binding
                                                                        (isolated V8 sandbox)
```

## 2. Component Design

### 2.1 Main Worker (`src/server.ts`)

Responsibilities:
- Route requests to the correct handler
- Handle R2 uploads (multipart form data)
- Proxy agent requests to WikiAgent DurableObject
- Serve static assets (via Cloudflare Workers Assets)

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (url.pathname === '/api/upload') return handleUpload(request, env);
    if (url.pathname === '/api/documents') return handleListDocuments(request, env);
    if (url.pathname === '/api/health') return handleHealth();
    return routeAgentRequest(request, env) || serveAssets(request, env);
  }
}
```

### 2.2 WikiAgent DurableObject (`src/server.ts`)

Extends `AIChatAgent<Env>` from `@cloudflare/ai-chat`.

**State:**
- SQLite via `this.ctx.storage.sql`
- Three tables: `articles`, `article_links`, `raw_documents`

**CodeMode integration:**
```typescript
const codemode = createCodeTool({ tools: this.wikiTools, executor });
const result = streamText({
  model: workersai('@cf/meta/llama-3.3-70b-instruct'),
  tools: { codemode },
  system: WIKI_SYSTEM_PROMPT,
  messages: this.messages,
});
```

**Callable methods (exposed to client):**
- `getToolTypes()` — returns TypeScript type definitions for CodeMode
- `getArticles(search?)` — list/search articles
- `getArticle(slug)` — get single article

### 2.3 Wiki Tools (`src/wiki-tools.ts`)

Tools available to the LLM via CodeMode:

| Tool | Description |
|------|-------------|
| `createArticle` | Create a new wiki article |
| `updateArticle` | Update article fields |
| `getArticle` | Get article by ID or slug |
| `listArticles` | List articles with filters |
| `deleteArticle` | Delete article and its links |
| `searchArticles` | Full-text search (SQLite FTS) |
| `linkArticles` | Create a directional link between articles |
| `getLinkedArticles` | Get articles linked from/to a slug |
| `vectorSearch` | Semantic search via Vectorize |
| `upsertVector` | Store/update article embedding |

### 2.4 Ingest Tools (`src/ingest-tools.ts`)

| Tool | Description |
|------|-------------|
| `listRawDocuments` | List all raw documents and their status |
| `getRawDocumentContent` | Fetch document text from R2 |
| `markDocumentProcessing` | Update status to 'processing' |
| `markDocumentDone` | Update status to 'done', store article IDs |
| `markDocumentError` | Update status to 'error', store message |
| `registerDocument` | Add a document record (called after upload) |

### 2.5 Client (`src/client.tsx`)

Three-tab layout:

1. **Chat** — `useAgentChat` hook, CodeMode tool cards, message history
2. **Wiki** — Browse/search articles, read full content
3. **Documents** — Upload files, view processing status, trigger ingestion

## 3. Data Flow

### Document Ingestion Flow

```
User uploads file
      │
      ▼
POST /api/upload
      │
      ├── Store file in R2 (key: docs/{uuid}/{filename})
      ├── Register document in WikiAgent SQLite (status: pending)
      └── Return { id, filename, status: 'pending' }

User clicks "Process"
      │
      ▼
Chat: "Process document {id}"
      │
      ▼
WikiAgent.onChatMessage()
      │
      ▼
CodeMode LLM writes code:
  const doc = await codemode.getRawDocumentContent({ id });
  await codemode.markDocumentProcessing({ id });
  // Extract concepts, create articles
  const article1 = await codemode.createArticle({ title, content, summary, tags });
  await codemode.upsertVector({ id: article1.id, text: content });
  await codemode.markDocumentDone({ id, articleIds: [article1.id] });
      │
      ▼
DynamicWorkerExecutor runs code in sandbox
      │
      ▼
Articles created, document marked done
```

### Query Flow

```
User asks: "What do I know about neural networks?"
      │
      ▼
WikiAgent.onChatMessage()
      │
      ▼
CodeMode LLM writes code:
  const results = await codemode.vectorSearch({ query: 'neural networks', topK: 5 });
  const articles = await Promise.all(
    results.map(r => codemode.getArticle({ slug: r.id }))
  );
  return synthesizeAnswer(articles, query);
      │
      ▼
Answer returned with article citations
```

## 4. Cloudflare Bindings

```jsonc
// wrangler.jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "WikiAgent", "class_name": "WikiAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["WikiAgent"] }],
  "r2_buckets": [{ "binding": "RAW_DOCS", "bucket_name": "llm-wiki-raw" }],
  "vectorize": [{ "binding": "WIKI_VECTORS", "index_name": "llm-wiki-vectors" }],
  "ai": { "binding": "AI" },
  "worker_loaders": [{ "binding": "LOADER" }],
  "assets": { "directory": "public", "not_found_handling": "single-page-application" }
}
```

## 5. System Prompt Design

The WikiAgent uses a carefully crafted system prompt:

```
You are a personal knowledge wiki assistant. You maintain a structured wiki of
interconnected articles that grows richer over time.

When processing documents:
- Extract key concepts and create one article per major concept
- Write articles in clear, concise prose with markdown formatting
- Always create wiki links between related articles using [[Article Title]] syntax
- Write a one-paragraph summary for each article

When answering questions:
- Search the wiki first using vectorSearch and searchArticles
- Synthesize answers from multiple articles when needed
- Always cite the articles you used
- If no relevant articles exist, say so clearly

When linting the wiki:
- Find articles missing summaries and add them
- Find broken [[wiki links]] and fix them
- Merge duplicate articles (same concept, different titles)
- Find orphaned articles (no links to/from them) and suggest connections
```

## 6. Security Considerations

- **Sandbox isolation**: LLM-generated code runs in Dynamic Worker sandboxes with no internet access
- **R2 access**: Only the main worker can write to R2 (upload handler), WikiAgent reads via env
- **No secret leakage**: API keys are bound as Worker secrets, never exposed to client
- **Input validation**: All tool inputs validated with Zod schemas
- **Content-Type validation**: Only text/* and application/pdf accepted for uploads

## 7. CI/CD Design

GitHub Actions workflow triggers on push to `main`:

1. `npm ci` — install dependencies
2. `npm run typecheck` — TypeScript type-check
3. `vite build` — build frontend assets
4. `wrangler deploy` — deploy to Cloudflare

Required secrets in GitHub repo:
- `CLOUDFLARE_API_TOKEN` — Workers deploy token
- `CLOUDFLARE_ACCOUNT_ID` — Account ID

## 8. Testing Strategy

Given the Cloudflare Workers runtime, testing uses:

- **Unit tests**: Vitest for pure functions (slug generation, tool logic)
- **Integration tests**: `wrangler dev` + fetch for E2E (manual / future)

No test infrastructure exists yet; future issues will add Vitest tests.

## 9. Known Limitations (v1)

- PDF parsing is not supported (text/markdown only)
- No authentication (wiki is private by security-through-obscurity of URL)
- Vectorize quota: 5M vectors free tier; large wikis may exceed this
- Workers AI rate limits may slow down large ingestion batches
- Dynamic Worker Loaders is currently in open beta

## 10. Future Work

- PDF ingestion via Workers AI Document AI
- Multi-user support with authentication (Cloudflare Access)
- Export wiki to Obsidian vault (zip download)
- Scheduled re-processing (Cloudflare Cron Triggers)
- GitHub integration: commit wiki articles to a repo
