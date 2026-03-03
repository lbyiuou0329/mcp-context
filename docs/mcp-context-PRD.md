# Technical Design Doc — PostToolUse Output Indexer for Claude Code

## Tool Output Indexer: Design Document

### Problem

Claude Code's tool outputs go directly into the LLM's context window. A Playwright accessibility snapshot (30-60KB), a Context7 documentation query (5-50KB), or a verbose `npm test` run (10-50KB) can consume a significant portion of the context budget on content the LLM may never need.

Claude Code itself truncates large outputs at ~25k tokens. Other coding agents (Codex CLI, Cursor, Gemini CLI) use similar blind truncation — head+tail splits, line limits, byte caps. This loses information permanently. Users regularly complain about lost middle content ([Codex #7906](https://github.com/openai/codex/issues/7906), [Gemini #14775](https://github.com/google-gemini/gemini-cli/issues/14775)). Tools like [rtk](https://github.com/rtk-ai/rtk) trim CLI output before it reaches the model — still lossy. [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode-mcp/) compresses MCP tool *schemas* (the input side), but doesn't address output.

This tool upgrades blind truncation to indexed retrieval — nothing is lost, and the LLM searches for what it needs.

### Solution

A Claude Code plugin that:

1. Registers a **PostToolUse hook** for tools that produce large output
2. When output exceeds a threshold, **indexes it into a SQLite FTS5 knowledge base**
3. **Replaces the output** with a short summary + search instructions
4. Provides a **`search` MCP tool** the LLM calls to retrieve specific sections on demand

The LLM sees a 200-byte summary instead of 50KB. When it needs specific information, it searches. Full content is preserved and retrievable — nothing is lost.

### Architecture

```
LLM calls tool (Playwright, Context7, Bash, etc.)
  │
  ▼
Tool executes normally (sandboxed by Claude Code)
  │
  ▼
PostToolUse hook fires
  │
  ├─ Output < 5KB?  → pass through unchanged (exit 0)
  │
  └─ Output >= 5KB?
        │
        ├─ Send output to MCP server's /index endpoint via stdin/temp file
        ├─ MCP server indexes into FTS5 (markdown-aware chunking, BM25)
        ├─ Hook returns updatedMCPToolOutput (for MCP tools):
        │    "30KB indexed as 'playwright-snapshot-1'.
        │     Use search(queries: [...], source: 'playwright-snapshot-1') for details."
        │
        └─ For built-in tools (Bash, Read, Grep):
             Currently NOT replaceable via PostToolUse hooks.
             Fall back to: additionalContext with the summary.
             Full fix requires Anthropic adding updatedToolOutput for built-in tools.
             (See Draft 2 — the proposal for this API change.)
```

### Scope: what this tool does and does not do

**Does:**
- Index large tool output into a searchable FTS5 knowledge base
- Provide a `search` MCP tool for on-demand retrieval
- Provide an `index` MCP tool for manual content indexing
- Replace MCP tool output with summaries (via `updatedMCPToolOutput`)
- Track session statistics (bytes saved, calls per tool)

**Does not:**
- Execute code or shell commands (no `execute`, no `batch_execute`)
- Fetch URLs (no `fetch_and_index` — let WebFetch/MCP tools handle fetching)
- Pass credentials to any subprocess
- Need network access
- Need filesystem access beyond a temp SQLite database

### What's new vs. what exists

The FTS5 knowledge base, `search`, and `index` tools already exist in [context-mode](https://github.com/mksglu/claude-context-mode) (`src/store.ts`, ~800 lines) and are well-built. We should reuse or adapt that code with credit, not rewrite it.

**What's new in this design:**

1. **PostToolUse hook for automatic MCP tool output interception** — context-mode has no PostToolUse hooks and [cannot intercept MCP tool responses](https://news.ycombinator.com/item?id=47193064) (independently confirmed by community testing). Our hook intercepts output automatically after any MCP tool runs — the LLM doesn't need to change its behavior.

2. **No execution engine** — context-mode's `PolyglotExecutor` (11-language subprocess runner), `fetch_and_index` (URL fetcher), `execute_file` (file processor), and the associated credential passthrough (`#buildSafeEnv` with 25+ env vars) are all absent. Our tool only indexes text and serves search queries. Zero credentials, zero network, zero subprocess execution.

3. **Content-aware chunking** — context-mode chunks by markdown headings and plain text. We add JSON-by-key and stack-trace-aware chunking for developer payloads.

### Components

```
output-indexer/
├── src/
│   ├── server.ts          # MCP server: search + index + stats tools
│   └── store.ts           # FTS5 knowledge base: chunk, index, search
│                          #   (adapted from context-mode's store.ts with credit)
├── hooks/
│   ├── posttooluse.mjs    # PostToolUse hook: threshold check, index, replace
│   └── hooks.json         # Hook registration config
├── tests/
│   ├── store.test.ts      # FTS5 indexing and search tests
│   ├── hook.test.ts       # Hook behavior tests (threshold, replacement)
│   └── e2e.test.ts        # End-to-end: simulate tool output → hook → search
├── package.json
├── tsconfig.json
└── README.md
```

### Component 1: FTS5 Knowledge Base (`src/store.ts`)

SQLite FTS5 virtual table with BM25 ranking for full-text search.

**Schema:**
```sql
-- Main search table (porter stemming)
CREATE VIRTUAL TABLE chunks USING fts5(
  title,       -- Section heading breadcrumb ("# Setup > ## Installation")
  content,     -- Chunk text
  source,      -- Label for grouping ("playwright-snapshot-1")
  tokenize='porter'
);

-- Trigram fallback for substring matching
CREATE VIRTUAL TABLE chunks_trigram USING fts5(
  content,
  source,
  tokenize='trigram'
);

-- Source metadata
CREATE TABLE sources (
  label TEXT PRIMARY KEY,
  chunk_count INTEGER,
  indexed_at TEXT
);
```

**Chunking strategy (content-aware, in priority order):**

1. **JSON**: If content parses as valid JSON, chunk by top-level keys. Each key-value pair becomes a chunk with the key as the title. Nested objects are serialized within their parent chunk (not split further) to preserve structure.

2. **Stack traces / indentation blocks**: Detect continuous indentation patterns (e.g., `    at Module._compile`, Python tracebacks with `  File "..."`, Go panic traces). Keep the entire indentation block together as one chunk — splitting mid-stack-trace destroys diagnostic value.

3. **Markdown headings**: Split at H1-H4 boundaries. Track heading hierarchy as a breadcrumb stack (e.g., `"# API > ## Auth > ### OAuth"`). Keep fenced code blocks intact — never split inside `` ``` `` delimiters. Horizontal rules (`---`) flush the current section.

4. **Plain text (fallback)**: Split at blank-line boundaries (natural paragraphs). If no blank lines, fall back to fixed-size groups of 50 lines with **5-10 line overlap** (not 2 — the LLM needs enough overlap to re-establish context when retrieving a chunk).

- Max chunk size: 5KB
- Detection order matters: try JSON parse first (fast fail), then scan first 20 lines for indentation patterns, then check for markdown headings, then fall back to plain text.

**Search strategy (three-layer fallback):**
1. Porter stemming (`chunks` table) — handles word variations (running→run)
2. Trigram substring (`chunks_trigram` table) — handles partial matches (useEff→useEffect)
3. Levenshtein fuzzy correction — edit distance 1-3 depending on word length, re-search with corrected query

**Public API:**
```typescript
interface ContentStore {
  index(opts: { content: string; source: string }): { label: string; totalChunks: number };
  search(query: string, opts?: { source?: string; limit?: number }): SearchResult[];
  cleanup(): void;  // Delete temp DB
}

interface SearchResult {
  title: string;
  content: string;
  source: string;
  score: number;
}
```

**Lifecycle:**
- Database created in `/tmp/output-indexer-{pid}.db` on first `index()` call
- WAL mode + NORMAL synchronous for speed
- Deleted on process exit via `process.on('exit')` handler (ephemeral, per-session)

**Orphaned database cleanup:**

`process.on('exit')` does not run on SIGKILL or crashes. On server startup, scan `/tmp` for stale databases and remove them:

```typescript
import { readdirSync, unlinkSync, statSync } from "node:fs";

function cleanupOrphanedDBs(): number {
  let cleaned = 0;
  const prefix = "output-indexer-";
  for (const file of readdirSync("/tmp").filter(f => f.startsWith(prefix))) {
    const pid = parseInt(file.replace(prefix, "").replace(".db", ""));
    if (isNaN(pid)) continue;
    // Check if PID is still alive
    try {
      process.kill(pid, 0); // signal 0 = existence check, no actual signal sent
    } catch {
      // Process doesn't exist — safe to delete
      try {
        const dbPath = `/tmp/${file}`;
        unlinkSync(dbPath);
        // Also clean WAL and SHM files
        try { unlinkSync(dbPath + "-wal"); } catch {}
        try { unlinkSync(dbPath + "-shm"); } catch {}
        cleaned++;
      } catch {}
    }
  }
  return cleaned;
}
```

Additionally, databases older than 24 hours are cleaned regardless of PID status (the PID may have been recycled by the OS).

### Component 2: MCP Server (`src/server.ts`)

Minimal MCP server exposing three tools:

**`search`** — Query indexed content
```typescript
// Input
{ queries: string[], source?: string, limit?: number }
// Output
Matching chunks with title, content, source, score
// Batched: all queries in one call, results grouped by query
```

**`index`** — Manually index content (for cases where the LLM wants to store something)
```typescript
// Input
{ content: string, source: string }
// Output
{ label: string, totalChunks: number }
```

**`stats`** — Session statistics
```typescript
// Output
{ totalBytesIndexed: number, totalBytesReturned: number, savingsRatio: number, callCounts: Record<string, number> }
```

The server tracks:
- `bytesIndexed`: total raw bytes that went into the FTS5 store
- `bytesReturned`: total bytes sent back to context (search results, summaries)
- Per-tool call counts

### Component 3: PostToolUse Hook (`hooks/posttooluse.mjs`)

**Input** (received on stdin from Claude Code):
```jsonc
{
  "hook_event_name": "PostToolUse",
  "tool_name": "mcp__plugin_playwright_playwright__browser_snapshot",
  "tool_input": { /* original tool arguments */ },
  "tool_response": { /* the tool's output — this is what we index */ }
}
```

**Logic:**
```
1. Parse stdin JSON
2. Extract tool_response content (text from content array)
3. Calculate byte size
4. If size < THRESHOLD (5KB): exit 0 (pass through, no change)
5. If size >= THRESHOLD:
   a. Write content to temp file
   b. Call the MCP server's index endpoint (via the shared FTS5 store)
   c. Build summary: "{size}KB indexed as '{source}'. Use search(queries: [...]) for details."
   d. Output JSON with updatedMCPToolOutput (for MCP tools)
6. Exit 0
```

**Hook ↔ MCP server communication:**

The hook and MCP server run as separate processes. They need to share the FTS5 database. Two options:

- **Option A (simpler):** Hook writes content to a temp file. Hook outputs `additionalContext` telling the LLM to call `index(content, source)`. The LLM makes the explicit call. Downside: extra round-trip, LLM has to cooperate.

- **Option B (better):** Hook and MCP server share the same SQLite database file path (deterministic: `/tmp/output-indexer-{ppid}.db` where ppid is Claude Code's PID). Hook writes directly to the DB using `better-sqlite3`. MCP server reads from the same DB. SQLite WAL mode handles concurrent access safely.

**Recommended: Option B.** The hook imports the same `ContentStore` class as the server. They share the DB file. No IPC needed.

**Hook registration** (`hooks/hooks.json`):
```jsonc
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__",
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/posttooluse.mjs"
        }]
      }
      // When Anthropic adds updatedToolOutput for built-in tools,
      // add matchers for "Bash", "Read", "Grep" here.
    ]
  }
}
```

The `"mcp__"` matcher prefix catches all MCP tool calls (Playwright, Context7, GitHub, etc.) in one rule.

### Threshold and summary design

**Threshold:** 5KB (5120 bytes). Configurable via `OUTPUT_INDEXER_THRESHOLD` env var.

Rationale: outputs under 5KB are small enough that direct context inclusion is fine. Above 5KB, the content likely contains structure (headings, repeated patterns, large code blocks) that benefits from indexed retrieval over full inclusion. This also preserves prompt caching — replacement happens before output enters the conversation, so the LLM's message history stays stable across turns.

**Alternative approach: subagents.** Spawning work in subagents naturally scopes context — only the subagent's summary returns to the parent. This works well for independent tasks but adds latency and can't help when the LLM needs tool output in its main conversation thread (e.g., reviewing a Playwright snapshot mid-task).

**Summary format (prompt-engineered to prevent hallucination):**

The replacement text must make it unambiguous that the LLM does NOT have the content and MUST search. A polite suggestion gets ignored; a clear statement of fact works:

```
[Output indexed, not in context] {tool_name}: {size}KB ({chunk_count} sections).
You do NOT have this content. You MUST call search(queries: [...], source: "{source_label}")
before answering questions about it. Do not guess or summarize from memory.
```

Rationale: LLMs are reluctant to make sequential tool calls when they think they can guess the answer. The phrase "You do NOT have this content" is a factual statement (the original output was replaced) that prevents confabulation. Empirical testing should compare variants — overly aggressive phrasing (fake errors, SYSTEM prefixes) risks confusing the LLM about actual errors.

The source label is derived from the tool name + a counter: `playwright-snapshot-1`, `context7-react-hooks-1`, etc.

### Use cases

The `index` and `search` MCP tools serve three distinct use cases:

| Use case | Who calls `index()`? | Example |
|----------|---------------------|---------|
| **Tool output compression** (primary) | PostToolUse hook, automatically | Playwright snapshot → 56KB indexed → 200B summary |
| **LLM working memory** | The LLM itself, manually | LLM stores a long analysis for later retrieval instead of keeping it all in context |
| **Documentation reference** | The LLM itself, after fetching | LLM fetches docs via WebFetch, then calls `index()` to store for repeated search |

The PostToolUse hook automates the first use case. The `index` MCP tool enables the second and third. All three share the same FTS5 store and `search` tool.

### Testing strategy

#### Unit tests (`tests/store.test.ts`)

| Test | What it verifies |
|------|-----------------|
| `index_markdown_chunks_by_heading` | Markdown split at H1-H4, code blocks intact |
| `index_plain_text_by_blank_lines` | Plain text chunked at paragraph boundaries |
| `index_json_by_top_level_keys` | Valid JSON chunked by top-level keys, nested structure preserved |
| `index_json_invalid_falls_through` | Invalid JSON falls through to markdown/plaintext chunking |
| `index_stack_trace_kept_together` | Node.js/Python/Go stack traces not split mid-trace |
| `index_mixed_content_detection` | Content with markdown headings + embedded JSON uses heading strategy |
| `plain_text_overlap_5_lines` | Adjacent chunks share 5+ lines of overlap |
| `search_porter_stemming` | "running" matches "run", "configured" matches "config" |
| `search_trigram_fallback` | "useEff" matches "useEffect" |
| `search_fuzzy_correction` | "playright" matches "playwright" (1 edit) |
| `search_source_filter` | `source: "snapshot-1"` only returns chunks from that source |
| `search_batched_queries` | Multiple queries return grouped results in one call |
| `index_large_content` | 100KB content indexes without error, search returns results |
| `cleanup_deletes_db` | After cleanup(), DB file is gone |
| `cleanup_orphaned_dbs_on_startup` | DBs from dead PIDs cleaned on server start |

#### Hook tests (`tests/hook.test.ts`)

| Test | What it verifies |
|------|-----------------|
| `small_output_passes_through` | Output < 5KB → hook exits 0, no JSON output |
| `large_mcp_output_replaced` | Output >= 5KB from MCP tool → `updatedMCPToolOutput` in JSON |
| `non_mcp_tool_ignored` | Built-in tool output → hook exits 0 (until API supports it) |
| `summary_format_correct` | Replacement text includes size, source label, search instructions |
| `content_indexed_in_store` | After hook runs, `search()` on the store returns the content |
| `threshold_configurable` | `OUTPUT_INDEXER_THRESHOLD=1024` → 1KB threshold |

#### End-to-end test (`tests/e2e.test.ts`)

This is the critical test that proves the whole system works.

**Setup:**
1. Start the MCP server (in-process or subprocess)
2. Create a mock PostToolUse hook input with a large (20KB) Playwright-style output

**Test flow:**
```
1. Feed mock PostToolUse input (20KB MCP tool output) to hook via stdin
2. Assert: hook outputs JSON with updatedMCPToolOutput (summary, not full content)
3. Assert: summary is < 500 bytes
4. Assert: summary contains source label and search instructions
5. Call MCP server's search tool with queries about the content
6. Assert: search results contain relevant chunks from the original 20KB
7. Assert: search results are < 2KB (not the full 20KB)
8. Call MCP server's stats tool
9. Assert: bytesIndexed ≈ 20KB, bytesReturned < 3KB
```

**What this proves:**
- Tool output is intercepted and indexed (not lost)
- Context receives a summary (not the full output)
- Content is retrievable via search (not truncated away)
- The savings are real and measurable

**How to run:**
```bash
# All tests
uv run npx tsx tests/store.test.ts
uv run npx tsx tests/hook.test.ts
uv run npx tsx tests/e2e.test.ts

