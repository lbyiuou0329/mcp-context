#!/usr/bin/env node
/**
 * MCP server for mcp-context: search, index, stats.
 *
 * No execution engine. No network. No credentials.
 * Just indexes text and serves search queries.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ContentStore, cleanupStaleDBs, type SearchResult } from "./store.js";

const VERSION = "0.1.0";

// ─────────────────────────────────────────────────────────
// Lazy store — created on first use
// ─────────────────────────────────────────────────────────

let _store: ContentStore | null = null;
function getStore(): ContentStore {
  if (!_store) {
    _store = new ContentStore();
  }
  return _store;
}

// ─────────────────────────────────────────────────────────
// Session statistics
// ─────────────────────────────────────────────────────────

const sessionStats = {
  calls: {} as Record<string, number>,
  bytesIndexed: 0,
  bytesReturned: {} as Record<string, number>,
  sessionStart: Date.now(),
};

function trackCall(tool: string, returnedBytes: number): void {
  sessionStats.calls[tool] = (sessionStats.calls[tool] ?? 0) + 1;
  sessionStats.bytesReturned[tool] = (sessionStats.bytesReturned[tool] ?? 0) + returnedBytes;
}

// ─────────────────────────────────────────────────────────
// Search throttling — prevents the LLM from dumping all
// indexed content back into context via repeated searches
// ─────────────────────────────────────────────────────────

const THROTTLE_AFTER = 5;   // reduce results after this many calls
const BLOCK_AFTER = 10;     // hard block after this many calls
let searchCallCount = 0;

// Reset throttle every 2 minutes (the LLM may legitimately
// need many searches across a long session)
setInterval(() => { searchCallCount = 0; }, 120_000).unref();

// ─────────────────────────────────────────────────────────
// Snippet extraction — returns windows around matching
// terms instead of full chunk content
//
// Uses FTS5 highlight() STX/ETX markers to find match
// positions. Falls back to indexOf on raw query terms.
// ─────────────────────────────────────────────────────────

const STX = "\x02";
const ETX = "\x03";

/** Parse FTS5 highlight markers to find match positions in clean text. */
function positionsFromHighlight(highlighted: string): number[] {
  const positions: number[] = [];
  let cleanOffset = 0;
  let i = 0;

  while (i < highlighted.length) {
    if (highlighted[i] === STX) {
      positions.push(cleanOffset);
      i++;
      while (i < highlighted.length && highlighted[i] !== ETX) {
        cleanOffset++;
        i++;
      }
      if (i < highlighted.length) i++;
    } else {
      cleanOffset++;
      i++;
    }
  }

  return positions;
}

function extractSnippet(
  content: string,
  query: string,
  maxLen: number,
  highlighted?: string,
): string {
  if (content.length <= maxLen) return content;

  // Derive match positions from FTS5 highlight markers
  const positions: number[] = [];

  if (highlighted) {
    for (const pos of positionsFromHighlight(highlighted)) {
      positions.push(pos);
    }
  }

  // Fallback: indexOf on raw query terms
  if (positions.length === 0) {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const lower = content.toLowerCase();
    for (const term of terms) {
      let idx = lower.indexOf(term);
      while (idx !== -1) {
        positions.push(idx);
        idx = lower.indexOf(term, idx + 1);
      }
    }
  }

  // No matches — return prefix
  if (positions.length === 0) {
    return content.slice(0, maxLen) + "\n…";
  }

  // Sort positions, merge overlapping windows
  positions.sort((a, b) => a - b);
  const WINDOW = 300;
  const windows: Array<[number, number]> = [];

  for (const pos of positions) {
    const start = Math.max(0, pos - WINDOW);
    const end = Math.min(content.length, pos + WINDOW);
    if (windows.length > 0 && start <= windows[windows.length - 1][1]) {
      windows[windows.length - 1][1] = end;
    } else {
      windows.push([start, end]);
    }
  }

  // Collect windows until maxLen
  const parts: string[] = [];
  let total = 0;
  for (const [start, end] of windows) {
    if (total >= maxLen) break;
    const part = content.slice(start, Math.min(end, start + (maxLen - total)));
    parts.push(
      (start > 0 ? "…" : "") + part + (end < content.length ? "…" : ""),
    );
    total += part.length;
  }

  return parts.join("\n\n");
}

// ─────────────────────────────────────────────────────────
// Server setup
// ─────────────────────────────────────────────────────────

const server = new McpServer({
  name: "mcp-context",
  version: VERSION,
});

// ── search tool ──

