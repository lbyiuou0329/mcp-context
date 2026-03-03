#!/usr/bin/env node
/**
 * PostToolUse hook for mcp-context.
 *
 * Intercepts MCP tool output after execution. If the output exceeds a
 * byte threshold, indexes it into the shared FTS5 knowledge base and
 * replaces the output with a compact summary + search instructions.
 *
 * Shares the same SQLite DB as the MCP server via deterministic path:
 *   /tmp/output-indexer-{ppid}.db
 *
 * The hook imports ContentStore directly — no IPC needed. SQLite WAL
 * mode handles concurrent reads/writes safely.
 *
 * IMPORTANT: Never call process.exit() — it kills the process before
 * stdio flushes. Just return from main() and let Node exit naturally.
 */

import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const THRESHOLD = parseInt(process.env.OUTPUT_INDEXER_THRESHOLD ?? "5120", 10);

const sourceCounters = {};

function makeSourceLabel(toolName) {
  const parts = toolName.replace(/^mcp__/, "").split("__");
  const short = parts.length >= 2
    ? `${parts[0].split("_").pop()}-${parts.slice(1).join("-")}`
    : parts[0];

  const base = short.slice(0, 40);
  sourceCounters[base] = (sourceCounters[base] ?? 0) + 1;
  return `${base}-${sourceCounters[base]}`;
}

function extractText(toolResponse) {
  if (typeof toolResponse === "string") return toolResponse;

  if (toolResponse && typeof toolResponse === "object") {
    if (Array.isArray(toolResponse.content)) {
      return toolResponse.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    }
    if (typeof toolResponse.text === "string") return toolResponse.text;
    return JSON.stringify(toolResponse, null, 2);
  }

  return String(toolResponse ?? "");
}

function chunkText(text) {
  const lines = text.split("\n");
  const linesPerChunk = 50;
  const overlap = 5;
  const step = Math.max(linesPerChunk - overlap, 1);
  const chunks = [];

  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + linesPerChunk);
    if (slice.length === 0) break;
    const firstLine = (slice[0] ?? "").trim().slice(0, 80);
    chunks.push({
      title: firstLine || `Lines ${i + 1}-${i + slice.length}`,
      content: slice.join("\n"),
    });
  }

  return chunks;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    // If stdin is already ended (piped and closed), resume to trigger events
    process.stdin.resume();
  });
}

async function main() {
  const input = await readStdin();

  if (!input.trim()) return;

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    return;
  }

  const toolName = hookData.tool_name ?? "";
  const toolResponse = hookData.tool_response;

  // Only intercept MCP tool calls (prefixed with "mcp__")
  if (!toolName.startsWith("mcp__")) return;

  // Don't intercept our own tools
  if (toolName.includes("mcp_context") || toolName.includes("mcp-context")) return;

  const text = extractText(toolResponse);
  const byteSize = Buffer.byteLength(text, "utf-8");

  // Below threshold — pass through
  if (byteSize < THRESHOLD) return;

  // Above threshold — index and replace
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");

    const parentPid = process.ppid;
    const dbPath = join(tmpdir(), `output-indexer-${parentPid}.db`);

    let totalChunks = 0;
    const sourceLabel = makeSourceLabel(toolName);

    let distinctiveTerms = [];

    // Try built ContentStore for content-aware chunking + vocabulary hints
    try {
      const storePath = join(__dirname, "..", "build", "store.js");
      const { ContentStore } = await import(storePath);
      const store = new ContentStore(dbPath);
      const result = store.index(text, sourceLabel);
      totalChunks = result.totalChunks;
      distinctiveTerms = store.getDistinctiveTerms(sourceLabel, 20);
      store.close();
    } catch {
      // Fallback: simple line-based chunking
      const db = new Database(dbPath, { timeout: 5000 });
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");

      db.exec(`
        CREATE TABLE IF NOT EXISTS sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          label TEXT NOT NULL,
          chunk_count INTEGER NOT NULL DEFAULT 0,
          indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
          title, content, source_id UNINDEXED,
          tokenize='porter unicode61'
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
          title, content, source_id UNINDEXED,
          tokenize='trigram'
        );
        CREATE TABLE IF NOT EXISTS vocabulary (
          word TEXT PRIMARY KEY
        );
      `);

      const chunks = chunkText(text);

      const insertSource = db.prepare(
        "INSERT INTO sources (label, chunk_count) VALUES (?, ?)"
      );
      const insertChunk = db.prepare(
        "INSERT INTO chunks (title, content, source_id) VALUES (?, ?, ?)"
      );
      const insertChunkTrigram = db.prepare(
        "INSERT INTO chunks_trigram (title, content, source_id) VALUES (?, ?, ?)"
      );

      const transaction = db.transaction(() => {
        const info = insertSource.run(sourceLabel, chunks.length);
        const sourceId = Number(info.lastInsertRowid);
        for (const chunk of chunks) {
          insertChunk.run(chunk.title, chunk.content, sourceId);
          insertChunkTrigram.run(chunk.title, chunk.content, sourceId);
        }
      });

      transaction();
      totalChunks = chunks.length;
      db.close();
    }

    const sizeKB = (byteSize / 1024).toFixed(1);

    const termsLine = distinctiveTerms.length > 0
      ? `\nSearchable terms: ${distinctiveTerms.join(", ")}`
      : "";

    const summary = [
      `[Output indexed, not in context] ${toolName}: ${sizeKB}KB (${totalChunks} sections).`,
      `You do NOT have this content. You MUST call search(queries: [...], source: "${sourceLabel}")`,
      `before answering questions about it. Do not guess or summarize from memory.`,
    ].join("\n") + termsLine;

    const hookResponse = {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedMCPToolOutput: summary,
      },
    };

    process.stdout.write(JSON.stringify(hookResponse));
  } catch (err) {
    console.error(`[mcp-context hook] indexing failed: ${err.message}`);
  }
}

main();
