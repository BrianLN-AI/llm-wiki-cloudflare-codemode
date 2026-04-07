# LLM Wiki — Specification

> **This document is the source of truth.** Code is secondary; all changes must trace back to this spec.

## 1. Overview

LLM Wiki is a Cloudflare-hosted, AI-maintained personal knowledge base inspired by Andrej Karpathy's [llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) concept.

Instead of stateless RAG, the system maintains a **persistent, interlinked wiki** that an LLM incrementally builds and curates. Raw materials (research papers, articles, PDFs, notes) are uploaded once; the LLM synthesizes them into structured wiki articles that grow richer over time.

## 2. Goals

| ID  | Goal |
|-----|------|
| G1  | Users upload raw documents via web UI |
| G2  | LLM compiles raw docs into structured wiki articles (markdown) |
| G3  | Wiki articles are searchable (full-text and semantic) |
| G4  | Users ask natural-language questions; LLM synthesizes answers from the wiki |
| G5  | LLM can "lint" the wiki: fix inconsistencies, merge duplicates, add links |
| G6  | All data persists across sessions |
| G7  | System deploys to Cloudflare via CI/CD with zero manual steps post-setup |

## 3. Non-Goals

- Not a general-purpose chatbot
- Not a replacement for Obsidian/Roam (no desktop app)
- No multi-tenancy in v1 (single user/namespace per deployment)
- No file deduplication in v1

## 4. Functional Requirements

### 4.1 Document Ingestion

- **FR-ING-1**: User can upload a text/markdown/PDF file via the UI
- **FR-ING-2**: Uploaded files are stored durably in Cloudflare R2
- **FR-ING-3**: Each uploaded document has a status: `pending | processing | done | error`
- **FR-ING-4**: User can trigger processing of a pending document
- **FR-ING-5**: Processing extracts key concepts and creates/updates wiki articles

### 4.2 Wiki Management

- **FR-WIKI-1**: Articles have: title, slug (URL-safe), content (markdown), summary, tags, created_at, updated_at
- **FR-WIKI-2**: Articles can reference each other via wiki links (`[[Article Title]]`)
- **FR-WIKI-3**: The LLM can create, update, and delete articles
- **FR-WIKI-4**: Articles are stored durably in SQLite (Cloudflare DurableObject)
- **FR-WIKI-5**: Full-text search over all articles

### 4.3 Semantic Search

- **FR-SEM-1**: Article content is vectorized and stored in Cloudflare Vectorize
- **FR-SEM-2**: Questions are embedded and matched against article vectors
- **FR-SEM-3**: Search returns ranked articles with similarity scores

### 4.4 AI Chat Interface

- **FR-CHAT-1**: User types questions in a chat interface
- **FR-CHAT-2**: The LLM uses CodeMode to write TypeScript code that orchestrates wiki tools
- **FR-CHAT-3**: Synthesized answers cite specific wiki articles
- **FR-CHAT-4**: Code execution happens in isolated Dynamic Worker sandboxes
- **FR-CHAT-5**: Chat history persists within a session (DurableObject)

### 4.5 Wiki Maintenance

- **FR-MAINT-1**: User can trigger a "lint" operation to clean up the wiki
- **FR-MAINT-2**: Linting detects: broken links, duplicate articles, missing summaries, orphaned articles
- **FR-MAINT-3**: Linting results are reported in the chat

## 5. User Stories

### US-1: Research Paper Ingestion
> As a researcher, I want to upload a PDF/text file of a paper so that the LLM extracts key concepts into my wiki.

Acceptance criteria:
- File appears in "Raw Documents" tab with status "pending"
- After processing, one or more wiki articles are created
- Articles link to the source document

### US-2: Knowledge Query
> As a user, I want to ask "What is the difference between transformers and RNNs?" and get an answer synthesized from my wiki articles.

Acceptance criteria:
- Chat returns a structured answer
- Answer cites specific wiki articles
- If no relevant articles exist, system says so

### US-3: Wiki Browse
> As a user, I want to browse all wiki articles and read them.

Acceptance criteria:
- Articles list shows title, summary, tags
- Clicking an article shows full content
- Wiki links in content are navigable

### US-4: Wiki Lint
> As a user, I want to run a lint operation to find and fix inconsistencies.

Acceptance criteria:
- Lint reports orphaned articles, missing links, duplicates
- LLM proposes fixes via CodeMode
- User can approve/reject fixes (v2; v1 just reports)

## 6. Data Model

### Articles Table
```sql
articles (
  id          TEXT PRIMARY KEY,      -- UUID
  title       TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,  -- URL-safe lowercase-hyphenated
  content     TEXT NOT NULL,         -- Markdown
  summary     TEXT DEFAULT '',       -- One-paragraph summary
  tags        TEXT DEFAULT '[]',     -- JSON array of strings
  source_ids  TEXT DEFAULT '[]',     -- JSON array of raw_document IDs
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
)
```

### Article Links Table
```sql
article_links (
  from_slug   TEXT NOT NULL,
  to_slug     TEXT NOT NULL,
  context     TEXT DEFAULT '',  -- Snippet of text containing the link
  PRIMARY KEY (from_slug, to_slug)
)
```

### Raw Documents Table
```sql
raw_documents (
  id              TEXT PRIMARY KEY,
  filename        TEXT NOT NULL,
  r2_key          TEXT NOT NULL,
  content_type    TEXT DEFAULT 'text/plain',
  status          TEXT DEFAULT 'pending',
  processed_ids   TEXT DEFAULT '[]',  -- JSON array of article IDs created
  error_message   TEXT DEFAULT '',
  uploaded_at     TEXT DEFAULT (datetime('now')),
  processed_at    TEXT
)
```

## 7. API Contracts

### POST /api/upload
Upload a raw document.
- Body: `multipart/form-data` with `file` field
- Response: `{ id, filename, r2_key, status: "pending" }`

### GET /api/documents
List all raw documents.
- Response: `{ documents: RawDocument[] }`

### POST /api/agent/:namespace/*
Agent WebSocket endpoint (handled by `routeAgentRequest`).

### GET /api/health
Health check.
- Response: `{ ok: true, timestamp }`

## 8. Quality Requirements

| ID   | Requirement |
|------|-------------|
| QR-1 | Wiki articles must be stored durably (survives worker restarts) |
| QR-2 | LLM-generated code must run in isolated sandboxes (Dynamic Workers) |
| QR-3 | R2 uploads must be streamed (no full buffering in Worker memory) |
| QR-4 | CI must lint (TypeScript), build, and deploy on main branch push |
| QR-5 | Secrets (API keys) must never be committed to the repo |

## 9. Open Questions

- [ ] Should we support PDF parsing? (v1: text only, v2: PDF via Workers AI Document Processing)
- [ ] Should we use Workers AI embeddings or an external embedding API?
- [ ] Should the wiki be public or require authentication?
- [ ] How large is a typical user's wiki? (affects Vectorize dimension/quota planning)
