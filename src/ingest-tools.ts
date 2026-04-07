import { tool } from "ai";
import { z } from "zod";

/** Build document ingestion tools wired to SqlStorage and R2. */
export function createIngestTools(sql: SqlStorage, env: Env) {
  return {
    listRawDocuments: tool({
      description: "List all raw documents with their processing status.",
      inputSchema: z.object({
        status: z
          .enum(["pending", "processing", "done", "error"])
          .optional()
          .describe("Filter by status")
      }),
      execute: async ({ status }) => {
        if (status) {
          return sql
            .exec(
              "SELECT id, filename, content_type, status, error_message, uploaded_at, processed_at FROM raw_documents WHERE status = ? ORDER BY uploaded_at DESC",
              status
            )
            .toArray();
        }
        return sql
          .exec(
            "SELECT id, filename, content_type, status, error_message, uploaded_at, processed_at FROM raw_documents ORDER BY uploaded_at DESC"
          )
          .toArray();
      }
    }),

    getRawDocumentContent: tool({
      description: "Fetch the text content of a raw document from R2 storage.",
      inputSchema: z.object({
        id: z.string().describe("Raw document ID")
      }),
      execute: async ({ id }) => {
        const doc = sql
          .exec(
            "SELECT id, filename, r2_key, content_type FROM raw_documents WHERE id = ?",
            id
          )
          .toArray()[0] as
          | { id: string; filename: string; r2_key: string; content_type: string }
          | undefined;

        if (!doc) return { error: "Document not found" };

        if (!env.RAW_DOCS) {
          return { error: "R2 bucket (RAW_DOCS) not configured" };
        }

        try {
          const obj = await env.RAW_DOCS.get(doc.r2_key);
          if (!obj) return { error: "File not found in R2" };

          const text = await obj.text();
          return {
            id: doc.id,
            filename: doc.filename,
            contentType: doc.content_type,
            content: text.slice(0, 200_000) // Limit to 200K chars to avoid context overflow
          };
        } catch (e) {
          return { error: `Failed to read from R2: ${String(e)}` };
        }
      }
    }),

    markDocumentProcessing: tool({
      description: "Mark a raw document as currently being processed.",
      inputSchema: z.object({
        id: z.string().describe("Raw document ID")
      }),
      execute: async ({ id }) => {
        sql.exec(
          "UPDATE raw_documents SET status = 'processing' WHERE id = ?",
          id
        );
        return { id, status: "processing" };
      }
    }),

    markDocumentDone: tool({
      description:
        "Mark a raw document as successfully processed, recording which articles were created.",
      inputSchema: z.object({
        id: z.string().describe("Raw document ID"),
        articleIds: z
          .array(z.string())
          .describe("IDs of wiki articles created from this document")
      }),
      execute: async ({ id, articleIds }) => {
        sql.exec(
          "UPDATE raw_documents SET status = 'done', processed_ids = ?, processed_at = datetime('now') WHERE id = ?",
          JSON.stringify(articleIds),
          id
        );
        return { id, status: "done", articleIds };
      }
    }),

    markDocumentError: tool({
      description:
        "Mark a raw document as failed with an error message.",
      inputSchema: z.object({
        id: z.string().describe("Raw document ID"),
        error: z.string().describe("Error message describing what went wrong")
      }),
      execute: async ({ id, error }) => {
        sql.exec(
          "UPDATE raw_documents SET status = 'error', error_message = ?, processed_at = datetime('now') WHERE id = ?",
          error,
          id
        );
        return { id, status: "error", error };
      }
    }),

    registerDocument: tool({
      description: "Register a newly uploaded document in the database.",
      inputSchema: z.object({
        id: z.string().describe("Document ID (UUID)"),
        filename: z.string().describe("Original filename"),
        r2Key: z.string().describe("R2 object key"),
        contentType: z.string().optional().describe("MIME type")
      }),
      execute: async ({ id, filename, r2Key, contentType }) => {
        sql.exec(
          `INSERT INTO raw_documents (id, filename, r2_key, content_type)
           VALUES (?, ?, ?, ?)`,
          id,
          filename,
          r2Key,
          contentType ?? "text/plain"
        );
        return { id, filename, r2Key, status: "pending" };
      }
    })
  };
}
