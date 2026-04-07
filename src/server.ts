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
import { initWikiDatabase, createWikiTools } from "./wiki-tools";
import { createIngestTools } from "./ingest-tools";

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

// --- WikiAgent DurableObject ---
export class WikiAgent extends AIChatAgent<Env> {
  tools!: ReturnType<typeof createWikiTools> & ReturnType<typeof createIngestTools>;

  async onStart() {
    initWikiDatabase(this.ctx.storage.sql);
    this.tools = {
      ...createWikiTools(this.ctx.storage.sql, this.env),
      ...createIngestTools(this.ctx.storage.sql, this.env)
    };
  }

  @callable({ description: "Get TypeScript type definitions for all wiki tools" })
  getToolTypes() {
    return generateTypes(this.tools);
  }

  @callable({ description: "List wiki articles with optional search" })
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

  @callable({ description: "Get a single wiki article by slug" })
  async getArticleBySlug(slug: string) {
    return this.ctx.storage.sql
      .exec("SELECT * FROM articles WHERE slug = ?", slug)
      .toArray()[0] ?? null;
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
      `INSERT INTO raw_documents (id, filename, r2_key, content_type)
       VALUES (?, ?, ?, ?)`,
      id,
      filename,
      r2Key,
      contentType
    );
    return { id, filename, status: "pending" };
  }

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const executor = new DynamicWorkerExecutor({
      loader: this.env.LOADER
    });

    const codemode = createCodeTool({
      tools: this.tools,
      executor
    });

    const modelId = this.env.WORKERS_AI_MODEL ?? "@cf/moonshotai/kimi-k2.5";

    const result = streamText({
      model: workersai(modelId, {
        sessionAffinity: this.sessionAffinity
      }),
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

// --- Upload handler ---
async function handleUpload(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!env.RAW_DOCS) {
    return Response.json({ error: "R2 bucket not configured" }, { status: 503 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return Response.json({ error: "No file provided" }, { status: 400 });
  }

  // Validate content type
  const allowedTypes = [
    "text/plain",
    "text/markdown",
    "text/html",
    "application/pdf",
    "application/json"
  ];
  const contentType = file.type || "text/plain";
  const baseType = contentType.split(";")[0].trim();
  if (!allowedTypes.some((t) => baseType === t || baseType.startsWith("text/"))) {
    return Response.json(
      { error: `Unsupported file type: ${contentType}` },
      { status: 415 }
    );
  }

  const id = crypto.randomUUID();
  const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const r2Key = `docs/${id}/${safeFilename}`;

  try {
    await env.RAW_DOCS.put(r2Key, file.stream(), {
      httpMetadata: { contentType: baseType }
    });
  } catch (e) {
    return Response.json({ error: `R2 upload failed: ${String(e)}` }, { status: 500 });
  }

  // Register the document in the WikiAgent's SQLite via the callable method
  try {
    const stub = env.WikiAgent.get(env.WikiAgent.idFromName("default"));
    await (stub as unknown as { registerUploadedDocument: (id: string, filename: string, r2Key: string, contentType: string) => Promise<unknown> })
      .registerUploadedDocument(id, file.name, r2Key, baseType);
  } catch (e) {
    // Non-fatal: document is in R2, user can re-register
    console.error("Failed to register document in WikiAgent:", e);
  }

  return Response.json({
    id,
    filename: file.name,
    r2Key,
    contentType: baseType,
    status: "pending"
  });
}

// --- Health check ---
function handleHealth(): Response {
  return Response.json({ ok: true, timestamp: new Date().toISOString() });
}

// --- Main Worker ---
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return handleHealth();
    }

    if (url.pathname === "/api/upload") {
      return handleUpload(request, env);
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
