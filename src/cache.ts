/**
 * CDN Cache Manager
 *
 * Uses Cloudflare's Cache API (`caches.default`) — the same cache as Cloudflare's
 * CDN edge — to store and evict wiki responses.
 *
 * Note on `caches.default` scope:
 *   - On a **zone-bound worker** (custom domain): `caches.default` IS the global
 *     Cloudflare CDN edge cache, stored at the PoP nearest each user.
 *   - On a **workers.dev** subdomain: `caches.default` is a per-datacenter cache
 *     (still useful for repeat requests within the same DC, but not globally shared).
 *   For full global CDN benefit, deploy on a custom domain.
 *
 * Cache key scheme (wikiId is part of the URL path):
 *   GET /wiki/:wikiId/article/:slug  → max-age=300 (5 min), swr=3600
 *   GET /wiki/:wikiId/articles       → max-age=60  (1 min),  swr=600
 *   GET /wiki/:wikiId/stats          → max-age=60  (1 min),  swr=300
 *   Writes (create/update/delete)    → evict affected keys immediately
 *
 * ETag / conditional-request support:
 *   - ETag derived from updated_at timestamp (weak etag)
 *   - 304 Not Modified returned when If-None-Match matches
 */

export const CACHE_TTL = {
  article: 300,        // 5 minutes
  articleList: 60,     // 1 minute
  stats: 60,           // 1 minute
  swr: {
    article: 3600,     // stale-while-revalidate: 1 hour
    articleList: 600,  // stale-while-revalidate: 10 minutes
    stats: 300,        // stale-while-revalidate: 5 minutes
  }
} as const;

// ── ETag helpers ──────────────────────────────────────────────────────────────

/** Build a weak ETag from an ISO timestamp string. */
export function makeETag(updatedAt: string): string {
  const ts = new Date(updatedAt).getTime();
  return `W/"${ts.toString(36)}"`;
}

/**
 * Check the incoming request's If-None-Match / If-Modified-Since headers
 * against the current ETag and return a 304 response if the resource has
 * not been modified.
 */
export function checkConditional(
  request: Request,
  etag: string,
  lastModified: string
): Response | null {
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch) {
    const tags = ifNoneMatch.split(",").map((t) => t.trim());
    if (tags.includes(etag) || tags.includes("*")) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Last-Modified": new Date(lastModified).toUTCString()
        }
      });
    }
  }

  const ifModifiedSince = request.headers.get("If-Modified-Since");
  if (ifModifiedSince) {
    const since = new Date(ifModifiedSince).getTime();
    const modTime = new Date(lastModified).getTime();
    if (modTime <= since) {
      return new Response(null, {
        status: 304,
        headers: { "Last-Modified": new Date(lastModified).toUTCString() }
      });
    }
  }

  return null;
}

// ── Cache key helpers ─────────────────────────────────────────────────────────

/** Build the canonical absolute cache URL for a given path. */
export function cacheKey(origin: string, path: string): string {
  const base = origin.replace(/\/$/, "");
  return `${base}${path}`;
}

/** Derive the origin from a Request object. */
export function originFrom(request: Request): string {
  const url = new URL(request.url);
  return url.origin;
}

// ── JSON response builder ─────────────────────────────────────────────────────

/** Build a cacheable JSON response with proper CDN headers. */
export function jsonResponse(
  data: unknown,
  opts: {
    status?: number;
    etag?: string;
    lastModified?: string;
    maxAge?: number;
    swr?: number;
  } = {}
): Response {
  const { status = 200, etag, lastModified, maxAge = 0, swr = 0 } = opts;
  const headers = new Headers({ "Content-Type": "application/json" });

  if (maxAge > 0) {
    const parts = [`public`, `max-age=${maxAge}`];
    if (swr > 0) parts.push(`stale-while-revalidate=${swr}`);
    headers.set("Cache-Control", parts.join(", "));
  } else {
    headers.set("Cache-Control", "private, no-store");
  }

  if (etag) headers.set("ETag", etag);
  if (lastModified) headers.set("Last-Modified", new Date(lastModified).toUTCString());
  // Cloudflare strips Vary: * so use specific headers
  headers.set("Vary", "Accept-Encoding");

  return new Response(JSON.stringify(data, (_key, val) =>
    // Never serialize stack traces to HTTP responses
    _key === "stack" ? undefined : val
  ), { status, headers });
}

