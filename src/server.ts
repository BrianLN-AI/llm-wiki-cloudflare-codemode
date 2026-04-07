import { routeAgentRequest, callable } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createCodeTool, generateTypes } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import {
  streamText,
  stepCountIs,
  convertToModelMessages,
  pruneMessages
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { initWikiDatabase, createWikiTools, slugify } from "./wiki-tools";
import { createIngestTools } from "./ingest-tools";
import {
  WikiCacheManager,
  makeETag,
  checkConditional,
  jsonResponse,
  serveCached,
  CACHE_TTL
} from "./cache";
import { createMcpHandlers } from "./mcp-server";
import type { LintReport } from "./agents/lint-agent";

export { IngestAgent } from "./agents/ingest-agent";
export { LintAgent } from "./agents/lint-agent";

// --- System prompt ---
const WIKI_SYSTEM_PROMPT = `You are a personal knowledge wiki assistant. You maintain a structured, interconnected wiki that grows richer over time.

**When processing documents:**
- Read the full document content using getRawDocumentContent
- Extract the most important concepts and create one wiki article per major concept
- Write articles in clear prose with markdown formatting (headings, lists, code blocks as appropriate)
- Always add [[wiki links]] in article content to related articles using the exact title
- Write a one-paragraph summary for each article
- Call markDocumentDone when finished, passing all article IDs you created

**When answering questions:**
- Search the wiki first using vectorSearch and/or searchArticles to find relevant articles
- Retrieve the full content of the most relevant articles with getArticle
- Synthesize a clear, cited answer from multiple articles when needed
- Always mention which articles you drew from
- If no relevant articles exist, say so clearly and suggest what kinds of content to upload

**When linting the wiki:**
- Call getWikiStats to see the overall state
- Find articles missing summaries and add them via updateArticle
- Find orphaned articles (no links) using getLinkedArticles and suggest connections
- Find duplicate concepts and propose merging them
- Check for broken [[wiki links]] and fix them with linkArticles

**Formatting:**
- Use markdown in your responses
- When creating or discussing articles, show their titles as \`**[[Article Title]]**\`
- When citing sources, use numbered footnotes like [^1]`;

// ── WikiAgent DurableObject ────────────────────────────────────────────────────

export class WikiAgent extends AIChatAgent<Env> {
  tools!: ReturnType<typeof createWikiTools> & ReturnType<typeof createIngestTools>;

  async onStart() {
    initWikiDatabase(this.ctx.storage.sql);
    this.tools = {
      ...createWikiTools(this.ctx.storage.sql, this.env),
      ...createIngestTools(this.ctx.storage.sql, this.env)
    };
  }

  // ── Callable: Chat tooling ─────────────────────────────────────────────────

  @callable({ description: "Get TypeScript type definitions for all wiki tools" })
  getToolTypes() {
    return generateTypes(this.tools);
  }

  // ── Callables: REST API ───────────────────────────────────────────────────

  @callable({ description: "List wiki articles with optional FTS search" })
  async getArticles(search?: string) {
    const sql = this.ctx.storage.sql;
    if (search) {
      try {
        return sql
          .exec(
            `SELECT id, title, slug, summary, tags, updated_at
             FROM articles a
             JOIN articles_fts fts ON a.rowid = fts.rowid
             WHERE articles_fts MATCH ?
             ORDER BY rank LIMIT 50`,
            search
          )
          .toArray();
      } catch {
        return sql
          .exec(
            `SELECT id, title, slug, summary, tags, updated_at FROM articles
             WHERE title LIKE ? OR summary LIKE ?
             ORDER BY updated_at DESC LIMIT 50`,
            `%${search}%`,
            `%${search}%`
          )
          .toArray();
      }
    }
    return sql
      .exec(
        "SELECT id, title, slug, summary, tags, updated_at FROM articles ORDER BY updated_at DESC LIMIT 100"
      )
      .toArray();
  }

  @callable({ description: "Get a single wiki article by slug (full content)" })
  async getArticleBySlug(slug: string) {
    return (
      (this.ctx.storage.sql
        .exec("SELECT * FROM articles WHERE slug = ?", slug)
        .toArray()[0] as Record<string, unknown>) ?? null
    );
  }

  @callable({ description: "Get wiki statistics" })
  async getWikiStats() {
    const sql = this.ctx.storage.sql;
    const articles = (
      sql.exec("SELECT COUNT(*) as count FROM articles").toArray()[0] as {
        count: number;
      }
    ).count;
    const links = (
      sql.exec("SELECT COUNT(*) as count FROM article_links").toArray()[0] as {
        count: number;
      }
    ).count;
    const docs = (
      sql
        .exec("SELECT COUNT(*) as count FROM raw_documents")
        .toArray()[0] as { count: number }
    ).count;
    const pending = (
      sql
        .exec(
          "SELECT COUNT(*) as count FROM raw_documents WHERE status = 'pending'"
        )
        .toArray()[0] as { count: number }
    ).count;
    return { articles, links, documents: docs, pendingDocuments: pending };
  }

  @callable({ description: "Get raw documents list" })
  async getRawDocuments() {
    return this.ctx.storage.sql
      .exec(
        "SELECT id, filename, content_type, status, error_message, uploaded_at, processed_at FROM raw_documents ORDER BY uploaded_at DESC"
      )
      .toArray();
  }

  @callable({ description: "Register a newly uploaded document" })
  async registerUploadedDocument(
    id: string,
    filename: string,
    r2Key: string,
    contentType: string
  ) {
    this.ctx.storage.sql.exec(
      `INSERT INTO raw_documents (id, filename, r2_key, content_type) VALUES (?, ?, ?, ?)`,
      id,
      filename,
      r2Key,
      contentType
    );
    return { id, filename, status: "pending" };
  }

  // ── Callables: Programmatic writes (used by IngestAgent, LintAgent, MCP) ──

  @callable({ description: "Create a wiki article programmatically" })
  async createArticleProgrammatic(
    title: string,
    content: string,
    summary: string,
    tags: string[],
    sourceIds: string[]
  ) {
    const id = crypto.randomUUID();
    const slug = slugify(title);
    const existing = this.ctx.storage.sql
      .exec("SELECT id FROM articles WHERE slug = ?", slug)
      .toArray();
    const finalSlug = existing.length > 0 ? `${slug}-${id.slice(0, 8)}` : slug;

    this.ctx.storage.sql.exec(
      `INSERT INTO articles (id, title, slug, content, summary, tags, source_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      title,
      finalSlug,
      content,
      summary,
      JSON.stringify(tags),
      JSON.stringify(sourceIds)
    );

    await this.evictCacheForSlug(finalSlug);
    return { id, title, slug: finalSlug };
  }

  @callable({ description: "Update a wiki article programmatically" })
  async updateArticleProgrammatic(
    idOrSlug: string,
    fields: Record<string, unknown>
  ) {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        idOrSlug
      );
    const row = isUuid
      ? (this.ctx.storage.sql
          .exec("SELECT * FROM articles WHERE id = ?", idOrSlug)
          .toArray()[0] as Record<string, unknown> | undefined)
      : (this.ctx.storage.sql
          .exec("SELECT * FROM articles WHERE slug = ?", idOrSlug)
          .toArray()[0] as Record<string, unknown> | undefined);
    if (!row) return { error: "Article not found" };

    const colMap: Record<string, string> = {
      title: "title",
      content: "content",
      summary: "summary"
    };
    const sets: string[] = [];
    const params: unknown[] = [];

    for (const [key, col] of Object.entries(colMap)) {
      if (fields[key] !== undefined) {
        sets.push(`${col} = ?`);
        params.push(fields[key]);
      }
    }
    if (fields.tags !== undefined) {
      sets.push("tags = ?");
      params.push(JSON.stringify(fields.tags));
    }
    if (fields.appendContent !== undefined) {
      sets.push("content = content || ?");
      params.push("\n\n" + fields.appendContent);
    }
    if (sets.length === 0) return { error: "No fields to update" };
    sets.push("updated_at = datetime('now')");
    params.push(row.id);
    this.ctx.storage.sql.exec(
      `UPDATE articles SET ${sets.join(", ")} WHERE id = ?`,
      ...params
    );

    await this.evictCacheForSlug(String(row.slug));
    return this.ctx.storage.sql
      .exec("SELECT * FROM articles WHERE id = ?", row.id)
      .toArray()[0];
  }

  @callable({ description: "Delete a wiki article programmatically" })
  async deleteArticleProgrammatic(idOrSlug: string) {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        idOrSlug
      );
    const row = isUuid
      ? (this.ctx.storage.sql
          .exec("SELECT id, slug FROM articles WHERE id = ?", idOrSlug)
          .toArray()[0] as { id: string; slug: string } | undefined)
      : (this.ctx.storage.sql
          .exec("SELECT id, slug FROM articles WHERE slug = ?", idOrSlug)
          .toArray()[0] as { id: string; slug: string } | undefined);
    if (!row) return { error: "Article not found" };

    this.ctx.storage.sql.exec(
      "DELETE FROM article_links WHERE from_slug = ? OR to_slug = ?",
      row.slug,
      row.slug
    );
    this.ctx.storage.sql.exec("DELETE FROM articles WHERE id = ?", row.id);
    await this.evictCacheForSlug(row.slug);
    return { deleted: row.id };
  }

  @callable({ description: "Get all articles for lint scan" })
  async getAllArticlesForLint() {
    return this.ctx.storage.sql
      .exec("SELECT id, title, slug, content, summary, tags, updated_at FROM articles ORDER BY updated_at DESC")
      .toArray();
  }

  @callable({ description: "Get a single raw document by ID" })
  async getDocumentProgrammatic(id: string) {
    return (
      (this.ctx.storage.sql
        .exec(
          "SELECT id, filename, r2_key, content_type, status FROM raw_documents WHERE id = ?",
          id
        )
        .toArray()[0] as Record<string, unknown>) ?? null
    );
  }

  @callable({ description: "Mark document as processing" })
  async markDocumentProcessingProgrammatic(id: string) {
    this.ctx.storage.sql.exec(
      "UPDATE raw_documents SET status = 'processing' WHERE id = ?",
      id
    );
  }

  @callable({ description: "Mark document as done with article IDs" })
  async markDocumentDoneProgrammatic(id: string, articleIds: string[]) {
    this.ctx.storage.sql.exec(
      "UPDATE raw_documents SET status = 'done', processed_ids = ?, processed_at = datetime('now') WHERE id = ?",
      JSON.stringify(articleIds),
      id
    );
  }

  @callable({ description: "Mark document as failed with error message" })
  async markDocumentErrorProgrammatic(id: string, error: string) {
    this.ctx.storage.sql.exec(
      "UPDATE raw_documents SET status = 'error', error_message = ?, processed_at = datetime('now') WHERE id = ?",
      error,
      id
    );
  }

  // ── Cache eviction helper ─────────────────────────────────────────────────

  private async evictCacheForSlug(slug: string) {
    const host = this.env.HOST;
    if (!host) return;
    const origin = host.startsWith("http") ? host : `https://${host}`;
    const cm = new WikiCacheManager(origin);
    await cm.evictArticle(slug);
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    const codemode = createCodeTool({ tools: this.tools, executor });
    const modelId = this.env.WORKERS_AI_MODEL ?? "@cf/moonshotai/kimi-k2.5";

    const result = streamText({
      model: workersai(modelId, { sessionAffinity: this.sessionAffinity }),
      system: WIKI_SYSTEM_PROMPT,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: { codemode },
      stopWhen: stepCountIs(15)
    });

    return result.toUIMessageStreamResponse();
  }
}

// ── REST route handlers ───────────────────────────────────────────────────────

type WikiStub = InstanceType<typeof WikiAgent>;

async function handleHealth(): Promise<Response> {
  return jsonResponse({ ok: true, timestamp: new Date().toISOString() });
}

async function handleGetArticles(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? undefined;
  const cachePath = search
    ? `/api/articles?search=${encodeURIComponent(search)}`
    : "/api/articles";
  const cm = WikiCacheManager.fromRequest(request);

  return serveCached(
    request,
    cm,
    cachePath,
    async () => {
      const stub = env.WikiAgent.get(
        env.WikiAgent.idFromName("default")
      ) as unknown as WikiStub;
      const articles = await stub.getArticles(search);
      const lastMod = (articles[0] as { updated_at?: string } | undefined)
        ?.updated_at ?? new Date().toISOString();
      return jsonResponse(articles, {
        etag: makeETag(lastMod),
        lastModified: lastMod,
        maxAge: search ? 30 : CACHE_TTL.articleList,
        swr: search ? 120 : CACHE_TTL.swr.articleList
      });
    },
    ctx
  );
}

async function handleGetArticle(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  slug: string
): Promise<Response> {
  const cachePath = `/api/article/${slug}`;
  const cm = WikiCacheManager.fromRequest(request);

  return serveCached(
    request,
    cm,
    cachePath,
    async () => {
      const stub = env.WikiAgent.get(
        env.WikiAgent.idFromName("default")
      ) as unknown as WikiStub;
      const article = await stub.getArticleBySlug(slug);
      if (!article) {
        return jsonResponse({ error: "Not found" }, { status: 404 });
      }
      const row = article as { updated_at: string };
      const etag = makeETag(row.updated_at);
      const cond = checkConditional(request, etag, row.updated_at);
      if (cond) return cond;
      return jsonResponse(article, {
        etag,
        lastModified: row.updated_at,
        maxAge: CACHE_TTL.article,
        swr: CACHE_TTL.swr.article
      });
    },
    ctx
  );
}

async function handleGetStats(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const cachePath = "/api/stats";
  const cm = WikiCacheManager.fromRequest(request);

  return serveCached(
    request,
    cm,
    cachePath,
    async () => {
      const stub = env.WikiAgent.get(
        env.WikiAgent.idFromName("default")
      ) as unknown as WikiStub;
      const stats = await stub.getWikiStats();
      const now = new Date().toISOString();
      return jsonResponse(stats, {
        maxAge: CACHE_TTL.stats,
        swr: CACHE_TTL.swr.stats,
        etag: makeETag(now)
      });
    },
    ctx
  );
}

async function handleGetDocuments(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }
  const stub = env.WikiAgent.get(
    env.WikiAgent.idFromName("default")
  ) as unknown as WikiStub;
  const docs = await stub.getRawDocuments();
  // Documents are private — no CDN caching
  return jsonResponse(docs, { maxAge: 0 });
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }
  if (!env.RAW_DOCS) {
    return jsonResponse({ error: "R2 bucket not configured" }, { status: 503 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return jsonResponse({ error: "No file provided" }, { status: 400 });
  }

  const contentType = file.type || "text/plain";
  const baseType = contentType.split(";")[0].trim();
  if (!baseType.startsWith("text/") && !["application/pdf", "application/json"].includes(baseType)) {
    return jsonResponse({ error: `Unsupported file type: ${contentType}` }, { status: 415 });
  }

  const id = crypto.randomUUID();
  const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const r2Key = `docs/${id}/${safeFilename}`;

  try {
    await env.RAW_DOCS.put(r2Key, file.stream(), {
      httpMetadata: { contentType: baseType }
    });
  } catch (e) {
    return jsonResponse({ error: `R2 upload failed: ${String(e)}` }, { status: 500 });
  }

  try {
    const stub = env.WikiAgent.get(
      env.WikiAgent.idFromName("default")
    ) as unknown as WikiStub;
    await stub.registerUploadedDocument(id, file.name, r2Key, baseType);
  } catch (e) {
    console.error("Failed to register document in WikiAgent:", e);
  }

  return jsonResponse({ id, filename: file.name, r2Key, contentType: baseType, status: "pending" }, { status: 201 });
}

async function handleIngest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  docId: string
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }
  // Fire and forget — IngestAgent processes asynchronously
  const stub = env.IngestAgent.get(
    env.IngestAgent.idFromName(`ingest-${docId}`)
  ) as unknown as { processDocument(id: string): Promise<unknown> };

  ctx.waitUntil(
    stub.processDocument(docId).catch((e) =>
      console.error(`IngestAgent failed for ${docId}:`, e)
    )
  );

  return jsonResponse({ queued: true, documentId: docId });
}

