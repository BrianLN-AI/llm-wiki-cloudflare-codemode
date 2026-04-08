/**
 * WikiMcpServer
 *
 * A stateless MCP server factory. Exposes the wiki as an MCP server with:
 *   - Read tools:  wiki_search, wiki_get_article, wiki_list_articles, wiki_get_stats
 *   - Write tools: wiki_create_article, wiki_update_article, wiki_delete_article
 *   - Doc tools:   wiki_list_documents, wiki_process_document, wiki_lint
 *
 * Mounted at two endpoints:
 *   /mcp            → raw tool calling (traditional MCP)
 *   /codemode-mcp   → CodeMode-wrapped (LLM writes TypeScript that calls tools)
 *
 * Both endpoints talk to the same WikiAgent DurableObject for persistence.
 */

import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { codeMcpServer } from "@cloudflare/codemode/mcp";
import { z } from "zod";
import { WikiCacheManager } from "./cache";

// ── MCP Resource URI scheme ───────────────────────────────────────────────────
// wiki://articles/{slug}   — individual article
// wiki://stats             — wiki statistics

// ── Tool result helpers ───────────────────────────────────────────────────────

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2)
      }
    ]
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true
  };
}

// ── Server factory ────────────────────────────────────────────────────────────

type WikiAgentStub = {
  getArticles(search?: string, tag?: string): Promise<unknown[]>;
  getArticleBySlug(slug: string): Promise<unknown>;
  getRawDocuments(): Promise<unknown[]>;
  registerUploadedDocument(
    id: string,
    filename: string,
    r2Key: string,
    contentType: string
  ): Promise<unknown>;
  createArticleProgrammatic(
    title: string,
    content: string,
    summary: string,
    tags: string[],
    sourceIds: string[]
  ): Promise<unknown>;
  updateArticleProgrammatic(
    idOrSlug: string,
    fields: Record<string, unknown>
  ): Promise<unknown>;
  deleteArticleProgrammatic(idOrSlug: string): Promise<unknown>;
  getWikiStats(): Promise<unknown>;
};

type IngestStub = {
  processDocument(docId: string, wikiId: string): Promise<unknown>;
};

type LintStub = {
  lintWiki(fix: boolean, wikiId: string): Promise<unknown>;
};