# Or if using a test runner
npm test
```

### Success criteria

The implementation is complete when:

1. **PostToolUse hook intercepts MCP tool output above threshold** — verified by hook tests
2. **Content is indexed into FTS5 and searchable** — verified by store tests
3. **LLM receives summary instead of full output** — verified by e2e test
4. **LLM can retrieve specific information via search** — verified by e2e test
5. **No credentials, network access, or subprocess execution involved** — verified by code review (the server has no `execute` tool, no env var passthrough, no `spawn`)
6. **Context savings are measurable** — verified by stats tool showing > 80% reduction on outputs > 5KB

### Dependencies

```json
{
  "@modelcontextprotocol/sdk": "^1.26.0",
  "better-sqlite3": "^12.6.2",
  "zod": "^3.25.0"
}
```

Three production dependencies. No credential helpers, no sandbox runtimes, no HTTP libraries. `better-sqlite3` is the heaviest (native module) but it's well-maintained and provides FTS5 support that pure-JS SQLite wrappers don't.

### Migration / coexistence with context-mode

If users currently have context-mode installed:
- This tool handles MCP tool output via PostToolUse (new capability context-mode doesn't have)
- context-mode's Bash curl/wget blocking and subagent routing can coexist if desired
- Long-term, this tool replaces context-mode's output processing role entirely

### Future extensions (not in scope for v1)

- **Built-in tool output replacement**: When Anthropic adds `updatedToolOutput` for built-in tools, add Bash/Read/Grep matchers to the hook config. No code changes needed — just wider hook registration.
- **Vocabulary hints**: Return distinctive terms (high-IDF words, identifiers) from indexed content so the LLM knows what to search for.
- **Configurable per-tool thresholds**: Some tools (Playwright) always produce large output; others rarely do.
- **PreToolUse suggestions**: For Read/Grep, add `additionalContext` suggesting search if content was previously indexed.
- **Prompt variant A/B testing**: The replacement text prompt is critical to adoption. Ship with telemetry that tracks how often the LLM calls `search()` after receiving a replacement vs. proceeding without searching. Iterate on phrasing based on data.
