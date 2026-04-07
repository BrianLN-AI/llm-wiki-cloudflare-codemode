/**
 * LintAgent
 *
 * A background Agent that analyses the wiki for quality issues and applies
 * safe fixes. Can be triggered on-demand via chat/MCP or via a Cron Trigger.
 *
 * Issues detected:
 *   - Missing summaries (summary is empty)
 *   - Orphaned articles (no incoming or outgoing links)
 *   - Broken wiki links ([[Title]] in content with no matching article slug)
 *   - Articles with no tags
 *   - Very short articles (< 100 words, likely stubs)
 *
 * Fixes applied (when fix=true):
 *   - Generate missing summaries via Workers AI
 *   - Add "stub" tag to short articles
 *   - Remove broken link markup (replace [[Bad Title]] with Bad Title)
 *
 * Reports always generated regardless of fix mode.
 */

import { Agent } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import { generateText } from "ai";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LintIssue {
  type:
    | "missing_summary"
    | "orphaned_article"
    | "broken_link"
    | "no_tags"
    | "stub_article";
  articleSlug: string;
  articleTitle: string;
  detail: string;
  fixApplied: boolean;
}

export interface LintReport {
  scannedArticles: number;
  issues: LintIssue[];
  fixesApplied: number;
  timestamp: string;
}

// ── Article shape returned by WikiAgent callables ─────────────────────────────

interface ArticleRow {
  id: string;
  title: string;
  slug: string;
  content: string;
  summary: string;
  tags: string; // JSON string
  updated_at: string;
}

interface WikiAgentStub {
  getAllArticlesForLint(): Promise<ArticleRow[]>;
  updateArticleProgrammatic(
    idOrSlug: string,
    fields: Record<string, unknown>
  ): Promise<unknown>;
}

// ── LintAgent ─────────────────────────────────────────────────────────────────

export class LintAgent extends Agent<Env> {
  /**
   * Run the full lint pass over the wiki.
   * @param fix When true, applies safe automatic fixes.
   */
  async lintWiki(fix = false): Promise<LintReport> {
    const wikiStub = this.env.WikiAgent.get(
      this.env.WikiAgent.idFromName("default")
    ) as unknown as WikiAgentStub;

    const articles = await wikiStub.getAllArticlesForLint();
    const issues: LintIssue[] = [];
    let fixesApplied = 0;

    // Build a slug set for broken-link detection
    const slugSet = new Set(articles.map((a) => a.slug));
    // Build a set of slugs that have at least one incoming or outgoing link
    // (derived from [[wikilink]] extraction across all articles)
    const linkedSlugs = new Set<string>();
    for (const article of articles) {
      const links = extractWikiLinks(article.content);
      for (const title of links) {
        linkedSlugs.add(slugify(title));
        linkedSlugs.add(article.slug); // the article itself is "linked from"
      }
    }

    for (const article of articles) {
      const tags = JSON.parse(article.tags || "[]") as string[];
      const wordCount = article.content.split(/\s+/).filter(Boolean).length;
      const wikiLinks = extractWikiLinks(article.content);

      // ── Check: missing summary ──────────────────────────────────────────
      if (!article.summary || article.summary.trim().length < 10) {
        const issue: LintIssue = {
          type: "missing_summary",
          articleSlug: article.slug,
          articleTitle: article.title,
          detail: "Article has no summary",
          fixApplied: false
        };

        if (fix && this.env.AI) {
          try {
            const summary = await this.generateSummary(article.title, article.content);
            await wikiStub.updateArticleProgrammatic(article.slug, { summary });
            issue.fixApplied = true;
            fixesApplied++;
          } catch {
            // Fix failed — report only
          }
        }

        issues.push(issue);
      }

      // ── Check: orphaned article ──────────────────────────────────────────
      if (!linkedSlugs.has(article.slug)) {
        issues.push({
          type: "orphaned_article",
          articleSlug: article.slug,
          articleTitle: article.title,
          detail:
            "No other articles link to or from this article. Consider connecting it to related topics.",
          fixApplied: false
        });
      }

      // ── Check: broken wiki links ─────────────────────────────────────────
      const broken = wikiLinks.filter(
        (title) => !slugSet.has(slugify(title))
      );
      if (broken.length > 0) {
        const issue: LintIssue = {
          type: "broken_link",
          articleSlug: article.slug,
          articleTitle: article.title,
          detail: `Broken wiki links: ${broken.map((t) => `[[${t}]]`).join(", ")}`,
          fixApplied: false
        };

        if (fix) {
          try {
            // Replace [[Broken Title]] with just Broken Title (plain text)
            let fixedContent = article.content;
            for (const title of broken) {
              fixedContent = fixedContent.replace(
                new RegExp(`\\[\\[${escapeRegex(title)}\\]\\]`, "g"),
                title
              );
            }
            await wikiStub.updateArticleProgrammatic(article.slug, {
              content: fixedContent
            });
            issue.fixApplied = true;
            fixesApplied++;
          } catch {
            // Fix failed
          }
        }

        issues.push(issue);
      }

      // ── Check: no tags ───────────────────────────────────────────────────
      if (tags.length === 0) {
        issues.push({
          type: "no_tags",
          articleSlug: article.slug,
          articleTitle: article.title,
          detail: "Article has no tags. Add topic tags to improve discoverability.",
          fixApplied: false
        });
      }

      // ── Check: stub article ──────────────────────────────────────────────
      if (wordCount < 100) {
        const issue: LintIssue = {
          type: "stub_article",
          articleSlug: article.slug,
          articleTitle: article.title,
          detail: `Article is very short (${wordCount} words). Consider expanding it.`,
          fixApplied: false
        };

        if (fix && !tags.includes("stub")) {
          try {
            const newTags = [...tags, "stub"];
            await wikiStub.updateArticleProgrammatic(article.slug, {
              tags: newTags
            });
            issue.fixApplied = true;
            fixesApplied++;
          } catch {
            // Fix failed
          }
        }

        issues.push(issue);
      }
    }

    return {
      scannedArticles: articles.length,
      issues,
      fixesApplied,
      timestamp: new Date().toISOString()
    };
  }

  private async generateSummary(title: string, content: string): Promise<string> {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const model = this.env.WORKERS_AI_MODEL ?? "@cf/meta/llama-3.3-70b-instruct";
    const { text } = await generateText({
      model: workersai(model),
      system:
        "Write a concise 2-4 sentence summary of the following wiki article. " +
        "Use third-person encyclopedic style. Return only the summary, no preamble.",
      prompt: `Title: ${title}\n\nContent:\n${content.slice(0, 4000)}`
    });
    return text.trim();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractWikiLinks(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
