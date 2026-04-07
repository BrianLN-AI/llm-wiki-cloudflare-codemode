/**
 * LLM Wiki — React Client
 *
 * Three-tab layout:
 *   Chat      — CodeMode-powered AI chat (ask questions, process docs, lint)
 *   Browse    — Read/search wiki articles
 *   Documents — Upload raw files, trigger ingestion, view status
 */
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart } from "ai";
import "./styles.css";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type FormEvent
} from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  Button,
  Card,
  Input,
  Spinner,
  Badge,
  Tabs,
  Tab
} from "@cloudflare/kumo";
import {
  MagnifyingGlass,
  Upload,
  BookOpen,
  Chat,
  ArrowClockwise,
  Broom,
  CheckCircle,
  XCircle,
  Clock,
  Gear
} from "@phosphor-icons/react";

// ── Types ────────────────────────────────────────────────────────────────────

interface Article {
  id: string;
  title: string;
  slug: string;
  content?: string;
  summary: string;
  tags: string[];
  updated_at: string;
}

interface RawDocument {
  id: string;
  filename: string;
  content_type: string;
  status: "pending" | "processing" | "done" | "error";
  error_message: string;
  uploaded_at: string;
  processed_at: string | null;
}

interface WikiStats {
  articles: number;
  links: number;
  documents: number;
  pendingDocuments: number;
}

// ── Streamdown instance ───────────────────────────────────────────────────────

const md = new Streamdown([code()]);

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: RawDocument["status"] }) {
  const map = {
    pending: { icon: <Clock size={12} />, label: "Pending", color: "warning" },
    processing: { icon: <ArrowClockwise size={12} className="animate-spin" />, label: "Processing", color: "info" },
    done: { icon: <CheckCircle size={12} />, label: "Done", color: "success" },
    error: { icon: <XCircle size={12} />, label: "Error", color: "danger" }
  } as const;
  const { icon, label, color } = map[status];
  return (
    <Badge variant={color as "warning" | "info" | "success" | "danger"} className="flex items-center gap-1 text-xs">
      {icon} {label}
    </Badge>
  );
}

// ── Tool card (CodeMode) ──────────────────────────────────────────────────────