async function handleLint(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }
  const body = await request.json().catch(() => ({})) as { fix?: boolean };
  const fix = body.fix === true;

  const stub = env.LintAgent.get(
    env.LintAgent.idFromName("default")
  ) as unknown as { lintWiki(fix: boolean): Promise<LintReport> };

  // Run synchronously so the caller gets the report
  try {
    const report = await stub.lintWiki(fix);
    // After lint fixes, evict the full article list from CDN cache
    if (fix && report.fixesApplied > 0) {
      const cm = WikiCacheManager.fromRequest(request);
      ctx.waitUntil(cm.evictAll());
    }
    return jsonResponse(report);
  } catch (e) {
    return jsonResponse({ error: String(e) }, { status: 500 });
  }
}

// ── Main Worker ───────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // ── Health ──────────────────────────────────────────────────────────────
    if (pathname === "/api/health") return handleHealth();

    // ── MCP endpoints (no caching — streaming protocol) ─────────────────────
    const mcpHandlers = createMcpHandlers(
      env,
      WikiCacheManager.fromRequest(request)
    );
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      return mcpHandlers.handleMcp(request, ctx);
    }
    if (pathname === "/codemode-mcp" || pathname.startsWith("/codemode-mcp/")) {
      return mcpHandlers.handleCodemodeMcp(request, ctx);
    }

    // ── REST API (CDN-cached reads, no-store writes) ─────────────────────────
    if (pathname === "/api/stats") return handleGetStats(request, env, ctx);
    if (pathname === "/api/articles") return handleGetArticles(request, env, ctx);

    const articleMatch = pathname.match(/^\/api\/article\/(.+)$/);
    if (articleMatch) {
      return handleGetArticle(request, env, ctx, articleMatch[1]);
    }

    if (pathname === "/api/documents") return handleGetDocuments(request, env);
    if (pathname === "/api/upload") return handleUpload(request, env);

    const ingestMatch = pathname.match(/^\/api\/ingest\/(.+)$/);
    if (ingestMatch) return handleIngest(request, env, ctx, ingestMatch[1]);

    if (pathname === "/api/lint") return handleLint(request, env, ctx);

    // ── Agent WebSocket + RPC (chat) ─────────────────────────────────────────
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
