/**
 * IngestAgent
 *
 * A background Agent that processes raw documents stored in R2 and creates
 * wiki articles via the WikiAgent DurableObject.
 *
 * Lifecycle:
 *   1. WikiAgent (or MCP tool) calls env.IngestAgent.get(...).processDocument(docId)
 *   2. IngestAgent reads the raw document from R2
 *   3. Workers AI extracts a structured list of concepts/articles
 *   4. IngestAgent calls WikiAgent callable methods to persist articles
 *   5. IngestAgent updates document status to "done" or "error"
 *
 * The agent is stateless across requests but uses DurableObject alarm for
 * retry logic on failure.
 */

import { Agent } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import { generateObject } from "ai";
import { z } from "zod";

// Schema for structured AI extraction output
const ExtractionSchema = z.object({
  articles: z.array(
    z.object({
      title: z.string().describe("Article title (unique concept name)"),
      content: z.string().describe("Full article content in markdown (300-1500 words)"),
      summary: z.string().describe("One-paragraph summary (2-4 sentences)"),
      tags: z.array(z.string()).describe("3-7 topic tags, lowercase hyphenated"),
      relatedTitles: z
        .array(z.string())
        .describe("Titles of other articles in this batch that this article should link to")
    })
  ).describe("List of wiki articles extracted from this document (1-10 articles)")
});

type ExtractionResult = z.infer<typeof ExtractionSchema>;

interface WikiAgentStub {
  initWikiId(id: string): Promise<void>;
  createArticleProgrammatic(
    title: string,
    content: string,
    summary: string,
    tags: string[],
    sourceIds: string[]
  ): Promise<{ id: string; slug: string }>;
  markDocumentDoneProgrammatic(id: string, articleIds: string[]): Promise<void>;
  markDocumentErrorProgrammatic(id: string, error: string): Promise<void>;
  markDocumentProcessingProgrammatic(id: string): Promise<void>;
  getDocumentProgrammatic(id: string): Promise<{
    id: string;
    filename: string;
    r2_key: string;
    content_type: string;
    status: string;
  } | null>;
}

const EXTRACTION_SYSTEM_PROMPT = `You are a knowledge extraction expert. Given a document, extract a set of
well-structured wiki articles that capture the key concepts.

Guidelines:
- Create one article per major concept (not per section)
- Write in third-person encyclopedic style
- Use markdown: ## headings, bullet lists, code blocks where appropriate
- Add [[wiki links]] using exact article titles for cross-references
- Each article should be self-contained but reference related articles
- Focus on concepts, not on the document structure itself
- Omit boilerplate, headers, footers, and bibliographic metadata
- For technical content: include definitions, examples, and implications`;

export class IngestAgent extends Agent<Env> {
  /**
   * Process a single raw document: read from R2, extract concepts via AI,
   * create wiki articles, update document status.
   *
   * @param docId   The raw document ID to process.
   * @param wikiId  The wiki instance to write articles into (default: "default").
   */
  async processDocument(docId: string, wikiId = "default"): Promise<{
    success: boolean;
    articleIds?: string[];
    error?: string;
  }> {
    const wikiStub = this.env.WikiAgent.get(
      this.env.WikiAgent.idFromName(wikiId)
    ) as unknown as WikiAgentStub;

    // Ensure the DO knows its own wikiId for correct CDN cache eviction paths
    await wikiStub.initWikiId(wikiId);

    // 1. Fetch document metadata
    const doc = await wikiStub.getDocumentProgrammatic(docId);
    if (!doc) {
      return { success: false, error: `Document ${docId} not found` };
    }
    if (doc.status === "done") {
      return { success: true, articleIds: [], error: "Already processed" };
    }

    // 2. Mark as processing
    await wikiStub.markDocumentProcessingProgrammatic(docId);

    try {
      // 3. Read content from R2
      if (!this.env.RAW_DOCS) {
        throw new Error("R2 bucket (RAW_DOCS) not configured");
      }
      const obj = await this.env.RAW_DOCS.get(doc.r2_key);
      if (!obj) throw new Error(`File not found in R2: ${doc.r2_key}`);

      const rawText = await obj.text();
      if (!rawText.trim()) throw new Error("Document is empty");

      // Truncate to avoid context limits (approx 100K chars ≈ 25K tokens)
      const truncatedText = rawText.slice(0, 100_000);

      // 4. Extract structured articles via Workers AI
      const extraction = await this.extractArticles(doc.filename, truncatedText);

      // 5. Create wiki articles
      const articleIds: string[] = [];
      const slugMap: Record<string, string> = {};

      for (const articleDef of extraction.articles) {
        // Add wiki links for related articles in this batch
        let content = articleDef.content;
        for (const related of articleDef.relatedTitles) {
          if (!content.includes(`[[${related}]]`)) {
            // Append a "See also" section if not already linked inline
            content += `\n\n**See also:** [[${related}]]`;
          }
        }

        const created = await wikiStub.createArticleProgrammatic(
          articleDef.title,
          content,
          articleDef.summary,
          articleDef.tags,
          [docId]
        );
        articleIds.push(created.id);
        slugMap[articleDef.title] = created.slug;
      }

      // 6. Mark document as done
      await wikiStub.markDocumentDoneProgrammatic(docId, articleIds);

      return { success: true, articleIds };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await wikiStub.markDocumentErrorProgrammatic(docId, message);
      return { success: false, error: message };
    }
  }

  private async extractArticles(
    filename: string,
    text: string
  ): Promise<ExtractionResult> {
    const model = this.env.WORKERS_AI_MODEL ?? "@cf/meta/llama-3.3-70b-instruct";
    const workersai = createWorkersAI({ binding: this.env.AI });

    const { object } = await generateObject({
      model: workersai(model),
      schema: ExtractionSchema,
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: `Extract wiki articles from the following document.\n\nFilename: ${filename}\n\n---\n\n${text}`
    });

    return object;
  }
}
