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

  // The wiki instance ID — stored in DO KV storage so it survives evictions.
  // Set on first write via initWikiId(); used for CDN cache eviction paths.
  private wikiId = "default";

  // Guard so that DB init runs at most once per DO activation, even when
  // callables are invoked via native DO RPC (which bypasses partyserver's
  // #ensureInitialized / onStart path).
  private _dbReady = false;

  private _ensureDb() {
    if (this._dbReady) return;
    initWikiDatabase(this.ctx.storage.sql);
    this._dbReady = true;
  }

  async onStart() {
    // Create/migrate SQL tables (idempotent — safe to run on every activation)
    this._ensureDb();

    // Recover wikiId from DO KV storage (set once per instance by initWikiId)
    const stored = await this.ctx.storage.get<string>("wikiId");
    if (stored) this.wikiId = stored;

    this.tools = {
      ...createWikiTools(this.ctx.storage.sql, this.env, this.wikiId),
      ...createIngestTools(this.ctx.storage.sql, this.env)
    };
  }

  // ── Callable: Chat tooling ─────────────────────────────────────────────────

  @callable({ description: "Get TypeScript type definitions for all wiki tools" })
  getToolTypes() {
    return generateTypes(this.tools);
  }

  // ── Callable: Wiki identity ───────────────────────────────────────────────

  /**
   * Store the wiki ID in this DO instance so that CDN eviction paths are
   * correct for named wikis (e.g. /wiki/research/article/...).
   * Idempotent — safe to call on every write path.
   */
  @callable({ description: "Initialize or confirm this wiki instance's ID" })
  async initWikiId(id: string): Promise<void> {
    if (this.wikiId !== id) {
      this.wikiId = id;
      await this.ctx.storage.put("wikiId", id);
      // Refresh tools so their eviction closures use the updated wikiId
      this.tools = {
        ...createWikiTools(this.ctx.storage.sql, this.env, id),
        ...createIngestTools(this.ctx.storage.sql, this.env)
      };
    }
  }

  // ── Callables: REST API ───────────────────────────────────────────────────

  @callable({ description: "List wiki articles with optional FTS search or tag filter" })
  async getArticles(search?: string, tag?: string) {
    this._ensureDb();
    const sql = this.ctx.storage.sql;
    if (tag) {
      return sql
        .exec(
          `SELECT id, title, slug, summary, tags, updated_at FROM articles
           WHERE tags LIKE ? ORDER BY updated_at DESC LIMIT 100`,
          `%"${tag}"%`
        )
        .toArray();
    }
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
    this._ensureDb();
    return (
      (this.ctx.storage.sql
        .exec("SELECT * FROM articles WHERE slug = ?", slug)
        .toArray()[0] as Record<string, unknown>) ?? null
    );
  }

  @callable({ description: "Get wiki statistics" })
  async getWikiStats() {
    this._ensureDb();
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
    this._ensureDb();
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
    this._ensureDb();
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
    this._ensureDb();
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
    this._ensureDb();
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
    this._ensureDb();
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
    this._ensureDb();
    return this.ctx.storage.sql
      .exec("SELECT id, title, slug, content, summary, tags, updated_at FROM articles ORDER BY updated_at DESC")
      .toArray();
  }

  @callable({ description: "Get a single raw document by ID" })
  async getDocumentProgrammatic(id: string) {
    this._ensureDb();
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
    this._ensureDb();
    this.ctx.storage.sql.exec(
      "UPDATE raw_documents SET status = 'processing' WHERE id = ?",
      id
    );
  }

  @callable({ description: "Mark document as done with article IDs" })
  async markDocumentDoneProgrammatic(id: string, articleIds: string[]) {
    this._ensureDb();
    this.ctx.storage.sql.exec(
      "UPDATE raw_documents SET status = 'done', processed_ids = ?, processed_at = datetime('now') WHERE id = ?",
      JSON.stringify(articleIds),
      id
    );
  }

  @callable({ description: "Mark document as failed with error message" })
  async markDocumentErrorProgrammatic(id: string, error: string) {
    this._ensureDb();
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
    await cm.evictArticle(slug, this.wikiId);
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

// ── Auth middleware ───────────────────────────────────────────────────────────

/**
 * Check `Authorization: Bearer <key>` against env.API_KEY.
 * Returns a 401 Response when auth fails, null when auth passes or is not configured.
 * Reads (GET) are intentionally not protected here — use Cloudflare Access for
 * full protection including the /agents/* WebSocket endpoints.
 */
function checkAuth(request: Request, env: Env): Response | null {
  const apiKey = env.API_KEY;
  if (!apiKey) return null; // No API key configured → open access
  const auth = request.headers.get("Authorization");
  if (!auth || auth !== `Bearer ${apiKey}`) {
    return jsonResponse(
      { error: "Unauthorized — supply Authorization: Bearer <API_KEY>" },
      { status: 401 }
    );
  }
  return null;
}

// ── DO stub helpers ───────────────────────────────────────────────────────────

type WikiStub = InstanceType<typeof WikiAgent>;

function getWikiStub(env: Env, wikiId: string): WikiStub {
  return env.WikiAgent.get(
    env.WikiAgent.idFromName(wikiId)
  ) as unknown as WikiStub;
}

// ── REST route handlers ───────────────────────────────────────────────────────

async function handleHealth(): Promise<Response> {
  return jsonResponse({ ok: true, timestamp: new Date().toISOString() });
}

async function handleGetArticles(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  wikiId: string
): Promise<Response> {
  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? undefined;
  const cachePath = search
    ? `/wiki/${wikiId}/articles?search=${encodeURIComponent(search)}`
    : `/wiki/${wikiId}/articles`;
  const cm = WikiCacheManager.fromRequest(request);

  return serveCached(
    request,
    cm,
    cachePath,
    async () => {
      const stub = getWikiStub(env, wikiId);
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
  wikiId: string,
  slug: string
): Promise<Response> {
  const cachePath = `/wiki/${wikiId}/article/${slug}`;
  const cm = WikiCacheManager.fromRequest(request);

  return serveCached(
    request,
    cm,
    cachePath,
    async () => {
      const stub = getWikiStub(env, wikiId);
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
  ctx: ExecutionContext,
  wikiId: string
): Promise<Response> {
  const cachePath = `/wiki/${wikiId}/stats`;
  const cm = WikiCacheManager.fromRequest(request);

  return serveCached(
    request,
    cm,
    cachePath,
    async () => {
      const stub = getWikiStub(env, wikiId);
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
  env: Env,
  wikiId: string
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }
  const stub = getWikiStub(env, wikiId);
  const docs = await stub.getRawDocuments();
  return jsonResponse(docs, { maxAge: 0 });
}

async function handleCreateArticle(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  wikiId: string
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { title, content, summary, tags, sourceIds } = body;
  if (typeof title !== "string" || !title.trim()) {
    return jsonResponse({ error: "title is required" }, { status: 400 });
  }
  if (typeof content !== "string" || !content.trim()) {
    return jsonResponse({ error: "content is required" }, { status: 400 });
  }
  try {
    const stub = getWikiStub(env, wikiId);
    const result = await stub.createArticleProgrammatic(
      title,
      content,
      typeof summary === "string" ? summary : "",
      Array.isArray(tags) ? tags as string[] : [],
      Array.isArray(sourceIds) ? sourceIds as string[] : []
    );
    ctx.waitUntil(WikiCacheManager.fromRequest(request).evictAll(wikiId));
    return jsonResponse(result, { status: 201 });
  } catch (e) {
    return jsonResponse({ error: String(e) }, { status: 500 });
  }
}

async function handleUpload(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  wikiId: string
): Promise<Response> {
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
  const r2Key = `${wikiId}/docs/${id}/${safeFilename}`;

  try {
    await env.RAW_DOCS.put(r2Key, file.stream(), {
      httpMetadata: { contentType: baseType }
    });
  } catch (e) {
    return jsonResponse({ error: `R2 upload failed: ${String(e)}` }, { status: 500 });
  }

  try {
    const stub = getWikiStub(env, wikiId);
    await stub.registerUploadedDocument(id, file.name, r2Key, baseType);
    // Evict stats cache so pendingDocuments reflects the new upload immediately
    ctx.waitUntil(WikiCacheManager.fromRequest(request).evictAll(wikiId));
  } catch (e) {
    console.error("Failed to register document in WikiAgent:", e);
  }

  return jsonResponse({ id, filename: file.name, r2Key, contentType: baseType, status: "pending", wikiId }, { status: 201 });
}

async function handleIngest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  wikiId: string,
  docId: string
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }
  const stub = env.IngestAgent.get(
    env.IngestAgent.idFromName(`ingest-${wikiId}-${docId}`)
  ) as unknown as { processDocument(id: string, wikiId: string): Promise<unknown> };

  ctx.waitUntil(
    stub.processDocument(docId, wikiId).catch((e) =>
      console.error(`IngestAgent failed for ${wikiId}/${docId}:`, e)
    )
  );

  return jsonResponse({ queued: true, documentId: docId, wikiId });
}

async function handleLint(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  wikiId: string
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }
  const body = await request.json().catch(() => ({})) as { fix?: boolean };
  const fix = body.fix === true;

  const stub = env.LintAgent.get(
    env.LintAgent.idFromName(`lint-${wikiId}`)
  ) as unknown as { lintWiki(fix: boolean, wikiId: string): Promise<LintReport> };

  try {
    const report = await stub.lintWiki(fix, wikiId);
    if (fix && report.fixesApplied > 0) {
      const cm = WikiCacheManager.fromRequest(request);
      ctx.waitUntil(cm.evictAll(wikiId));
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

    // ── Health (no auth required) ────────────────────────────────────────────
    if (pathname === "/health") return handleHealth();

    // ── Agent WebSocket + RPC: /agents/:agent/:id ────────────────────────────
    // routeAgentRequest handles WebSocket upgrades for the chat UI.
    // Protect with Cloudflare Access for production deployments.
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // ── /wiki/:wikiId/<resource> ─────────────────────────────────────────────
    // All wiki REST + MCP endpoints live under a wikiId path segment.
    // This enables multiple independent wikis from a single Worker deployment.
    const wikiMatch = pathname.match(/^\/wiki\/([^/]+)(\/.*)?$/);
    if (wikiMatch) {
      const wikiId = wikiMatch[1];
      const sub = wikiMatch[2] ?? "/";

      // Auth check on all write operations and MCP endpoints
      const isMcp = sub === "/mcp" || sub.startsWith("/mcp/") ||
                    sub === "/codemode-mcp" || sub.startsWith("/codemode-mcp/");
      const isWrite = request.method !== "GET";
      if (isWrite || isMcp) {
        const authErr = checkAuth(request, env);
        if (authErr) return authErr;
      }

      // ── CDN-cached reads and /articles POST ─────────────────────────────
      if (sub === "/articles" || sub === "/articles/") {
        if (request.method === "POST") return handleCreateArticle(request, env, ctx, wikiId);
        return handleGetArticles(request, env, ctx, wikiId);
      }
      const articleMatch = sub.match(/^\/article\/(.+)$/);
      if (articleMatch) {
        return handleGetArticle(request, env, ctx, wikiId, articleMatch[1]);
      }
      if (sub === "/stats") {
        return handleGetStats(request, env, ctx, wikiId);
      }
      if (sub === "/documents") {
        return handleGetDocuments(request, env, wikiId);
      }

      // ── Write paths (no CDN cache, auth required above) ──────────────────
      if (sub === "/upload") return handleUpload(request, env, ctx, wikiId);
      const ingestMatch = sub.match(/^\/ingest\/(.+)$/);
      if (ingestMatch) return handleIngest(request, env, ctx, wikiId, ingestMatch[1]);
      if (sub === "/lint") return handleLint(request, env, ctx, wikiId);

      // ── MCP endpoints (per-wiki, auth required above) ────────────────────
      const mcpHandlers = createMcpHandlers(
        env,
        WikiCacheManager.fromRequest(request),
        wikiId
      );
      if (sub === "/mcp" || sub.startsWith("/mcp/")) {
        return mcpHandlers.handleMcp(request, ctx);
      }
      if (sub === "/codemode-mcp" || sub.startsWith("/codemode-mcp/")) {
        return mcpHandlers.handleCodemodeMcp(request, ctx);
      }

      return jsonResponse({ error: "Not found" }, { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  },

  // ── Scheduled trigger: daily cron lint ──────────────────────────────────
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Fan-out to LintAgent for the default wiki.
    // To lint additional named wikis, maintain a registry in a KV or enumerate
    // DO names — for now the default wiki covers the primary use case.
    const stub = env.LintAgent.get(
      env.LintAgent.idFromName("lint-default")
    ) as unknown as { lintWiki(fix: boolean, wikiId: string): Promise<unknown> };
    ctx.waitUntil(
      stub.lintWiki(false, "default").catch((e) =>
        console.error("Scheduled lint failed for wiki/default:", e)
      )
    );
  }
} satisfies ExportedHandler<Env>;
