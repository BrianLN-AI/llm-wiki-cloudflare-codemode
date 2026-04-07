import { tool } from "ai";
import { z } from "zod";

/** Slugify a title to a URL-safe string */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

/** Create the SQLite tables (idempotent).
 *
 * This runs inside the WikiAgent DurableObject on every activation so that
 * new schema additions are applied automatically without a migration step.
 * `CREATE TABLE IF NOT EXISTS` and `CREATE TRIGGER IF NOT EXISTS` make every
 * statement a safe no-op when the object already exists.
 */
export function initWikiDatabase(sql: SqlStorage) {
  // Internal metadata (wikiId, schema version, etc.)
  sql.exec(`CREATE TABLE IF NOT EXISTS _wiki_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS articles (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    slug        TEXT UNIQUE NOT NULL,
    content     TEXT NOT NULL,
    summary     TEXT DEFAULT '',
    tags        TEXT DEFAULT '[]',
    source_ids  TEXT DEFAULT '[]',
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS article_links (
    from_slug   TEXT NOT NULL,
    to_slug     TEXT NOT NULL,
    context     TEXT DEFAULT '',
    PRIMARY KEY (from_slug, to_slug)
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS raw_documents (
    id              TEXT PRIMARY KEY,
    filename        TEXT NOT NULL,
    r2_key          TEXT NOT NULL,
    content_type    TEXT DEFAULT 'text/plain',
    status          TEXT DEFAULT 'pending',
    processed_ids   TEXT DEFAULT '[]',
    error_message   TEXT DEFAULT '',
    uploaded_at     TEXT DEFAULT (datetime('now')),
    processed_at    TEXT
  )`);

  // Full-text search virtual table
  sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
    title, content, summary, tags,
    content='articles',
    content_rowid='rowid'
  )`);

  // Keep FTS in sync
  sql.exec(`CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
    INSERT INTO articles_fts(rowid, title, content, summary, tags)
    VALUES (new.rowid, new.title, new.content, new.summary, new.tags);
  END`);

  sql.exec(`CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
    INSERT INTO articles_fts(articles_fts, rowid, title, content, summary, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.summary, old.tags);
    INSERT INTO articles_fts(rowid, title, content, summary, tags)
    VALUES (new.rowid, new.title, new.content, new.summary, new.tags);
  END`);

  sql.exec(`CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
    INSERT INTO articles_fts(articles_fts, rowid, title, content, summary, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.summary, old.tags);
  END`);
}

/** Build all wiki tools wired to the given SqlStorage and env.
 * @param wikiId  The wiki instance ID — used to construct correct CDN cache
 *                eviction keys (e.g. `/wiki/research/article/...`).
 */
export function createWikiTools(sql: SqlStorage, env: Env, wikiId = "default") {
  return {
    createArticle: tool({
      description:
        "Create a new wiki article. Use this when you identify a new concept or topic.",
      inputSchema: z.object({
        title: z.string().describe("Article title (will be slugified)"),
        content: z
          .string()
          .describe(
            "Full article content in markdown. Use [[Article Title]] for wiki links."
          ),
        summary: z
          .string()
          .optional()
          .describe("One-paragraph summary of the article"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Topic tags for categorization"),
        sourceIds: z
          .array(z.string())
          .optional()
          .describe("Raw document IDs this article was created from")
      }),
      execute: async ({ title, content, summary, tags, sourceIds }) => {
        const id = crypto.randomUUID();
        const slug = slugify(title);

        // Handle slug conflicts by appending a suffix
        const existing = sql
          .exec("SELECT id FROM articles WHERE slug = ?", slug)
          .toArray();
        const finalSlug =
          existing.length > 0 ? `${slug}-${id.slice(0, 8)}` : slug;

        sql.exec(
          `INSERT INTO articles (id, title, slug, content, summary, tags, source_ids)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          id,
          title,
          finalSlug,
          content,
          summary ?? "",
          JSON.stringify(tags ?? []),
          JSON.stringify(sourceIds ?? [])
        );

        // Extract and store wiki links from content
        const wikiLinks = extractWikiLinks(content);
        for (const linkedTitle of wikiLinks) {
          const linkedSlug = slugify(linkedTitle);
          try {
            sql.exec(
              "INSERT OR IGNORE INTO article_links (from_slug, to_slug, context) VALUES (?, ?, ?)",
              finalSlug,
              linkedSlug,
              ""
            );
          } catch {
            // Ignore link insertion errors
          }
        }

        // Evict CDN cache for this slug and the article list
        await evictArticleCache(env, finalSlug, wikiId);

        // Store embedding in Vectorize if available
        if (env.WIKI_VECTORS) {
          try {
            const embedding = await generateEmbedding(
              env,
              `${title}\n\n${summary ?? ""}\n\n${content}`
            );
            if (embedding) {
              await env.WIKI_VECTORS.upsert([
                {
                  id: finalSlug,
                  values: embedding,
                  metadata: { title, slug: finalSlug }
                }
              ]);
            }
          } catch {
            // Vectorize errors are non-fatal
          }
        }

        return { id, title, slug: finalSlug, summary: summary ?? "", tags: tags ?? [] };
      }
    }),

    updateArticle: tool({
      description: "Update an existing wiki article's fields.",
      inputSchema: z.object({
        id: z.string().optional().describe("Article ID"),
        slug: z.string().optional().describe("Article slug (alternative to ID)"),
        title: z.string().optional().describe("New title"),
        content: z.string().optional().describe("New content (markdown)"),
        summary: z.string().optional().describe("New summary"),
        tags: z.array(z.string()).optional().describe("New tags"),
        appendContent: z
          .string()
          .optional()
          .describe("Append this text to existing content instead of replacing")
      }),
      execute: async ({ id, slug, title, content, summary, tags, appendContent }) => {
        const fieldMap: Record<string, string> = {
          title: "title",
          summary: "summary"
        };

        // Resolve ID from slug if needed
        let resolvedId = id;
        if (!resolvedId && slug) {
          const row = sql
            .exec("SELECT id FROM articles WHERE slug = ?", slug)
            .toArray()[0] as { id: string } | undefined;
          resolvedId = row?.id;
        }
        if (!resolvedId) return { error: "Article not found" };

        const sets: string[] = [];
        const params: unknown[] = [];

        for (const [key, col] of Object.entries(fieldMap)) {
          const value =
            key === "title" ? title : key === "summary" ? summary : undefined;
          if (value !== undefined) {
            sets.push(`${col} = ?`);
            params.push(value);
          }
        }

        if (tags !== undefined) {
          sets.push("tags = ?");
          params.push(JSON.stringify(tags));
        }

        if (content !== undefined) {
          sets.push("content = ?");
          params.push(content);
        } else if (appendContent !== undefined) {
          const existing = sql
            .exec("SELECT content FROM articles WHERE id = ?", resolvedId)
            .toArray()[0] as { content: string } | undefined;
          if (existing) {
            sets.push("content = ?");
            params.push(existing.content + "\n\n" + appendContent);
          }
        }

        if (sets.length === 0) return { error: "No fields to update" };
        sets.push("updated_at = datetime('now')");
        params.push(resolvedId);

        sql.exec(
          `UPDATE articles SET ${sets.join(", ")} WHERE id = ?`,
          ...params
        );

        // Re-index in Vectorize if content changed
        const updated = sql
          .exec("SELECT * FROM articles WHERE id = ?", resolvedId)
          .toArray()[0] as unknown as ArticleRow | undefined;

        if (updated && env.WIKI_VECTORS && (content !== undefined || appendContent !== undefined)) {
          try {
            const embedding = await generateEmbedding(
              env,
              `${updated.title}\n\n${updated.summary}\n\n${updated.content}`
            );
            if (embedding) {
              await env.WIKI_VECTORS.upsert([
                {
                  id: updated.slug,
                  values: embedding,
                  metadata: { title: updated.title, slug: updated.slug }
                }
              ]);
            }
          } catch {
            // Non-fatal
          }
        }

        if (updated) await evictArticleCache(env, updated.slug, wikiId);
        return updated ?? { error: "Article not found after update" };
      }
    }),

    getArticle: tool({
      description: "Get a wiki article by its ID or slug.",
      inputSchema: z.object({
        id: z.string().optional().describe("Article ID"),
        slug: z.string().optional().describe("Article slug")
      }),
      execute: async ({ id, slug }) => {
        let row: ArticleRow | undefined;
        if (id) {
          row = sql
            .exec("SELECT * FROM articles WHERE id = ?", id)
            .toArray()[0] as unknown as ArticleRow | undefined;
        } else if (slug) {
          row = sql
            .exec("SELECT * FROM articles WHERE slug = ?", slug)
            .toArray()[0] as unknown as ArticleRow | undefined;
        }
        if (!row) return { error: "Article not found" };
        return parseArticleRow(row);
      }
    }),

    listArticles: tool({
      description: "List wiki articles with optional tag filter.",
      inputSchema: z.object({
        tag: z.string().optional().describe("Filter by tag"),
        limit: z
          .number()
          .optional()
          .describe("Maximum number of results (default 50)")
      }),
      execute: async ({ tag, limit }) => {
        let rows: ArticleRow[];
        if (tag) {
          rows = sql
            .exec(
              `SELECT * FROM articles WHERE tags LIKE ? ORDER BY updated_at DESC LIMIT ?`,
              `%"${tag}"%`,
              limit ?? 50
            )
            .toArray() as ArticleRow[];
        } else {
          rows = sql
            .exec(
              "SELECT id, title, slug, summary, tags, updated_at FROM articles ORDER BY updated_at DESC LIMIT ?",
              limit ?? 50
            )
            .toArray() as ArticleRow[];
        }
        return rows.map(parseArticleRow);
      }
    }),

    searchArticles: tool({
      description:
        "Full-text search across all wiki articles. Use this to find relevant articles before answering a question.",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional().describe("Max results (default 10)")
      }),
      execute: async ({ query, limit }) => {
        try {
          const rows = sql
            .exec(
              `SELECT a.id, a.title, a.slug, a.summary, a.tags, a.updated_at
               FROM articles a
               JOIN articles_fts fts ON a.rowid = fts.rowid
               WHERE articles_fts MATCH ?
               ORDER BY rank
               LIMIT ?`,
              query,
              limit ?? 10
            )
            .toArray() as ArticleRow[];
          return rows.map(parseArticleRow);
        } catch {
          // FTS might fail on some query syntax; fall back to LIKE
          const rows = sql
            .exec(
              `SELECT id, title, slug, summary, tags, updated_at FROM articles
               WHERE title LIKE ? OR content LIKE ? OR summary LIKE ?
               LIMIT ?`,
              `%${query}%`,
              `%${query}%`,
              `%${query}%`,
              limit ?? 10
            )
            .toArray() as ArticleRow[];
          return rows.map(parseArticleRow);
        }
      }
    }),

    deleteArticle: tool({
      description: "Delete a wiki article and all its links.",
      inputSchema: z.object({
        id: z.string().optional().describe("Article ID"),
        slug: z.string().optional().describe("Article slug")
      }),
      execute: async ({ id, slug }) => {
        let resolvedSlug = slug;
        let resolvedId = id;
        if (!resolvedId && slug) {
          const row = sql
            .exec("SELECT id FROM articles WHERE slug = ?", slug)
            .toArray()[0] as { id: string } | undefined;
          resolvedId = row?.id;
        }
        if (!resolvedSlug && id) {
          const row = sql
            .exec("SELECT slug FROM articles WHERE id = ?", id)
            .toArray()[0] as { slug: string } | undefined;
          resolvedSlug = row?.slug;
        }
        if (!resolvedId) return { error: "Article not found" };

        sql.exec("DELETE FROM article_links WHERE from_slug = ? OR to_slug = ?", resolvedSlug, resolvedSlug);
        sql.exec("DELETE FROM articles WHERE id = ?", resolvedId);

        // Remove from Vectorize
        if (env.WIKI_VECTORS && resolvedSlug) {
          try {
            await env.WIKI_VECTORS.deleteByIds([resolvedSlug]);
          } catch {
            // Non-fatal
          }
        }

        await evictArticleCache(env, resolvedSlug ?? resolvedId, wikiId);
        return { deleted: resolvedId };
      }
    }),

    linkArticles: tool({
      description: "Create a directional link between two wiki articles.",
      inputSchema: z.object({
        fromSlug: z.string().describe("Slug of the source article"),
        toSlug: z.string().describe("Slug of the target article"),
        context: z
          .string()
          .optional()
          .describe("Snippet of text explaining the relationship")
      }),
      execute: async ({ fromSlug, toSlug, context }) => {
        sql.exec(
          "INSERT OR REPLACE INTO article_links (from_slug, to_slug, context) VALUES (?, ?, ?)",
          fromSlug,
          toSlug,
          context ?? ""
        );
        return { fromSlug, toSlug, context: context ?? "" };
      }
    }),

    getLinkedArticles: tool({
      description: "Get articles that link to or from a given article.",
      inputSchema: z.object({
        slug: z.string().describe("Article slug to find links for"),
        direction: z
          .enum(["outgoing", "incoming", "both"])
          .optional()
          .describe("Link direction (default: both)")
      }),
      execute: async ({ slug, direction = "both" }) => {
        const result: {
          outgoing: ArticleRow[];
          incoming: ArticleRow[];
        } = { outgoing: [], incoming: [] };

        if (direction === "outgoing" || direction === "both") {
          result.outgoing = sql
            .exec(
              `SELECT a.id, a.title, a.slug, a.summary, a.tags, a.updated_at
               FROM articles a
               JOIN article_links l ON a.slug = l.to_slug
               WHERE l.from_slug = ?`,
              slug
            )
            .toArray() as ArticleRow[];
        }

        if (direction === "incoming" || direction === "both") {
          result.incoming = sql
            .exec(
              `SELECT a.id, a.title, a.slug, a.summary, a.tags, a.updated_at
               FROM articles a
               JOIN article_links l ON a.slug = l.from_slug
               WHERE l.to_slug = ?`,
              slug
            )
            .toArray() as ArticleRow[];
        }

        return result;
      }
    }),

    vectorSearch: tool({
      description:
        "Semantic similarity search over wiki articles using Vectorize. Use this for concept-level queries.",
      inputSchema: z.object({
        query: z.string().describe("Natural language query"),
        topK: z
          .number()
          .optional()
          .describe("Number of results to return (default 5)")
      }),
      execute: async ({ query, topK }) => {
        if (!env.WIKI_VECTORS) {
          return { error: "Vectorize not configured; use searchArticles instead" };
        }
        try {
          const embedding = await generateEmbedding(env, query);
          if (!embedding) return { error: "Failed to generate query embedding" };

          const results = await env.WIKI_VECTORS.query(embedding, {
            topK: topK ?? 5,
            returnMetadata: "all"
          });

          return results.matches.map((m) => ({
            slug: m.id,
            score: m.score,
            title: (m.metadata as Record<string, string>)?.title ?? m.id
          }));
        } catch (e) {
          return { error: String(e) };
        }
      }
    }),

    getWikiStats: tool({
      description: "Get overall statistics about the wiki.",
      inputSchema: z.object({}),
      execute: async () => {
        const articles = sql
          .exec("SELECT COUNT(*) as count FROM articles")
          .toArray()[0] as { count: number };
        const links = sql
          .exec("SELECT COUNT(*) as count FROM article_links")
          .toArray()[0] as { count: number };
        const docs = sql
          .exec("SELECT COUNT(*) as count FROM raw_documents")
          .toArray()[0] as { count: number };
        const pending = sql
          .exec(
            "SELECT COUNT(*) as count FROM raw_documents WHERE status = 'pending'"
          )
          .toArray()[0] as { count: number };

        return {
          articleCount: articles.count,
          linkCount: links.count,
          documentCount: docs.count,
          pendingDocuments: pending.count
        };
      }
    })
  };
}