server.registerTool(
  "search",
  {
    title: "Search Indexed Content",
    description:
      "Search indexed content. Pass ALL search questions as queries array in ONE call.\n\n" +
      "TIPS: 2-4 specific terms per query. Use 'source' to scope results.",
    inputSchema: z.object({
      queries: z
        .array(z.string())
        .describe("Array of search queries. Batch ALL questions in one call."),
      source: z
        .string()
        .optional()
        .describe("Filter to a specific indexed source (partial match)."),
      limit: z
        .number()
        .optional()
        .default(3)
        .describe("Results per query (default: 3)"),
    }),
  },
  async (params) => {
    const store = getStore();
    const raw = params as Record<string, unknown>;

    // Accept both queries (array) and query (string)
    let queryList: string[] = [];
    if (Array.isArray(raw.queries) && raw.queries.length > 0) {
      queryList = raw.queries as string[];
    } else if (typeof raw.query === "string" && (raw.query as string).length > 0) {
      queryList = [raw.query as string];
    }

    if (queryList.length === 0) {
      return { content: [{ type: "text" as const, text: "Error: provide queries array." }] };
    }

    const source = raw.source as string | undefined;
    const limit = (raw.limit as number) ?? 3;

    searchCallCount++;

    // Throttling
    if (searchCallCount > BLOCK_AFTER) {
      return {
        content: [{
          type: "text" as const,
          text: `Search blocked: ${searchCallCount} calls in this window. ` +
            `Batch all queries in one search() call. Throttle resets in 2 minutes.`,
        }],
      };
    }

    const effectiveLimit = searchCallCount > THROTTLE_AFTER
      ? 1
      : limit;

    const allResults: string[] = [];
    const SNIPPET_MAX = 1500;

    for (const query of queryList) {
      const results: SearchResult[] = store.searchWithFallback(query, effectiveLimit, source);

      if (results.length === 0) {
        allResults.push(`## ${query}\n\nNo results found.`);
        continue;
      }

      const formatted = results.map((r) => {
        const layer = r.matchLayer ? ` [${r.matchLayer}]` : "";
        const snippet = extractSnippet(r.content, query, SNIPPET_MAX, r.highlighted);
        return `### ${r.title}${layer}\n[source: ${r.source}]\n\n${snippet}`;
      });

      allResults.push(`## ${query}\n\n${formatted.join("\n\n---\n\n")}`);
    }

    let output = allResults.join("\n\n" + "=".repeat(60) + "\n\n");

    if (searchCallCount >= THROTTLE_AFTER) {
      output += `\n\n⚠ search call #${searchCallCount}/${BLOCK_AFTER}. ` +
        `Results limited to ${effectiveLimit}/query. Batch queries in one call.`;
    }

    trackCall("search", Buffer.byteLength(output));

    return {
      content: [{ type: "text" as const, text: output }],
    };
  },
);

// ── index tool ──

server.registerTool(
  "index",
  {
    title: "Index Content",
    description:
      "Index content into the searchable knowledge base.\n\n" +
      "Use for storing documentation, API references, or any content you want to search later.\n" +
      "After indexing, use search() to retrieve specific sections on-demand.",
    inputSchema: z.object({
      content: z.string().describe("The text content to index"),
      source: z.string().describe("Label for the indexed content (e.g., 'react-docs', 'api-reference')"),
    }),
  },
  async ({ content, source }) => {
    const store = getStore();
    const result = store.index(content, source);

    sessionStats.bytesIndexed += Buffer.byteLength(content);

    // Vocabulary hints — tell the LLM what terms are searchable
    const terms = store.getDistinctiveTerms(source);
    const termsLine = terms.length > 0
      ? `\n\nSearchable terms: ${terms.join(", ")}`
      : "";

    const output = `Indexed ${result.totalChunks} sections as "${result.label}". ` +
      `Use search(queries: [...], source: "${result.label}") to retrieve.` +
      termsLine;

    trackCall("index", Buffer.byteLength(output));

    return {
      content: [{ type: "text" as const, text: output }],
    };
  },
);

// ── stats tool ──

server.registerTool(
  "stats",
  {
    title: "Session Statistics",
    description:
      "Returns context consumption statistics for the current session. " +
      "Shows bytes indexed, bytes returned, savings ratio, and per-tool call counts.",
    inputSchema: z.object({}),
  },
  async () => {
    const totalBytesReturned = Object.values(sessionStats.bytesReturned).reduce(
      (sum, b) => sum + b, 0,
    );
    const totalCalls = Object.values(sessionStats.calls).reduce(
      (sum, c) => sum + c, 0,
    );
    const uptimeMs = Date.now() - sessionStats.sessionStart;
    const uptimeMin = (uptimeMs / 60_000).toFixed(1);

    const savingsRatio = sessionStats.bytesIndexed > 0
      ? (sessionStats.bytesIndexed / Math.max(totalBytesReturned, 1)).toFixed(1)
      : "1.0";
    const reductionPct = sessionStats.bytesIndexed > 0
      ? ((1 - totalBytesReturned / sessionStats.bytesIndexed) * 100).toFixed(0)
      : "0";

    const kb = (b: number) => `${(b / 1024).toFixed(1)}KB`;
    const storeStats = _store ? _store.getStats() : { sources: 0, chunks: 0 };
    const tokens = Math.round(totalBytesReturned / 4).toLocaleString();

    const lines = [
      `| Metric | Value |`,
      `|--------|------:|`,
      `| Session | ${uptimeMin} min |`,
      `| Tool calls | ${totalCalls} |`,
      `| Bytes indexed | **${kb(sessionStats.bytesIndexed)}** |`,
      `| Entered context | ${kb(totalBytesReturned)} |`,
      `| Tokens consumed | ~${tokens} |`,
      `| **Context savings** | **${savingsRatio}x (${reductionPct}% reduction)** |`,
      `| Knowledge base | ${storeStats.sources} sources, ${storeStats.chunks} chunks |`,
      "",
      "Per-tool breakdown:",
      ...Object.entries(sessionStats.calls).map(
        ([tool, count]) =>
          `  ${tool}: ${count} calls, ${kb(sessionStats.bytesReturned[tool] ?? 0)} returned`,
      ),
    ];

    const output = lines.join("\n");
    trackCall("stats", Buffer.byteLength(output));

    return {
      content: [{ type: "text" as const, text: output }],
    };
  },
);

// ─────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  cleanupStaleDBs();

  process.on("exit", () => {
    if (_store) _store.cleanup();
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`mcp-context v${VERSION} running on stdio`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