// ── Main cache manager ────────────────────────────────────────────────────────

export class WikiCacheManager {
  private readonly cf = caches.default;
  private readonly origin: string;

  constructor(origin: string) {
    this.origin = origin.replace(/\/$/, "");
  }

  static fromRequest(request: Request): WikiCacheManager {
    return new WikiCacheManager(originFrom(request));
  }

  // ── Read paths ──────────────────────────────────────────────────────────────

  /** Check the edge cache for a given API path. Returns cached Response or undefined. */
  async match(path: string): Promise<Response | undefined> {
    try {
      const cached = await this.cf.match(cacheKey(this.origin, path));
      return cached ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Store a response in the edge cache under the given path. */
  async put(path: string, response: Response): Promise<void> {
    try {
      await this.cf.put(cacheKey(this.origin, path), response.clone());
    } catch {
      // Cache put failures are non-fatal
    }
  }

  // ── Write paths (eviction) ──────────────────────────────────────────────────

  /**
   * Evict all cache entries related to a specific article slug within a wiki.
   * Called after create, update, or delete.
   */
  async evictArticle(slug: string, wikiId = "default"): Promise<void> {
    await this.evictPaths([
      `/wiki/${wikiId}/article/${slug}`,
      `/wiki/${wikiId}/articles`,
      `/wiki/${wikiId}/stats`
    ]);
  }

  /** Evict list/stats caches for a wiki (used after bulk lint/ingest). */
  async evictAll(wikiId = "default"): Promise<void> {
    await this.evictPaths([`/wiki/${wikiId}/articles`, `/wiki/${wikiId}/stats`]);
    // Note: individual article cache keys are evicted lazily via
    // stale-while-revalidate; a full purge requires the Cloudflare Zones API.
  }

  private async evictPaths(paths: string[]): Promise<void> {
    await Promise.allSettled(
      paths.map((p) => this.cf.delete(cacheKey(this.origin, p)))
    );
  }
}

// ── Cache-aware fetch wrapper ─────────────────────────────────────────────────

/**
 * Serve a cached-or-fresh JSON response.
 *
 * @param request  Original HTTP request (for conditional headers + origin)
 * @param cache    WikiCacheManager instance
 * @param path     API path used as cache key
 * @param build    Async function that builds the fresh response (only called on miss)
 * @param ctx      ExecutionContext for ctx.waitUntil background cache population
 */
export async function serveCached(
  request: Request,
  cache: WikiCacheManager,
  path: string,
  build: () => Promise<Response>,
  ctx: ExecutionContext
): Promise<Response> {
  // Honour Cache-Control: no-cache / no-store from the client (e.g. browser forced-refresh)
  const reqCC = request.headers.get("Cache-Control") ?? "";
  if (reqCC.includes("no-cache") || reqCC.includes("no-store")) {
    return build();
  }

  // 1. Try cache hit
  const cached = await cache.match(path);
  if (cached) {
    // Honour conditional requests against the cached ETag
    const cachedEtag = cached.headers.get("ETag");
    const cachedLM = cached.headers.get("Last-Modified");
    if (cachedEtag) {
      const cond = checkConditional(
        request,
        cachedEtag,
        cachedLM ?? new Date().toUTCString()
      );
      if (cond) return cond;
    }
    return cached;
  }

  // 2. Build fresh response
  const fresh = await build();

  // 3. Store in cache asynchronously (don't block the response)
  if (fresh.status === 200) {
    const cacheControl = fresh.headers.get("Cache-Control") ?? "";
    if (cacheControl.includes("public")) {
      ctx.waitUntil(cache.put(path, fresh));
    }
  }

  return fresh;
}