// --- Helpers ---

interface ArticleRow {
  id: string;
  title: string;
  slug: string;
  content?: string;
  summary: string;
  tags: string;
  source_ids?: string;
  created_at?: string;
  updated_at: string;
}

function parseArticleRow(row: ArticleRow) {
  return {
    ...row,
    tags: JSON.parse(row.tags || "[]") as string[],
    sourceIds: JSON.parse(row.source_ids || "[]") as string[]
  };
}

function extractWikiLinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g);
  return [...matches].map((m) => m[1]);
}

async function generateEmbedding(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  try {
    const result = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
      text: text.slice(0, 8192) // Truncate to model limit
    });
    return (result as { data: number[][] }).data[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Evict CDN cache for a specific article slug plus list/stats endpoints.
 * Uses `caches.default` which is available in both Workers and DurableObjects.
 * No-ops silently when HOST is not configured (local dev).
 *
 * @param wikiId  The wiki instance path segment (e.g. "default", "research").
 */
async function evictArticleCache(env: Env, slug: string, wikiId = "default"): Promise<void> {
  const host = env.HOST;
  if (!host) return;
  const origin = host.startsWith("http") ? host : `https://${host}`;
  const base = origin.replace(/\/$/, "");
  await Promise.allSettled([
    caches.default.delete(`${base}/wiki/${wikiId}/article/${slug}`),
    caches.default.delete(`${base}/wiki/${wikiId}/articles`),
    caches.default.delete(`${base}/wiki/${wikiId}/stats`)
  ]);
}