export function createWikiMcpServer(
  wikiStub: WikiAgentStub,
  cache?: WikiCacheManager,
  wikiId = "default",
  env?: Env,
  ctx?: ExecutionContext
): McpServer {
  const server = new McpServer({
    name: "llm-wiki",
    version: "1.0.0"
  });

  // ── Resources ──────────────────────────────────────────────────────────────

  server.registerResource(
    "wiki-article",
    "wiki://articles/{slug}",
    {
      title: "Wiki Article",
      description: "Read a wiki article by its slug",
      mimeType: "text/markdown"
    },
    async (uri) => {
      const slug = uri.pathname.replace(/^\/+/, "");
      const article = await wikiStub.getArticleBySlug(slug) as Record<string, unknown> | null;
      if (!article) {
        return { contents: [{ uri: uri.href, text: `Article '${slug}' not found`, mimeType: "text/plain" }] };
      }
      return {
        contents: [
          {
            uri: uri.href,
            text: `# ${article.title}\n\n${article.content}`,
            mimeType: "text/markdown"
          }
        ]
      };
    }
  );

  server.registerResource(
    "wiki-stats",
    "wiki://stats",
    {
      title: "Wiki Statistics",
      description: "Overall statistics about the wiki",
      mimeType: "application/json"
    },
    async (uri) => {
      const stats = await wikiStub.getWikiStats();
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(stats, null, 2),
            mimeType: "application/json"
          }
        ]
      };
    }
  );

  // ── Read tools ─────────────────────────────────────────────────────────────

  server.registerTool(
    "wiki_search",
    {
      description:
        "Search wiki articles by keyword or concept. Returns matching articles with titles and summaries.",
      inputSchema: {
        query: z.string().describe("Search query (keywords or a question)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results to return (default 10)")
      }
    },
    async ({ query, limit: _limit }) => {
      try {
        const results = await wikiStub.getArticles(query);
        return textResult(results);
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  server.registerTool(
    "wiki_list_articles",
    {
      description: "List all wiki articles. Returns titles, slugs, summaries and tags.",
      inputSchema: {
        tag: z
          .string()
          .optional()
          .describe("Filter articles by tag")
      }
    },
    async ({ tag }) => {
      try {
        const articles = await wikiStub.getArticles(undefined, tag);
        return textResult(articles);
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  server.registerTool(
    "wiki_get_article",
    {
      description:
        "Get the full content of a specific wiki article by its slug.",
      inputSchema: {
        slug: z
          .string()
          .describe(
            "Article slug (URL-safe lowercase title, e.g. 'attention-mechanism')"
          )
      }
    },
    async ({ slug }) => {
      try {
        const article = await wikiStub.getArticleBySlug(slug);
        if (!article) return errorResult(`Article '${slug}' not found`);
        return textResult(article);
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  server.registerTool(
    "wiki_get_stats",
    {
      description:
        "Get overall statistics: number of articles, links, documents, and pending ingestions.",
      inputSchema: {}
    },
    async () => {
      try {
        const stats = await wikiStub.getWikiStats();
        return textResult(stats);
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  // ── Write tools ────────────────────────────────────────────────────────────

  server.registerTool(
    "wiki_create_article",
    {
      description:
        "Create a new wiki article. Use [[Other Article Title]] syntax for wiki links.",
      inputSchema: {
        title: z.string().describe("Article title"),
        content: z.string().describe("Full article content in markdown"),
        summary: z
          .string()
          .optional()
          .describe("One-paragraph summary (auto-generated if omitted)"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Topic tags, e.g. ['machine-learning', 'transformers']"),
        sourceIds: z
          .array(z.string())
          .optional()
          .describe("IDs of raw documents this article was derived from")
      }
    },
    async ({ title, content, summary, tags, sourceIds }) => {
      try {
        const result = await wikiStub.createArticleProgrammatic(
          title,
          content,
          summary ?? "",
          tags ?? [],
          sourceIds ?? []
        );
        // Evict list + stats caches after write
        if (cache) {
          const article = result as { slug?: string };
          if (article.slug) await cache.evictArticle(article.slug, wikiId);
        }
        return textResult(result);
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  server.registerTool(
    "wiki_update_article",
    {
      description: "Update an existing wiki article's fields.",
      inputSchema: {
        slug: z.string().describe("Article slug to update"),
        title: z.string().optional().describe("New title"),
        content: z.string().optional().describe("New content (replaces existing)"),
        appendContent: z.string().optional().describe("Append to existing content"),
        summary: z.string().optional().describe("New summary"),
        tags: z.array(z.string()).optional().describe("New tags (replaces existing)")
      }
    },
    async ({ slug, ...fields }) => {
      try {
        const result = await wikiStub.updateArticleProgrammatic(slug, fields);
        if (cache) await cache.evictArticle(slug, wikiId);
        return textResult(result);
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  server.registerTool(
    "wiki_delete_article",
    {
      description: "Delete a wiki article and all its links.",
      inputSchema: {
        slug: z.string().describe("Slug of the article to delete")
      }
    },
    async ({ slug }) => {
      try {
        const result = await wikiStub.deleteArticleProgrammatic(slug);
        if (cache) await cache.evictArticle(slug, wikiId);
        return textResult(result);
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  // ── Document tools ─────────────────────────────────────────────────────────

  server.registerTool(
    "wiki_list_documents",
    {
      description:
        "List all uploaded raw documents with their processing status (pending/processing/done/error).",
      inputSchema: {}
    },
    async () => {
      try {
        const docs = await wikiStub.getRawDocuments();
        return textResult(docs);
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  server.registerTool(
    "wiki_process_document",
    {
      description:
        "Trigger background AI processing of a pending raw document. The IngestAgent will extract concepts and create wiki articles.",
      inputSchema: {
        documentId: z.string().describe("ID of the raw document to process")
      }
    },
    async ({ documentId }) => {
      if (!env) return errorResult("Server not configured for document processing");
      try {
        const ingestStub = env.IngestAgent.get(
          env.IngestAgent.idFromName(`ingest-${wikiId}-${documentId}`)
        ) as unknown as IngestStub;
        const work = ingestStub
          .processDocument(documentId, wikiId)
          .catch((e) => console.error(`IngestAgent failed for ${wikiId}/${documentId}:`, e));
        if (ctx) ctx.waitUntil(work); else void work;
        return textResult({
          queued: true,
          documentId,
          wikiId,
          message: "Document queued for processing. Use wiki_list_documents to check status."
        });
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  server.registerTool(
    "wiki_lint",
    {
      description:
        "Analyse the wiki for quality issues: orphaned articles, missing summaries, broken links, duplicate concepts.",
      inputSchema: {
        fix: z
          .boolean()
          .optional()
          .describe("Automatically apply safe fixes (default false — report only)")
      }
    },
    async ({ fix }) => {
      if (!env) return errorResult("Server not configured for linting");
      try {
        const lintStub = env.LintAgent.get(
          env.LintAgent.idFromName(`lint-${wikiId}`)
        ) as unknown as LintStub;
        const report = await lintStub.lintWiki(fix ?? false, wikiId);
        // Evict list/stats caches if fixes were applied
        if (cache && fix && (report as { fixesApplied?: number }).fixesApplied) {
          void cache.evictAll(wikiId);
        }
        return textResult(report);
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  return server;
}

// ── HTTP handler factory ──────────────────────────────────────────────────────

export function createMcpHandlers(
  env: Env,
  cache?: WikiCacheManager,
  wikiId = "default"
) {
  return {
    /** Handle /wiki/:wikiId/mcp — standard MCP tool calling */
    async handleMcp(request: Request, ctx: ExecutionContext): Promise<Response> {
      const stub = env.WikiAgent.get(
        env.WikiAgent.idFromName(wikiId)
      ) as unknown as WikiAgentStub;
      const server = createWikiMcpServer(stub, cache, wikiId, env, ctx);
      return createMcpHandler(server, { route: `/wiki/${wikiId}/mcp` })(request, env, ctx);
    },

    /** Handle /wiki/:wikiId/codemode-mcp — CodeMode-wrapped MCP (LLM writes TypeScript) */
    async handleCodemodeMcp(
      request: Request,
      ctx: ExecutionContext
    ): Promise<Response> {
      const stub = env.WikiAgent.get(
        env.WikiAgent.idFromName(wikiId)
      ) as unknown as WikiAgentStub;
      const wikiServer = createWikiMcpServer(stub, cache, wikiId, env, ctx);
      const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
      const server = await codeMcpServer({ server: wikiServer, executor });
      return createMcpHandler(server, { route: `/wiki/${wikiId}/codemode-mcp` })(
        request,
        env,
        ctx
      );
    }
  };
}