function CodeModeCard({ part }: { part: { toolName: string; state: string; args?: unknown; result?: unknown } }) {
  const [open, setOpen] = useState(false);
  const isRunning = part.state === "running" || part.state === "call";
  return (
    <div className="my-2 rounded-lg border border-[var(--cds-color-border-subtle)] bg-[var(--cds-color-bg-subtle)] text-sm overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--cds-color-bg-hover)] transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        {isRunning ? (
          <Spinner size="sm" />
        ) : (
          <span className="w-4 h-4 rounded-full bg-green-500/20 text-green-600 flex items-center justify-center text-xs">✓</span>
        )}
        <span className="font-mono text-xs text-[var(--cds-color-text-subtle)]">
          {part.toolName}
        </span>
        <span className="ml-auto text-[var(--cds-color-text-subtle)]">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          {part.args && (
            <div>
              <div className="text-xs text-[var(--cds-color-text-subtle)] mb-1">Code</div>
              <pre className="text-xs bg-[var(--cds-color-bg-code)] rounded p-2 overflow-x-auto whitespace-pre-wrap">
                {typeof part.args === "string"
                  ? part.args
                  : JSON.stringify(part.args, null, 2)}
              </pre>
            </div>
          )}
          {part.result && (
            <div>
              <div className="text-xs text-[var(--cds-color-text-subtle)] mb-1">Result</div>
              <pre className="text-xs bg-[var(--cds-color-bg-code)] rounded p-2 overflow-x-auto whitespace-pre-wrap">
                {typeof part.result === "string"
                  ? part.result
                  : JSON.stringify(part.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Chat Tab ─────────────────────────────────────────────────────────────────

function ChatTab() {
  const agent = useAgent({ agent: "wiki-agent", name: "default" });
  const { messages, input, handleInputChange, handleSubmit, isLoading, clearHistory } =
    useAgentChat({ agent, initialMessages: [] });

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex flex-col h-full">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-[var(--cds-color-text-subtle)] space-y-3">
            <BookOpen size={48} weight="thin" />
            <div className="text-lg font-semibold">Your personal knowledge wiki</div>
            <div className="text-sm max-w-sm space-y-1">
              <div>Try: <em>"What do I know about transformers?"</em></div>
              <div>Or: <em>"Process the document I just uploaded"</em></div>
              <div>Or: <em>"Lint my wiki and fix issues"</em></div>
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                msg.role === "user"
                  ? "bg-blue-600 text-white rounded-br-sm"
                  : "bg-[var(--cds-color-bg-subtle)] text-[var(--cds-color-text-default)] rounded-bl-sm"
              }`}
            >
              {msg.parts?.map((part, i) => {
                if (part.type === "text") {
                  return (
                    <div
                      key={i}
                      className="prose prose-sm dark:prose-invert max-w-none"
                      dangerouslySetInnerHTML={{ __html: md.parse(part.text) }}
                    />
                  );
                }
                if (isToolUIPart(part)) {
                  return <CodeModeCard key={i} part={part as Parameters<typeof CodeModeCard>[0]["part"]} />;
                }
                return null;
              })}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-[var(--cds-color-bg-subtle)] rounded-2xl rounded-bl-sm px-4 py-2">
              <Spinner size="sm" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-[var(--cds-color-border-subtle)] p-4">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            className="flex-1"
            placeholder="Ask a question, process a document, run lint…"
            value={input}
            onChange={handleInputChange}
            disabled={isLoading}
          />
          <Button type="submit" disabled={isLoading || !input.trim()}>
            Send
          </Button>
          <Button
            type="button"
            variant="secondary"
            title="Clear chat history"
            onClick={clearHistory}
          >
            <Broom size={16} />
          </Button>
        </form>
      </div>
    </div>
  );
}

// ── Browse Tab ────────────────────────────────────────────────────────────────

function BrowseTab() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [selected, setSelected] = useState<Article | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<WikiStats | null>(null);

  const fetchArticles = useCallback(async (q?: string) => {
    setLoading(true);
    try {
      const url = q ? `/api/articles?search=${encodeURIComponent(q)}` : "/api/articles";
      const res = await fetch(url);
      const data = await res.json() as Article[];
      setArticles(Array.isArray(data) ? data.map(a => ({
        ...a,
        tags: Array.isArray(a.tags) ? a.tags : JSON.parse(a.tags as unknown as string || "[]")
      })) : []);
    } catch {
      setArticles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchArticles(); }, [fetchArticles]);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((d) => setStats(d as WikiStats))
      .catch(() => {});
  }, []);

  const openArticle = async (slug: string) => {
    const res = await fetch(`/api/article/${slug}`);
    if (res.ok) setSelected(await res.json() as Article);
  };

  const handleSearch = (e: FormEvent) => {
    e.preventDefault();
    fetchArticles(search || undefined);
  };

  if (selected) {
    return (
      <div className="flex flex-col h-full">
        <div className="border-b border-[var(--cds-color-border-subtle)] p-3 flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setSelected(null)}>
            ← Back
          </Button>
          <h2 className="font-semibold text-sm truncate">{selected.title}</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-3xl mx-auto">
            <h1 className="text-2xl font-bold mb-2">{selected.title}</h1>
            {(Array.isArray(selected.tags) ? selected.tags : []).length > 0 && (
              <div className="flex flex-wrap gap-1 mb-4">
                {(Array.isArray(selected.tags) ? selected.tags : []).map((t) => (
                  <Badge key={t} variant="neutral" className="text-xs">{t}</Badge>
                ))}
              </div>
            )}
            {selected.summary && (
              <p className="text-[var(--cds-color-text-subtle)] text-sm mb-4 italic">
                {selected.summary}
              </p>
            )}
            <div
              className="prose prose-sm dark:prose-invert max-w-none"
              dangerouslySetInnerHTML={{ __html: md.parse(selected.content ?? "") }}
            />
            <div className="mt-6 text-xs text-[var(--cds-color-text-subtle)]">
              Last updated: {new Date(selected.updated_at).toLocaleString()}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-[var(--cds-color-border-subtle)] p-3 space-y-2">
        {stats && (
          <div className="flex gap-4 text-xs text-[var(--cds-color-text-subtle)]">
            <span><strong>{stats.articles}</strong> articles</span>
            <span><strong>{stats.links}</strong> links</span>
            <span><strong>{stats.documents}</strong> documents</span>
            {stats.pendingDocuments > 0 && (
              <span className="text-amber-500"><strong>{stats.pendingDocuments}</strong> pending</span>
            )}
          </div>
        )}
        <form onSubmit={handleSearch} className="flex gap-2">
          <Input
            className="flex-1"
            placeholder="Search articles…"
            value={search}
            onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
          />
          <Button type="submit" size="sm">
            <MagnifyingGlass size={16} />
          </Button>
          {search && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => { setSearch(""); fetchArticles(); }}
            >
              Clear
            </Button>
          )}
        </form>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex justify-center p-8"><Spinner /></div>
        ) : articles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--cds-color-text-subtle)] p-8 text-center">
            <BookOpen size={40} weight="thin" className="mb-3" />
            <div className="text-sm">
              {search ? `No articles matching "${search}"` : "No articles yet. Upload a document and ask the AI to process it."}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-[var(--cds-color-border-subtle)]">
            {articles.map((a) => (
              <button
                key={a.id}
                className="w-full text-left px-4 py-3 hover:bg-[var(--cds-color-bg-hover)] transition-colors"
                onClick={() => openArticle(a.slug)}
              >
                <div className="font-medium text-sm">{a.title}</div>
                {a.summary && (
                  <div className="text-xs text-[var(--cds-color-text-subtle)] mt-0.5 line-clamp-2">
                    {a.summary}
                  </div>
                )}
                {(Array.isArray(a.tags) ? a.tags : []).length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {(Array.isArray(a.tags) ? a.tags : []).slice(0, 5).map((t) => (
                      <Badge key={t} variant="neutral" className="text-xs">{t}</Badge>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Documents Tab ─────────────────────────────────────────────────────────────

function DocumentsTab() {
  const [docs, setDocs] = useState<RawDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [ingestingId, setIngestingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/documents");
      setDocs((await res.json()) as RawDocument[]);
    } catch {
      setDocs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  const handleUpload = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (res.ok) {
        if (fileInputRef.current) fileInputRef.current.value = "";
        await fetchDocs();
      } else {
        const err = await res.json() as { error: string };
        alert(`Upload failed: ${err.error}`);
      }
    } finally {
      setUploading(false);
    }
  };

  const handleIngest = async (docId: string) => {
    setIngestingId(docId);
    try {
      const res = await fetch(`/api/ingest/${docId}`, { method: "POST" });
      if (res.ok) {
        // Refresh after a short delay to show status change
        setTimeout(() => fetchDocs().then(() => setIngestingId(null)), 1000);
      } else {
        setIngestingId(null);
      }
    } catch {
      setIngestingId(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Upload form */}
      <div className="border-b border-[var(--cds-color-border-subtle)] p-4">
        <form onSubmit={handleUpload} className="flex gap-2 items-center">
          <label className="flex-1 cursor-pointer">
            <input
              ref={fileInputRef}
              type="file"
              className="sr-only"
              accept=".txt,.md,.markdown,.html,.json,.pdf,text/*"
              required
            />
            <div className="flex items-center gap-2 rounded-md border border-[var(--cds-color-border-default)] px-3 py-2 text-sm text-[var(--cds-color-text-subtle)] hover:bg-[var(--cds-color-bg-hover)] transition-colors">
              <Upload size={16} />
              Choose file (text, markdown, PDF…)
            </div>
          </label>
          <Button type="submit" disabled={uploading}>
            {uploading ? <Spinner size="sm" /> : "Upload"}
          </Button>
          <Button type="button" variant="secondary" onClick={fetchDocs} title="Refresh">
            <ArrowClockwise size={16} />
          </Button>
        </form>
        <p className="text-xs text-[var(--cds-color-text-subtle)] mt-2">
          After uploading, click <strong>Ingest</strong> or ask the AI to process it in the Chat tab.
        </p>
      </div>

      {/* Document list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex justify-center p-8"><Spinner /></div>
        ) : docs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--cds-color-text-subtle)] p-8 text-center">
            <Upload size={40} weight="thin" className="mb-3" />
            <div className="text-sm">No documents yet. Upload a file to get started.</div>
          </div>
        ) : (
          <div className="divide-y divide-[var(--cds-color-border-subtle)]">
            {docs.map((doc) => (
              <div key={doc.id} className="px-4 py-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{doc.filename}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <StatusBadge status={doc.status} />
                    <span className="text-xs text-[var(--cds-color-text-subtle)]">
                      {new Date(doc.uploaded_at).toLocaleString()}
                    </span>
                  </div>
                  {doc.status === "error" && doc.error_message && (
                    <div className="text-xs text-red-500 mt-1 truncate">{doc.error_message}</div>
                  )}
                </div>
                {(doc.status === "pending" || doc.status === "error") && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={ingestingId === doc.id}
                    onClick={() => handleIngest(doc.id)}
                  >
                    {ingestingId === doc.id ? <Spinner size="sm" /> : "Ingest"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── MCP Info Tab ──────────────────────────────────────────────────────────────

function McpTab() {
  const origin = window.location.origin;
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h2 className="text-lg font-semibold mb-2">MCP Server</h2>
          <p className="text-sm text-[var(--cds-color-text-subtle)]">
            Connect any MCP-compatible client (Claude Desktop, Cursor, Copilot) to your wiki.
          </p>
        </div>

        <Card className="p-4 space-y-3">
          <div>
            <div className="text-xs font-semibold text-[var(--cds-color-text-subtle)] mb-1">Standard MCP (tool calling)</div>
            <code className="block text-sm bg-[var(--cds-color-bg-code)] rounded px-3 py-2 font-mono break-all">
              {origin}/mcp
            </code>
          </div>
          <div>
            <div className="text-xs font-semibold text-[var(--cds-color-text-subtle)] mb-1">CodeMode MCP (LLM writes TypeScript)</div>
            <code className="block text-sm bg-[var(--cds-color-bg-code)] rounded px-3 py-2 font-mono break-all">
              {origin}/codemode-mcp
            </code>
          </div>
        </Card>

        <div>
          <h3 className="text-sm font-semibold mb-2">Available MCP Tools</h3>
          <div className="space-y-2 text-sm">
            {[
              ["wiki_search", "Search articles by keyword or concept"],
              ["wiki_list_articles", "List all wiki articles"],
              ["wiki_get_article", "Get full article by slug"],
              ["wiki_get_stats", "Get wiki statistics"],
              ["wiki_create_article", "Create a new article"],
              ["wiki_update_article", "Update an existing article"],
              ["wiki_delete_article", "Delete an article"],
              ["wiki_list_documents", "List raw documents"],
              ["wiki_process_document", "Trigger document ingestion"],
              ["wiki_lint", "Analyse wiki for quality issues"]
            ].map(([name, desc]) => (
              <div key={name} className="flex gap-3">
                <code className="text-xs font-mono text-blue-500 shrink-0">{name}</code>
                <span className="text-[var(--cds-color-text-subtle)] text-xs">{desc}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">MCP Resources</h3>
          <div className="space-y-1 text-xs font-mono text-[var(--cds-color-text-subtle)]">
            <div>wiki://articles/&#123;slug&#125;</div>
            <div>wiki://stats</div>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Claude Desktop config</h3>
          <pre className="text-xs bg-[var(--cds-color-bg-code)] rounded p-3 overflow-x-auto">
{`{
  "mcpServers": {
    "llm-wiki": {
      "type": "http",
      "url": "${origin}/mcp"
    }
  }
}`}
          </pre>
        </div>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

type TabKey = "chat" | "browse" | "documents" | "mcp";

function App() {
  const [tab, setTab] = useState<TabKey>("chat");

  const toggleTheme = () => {
    const current = document.documentElement.getAttribute("data-mode") ?? "light";
    const next = current === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", next);
    document.documentElement.style.colorScheme = next;
    localStorage.setItem("theme", next);
  };

  return (
    <div className="flex flex-col h-screen bg-[var(--cds-color-bg-default)] text-[var(--cds-color-text-default)]">
      {/* Header */}
      <header className="border-b border-[var(--cds-color-border-subtle)] px-4 py-2 flex items-center gap-3 shrink-0">
        <BookOpen size={20} weight="bold" className="text-blue-500" />
        <h1 className="font-semibold text-sm">LLM Wiki</h1>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded hover:bg-[var(--cds-color-bg-hover)] text-[var(--cds-color-text-subtle)] transition-colors"
            title="Toggle theme"
          >
            ☀️
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div className="border-b border-[var(--cds-color-border-subtle)] shrink-0">
        <nav className="flex gap-0 px-2">
          {([
            ["chat", <Chat size={14} />, "Chat"],
            ["browse", <BookOpen size={14} />, "Browse"],
            ["documents", <Upload size={14} />, "Documents"],
            ["mcp", <Gear size={14} />, "MCP"]
          ] as [TabKey, React.ReactNode, string][]).map(([key, icon, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                tab === key
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-[var(--cds-color-text-subtle)] hover:text-[var(--cds-color-text-default)]"
              }`}
            >
              {icon} {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "chat" && <ChatTab />}
        {tab === "browse" && <BrowseTab />}
        {tab === "documents" && <DocumentsTab />}
        {tab === "mcp" && <McpTab />}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
