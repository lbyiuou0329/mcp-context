/**
 * ContentStore — FTS5 BM25-based knowledge base for mcp-context.
 *
 * Adapted from claude-context-mode's store.ts (MIT, Mert Koseoğlu)
 * with added JSON-by-key chunking and stack-trace-aware chunking.
 *
 * Chunking priority: JSON → Stack traces → Markdown headings → Plain text
 * Search fallback: Porter stemming → Trigram substring → Levenshtein fuzzy
 */

import type DatabaseConstructor from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { createRequire } from "node:module";
import { readdirSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────
// Lazy-load better-sqlite3
// ─────────────────────────────────────────────────────────

let _Database: typeof DatabaseConstructor | null = null;
function loadDatabase(): typeof DatabaseConstructor {
  if (!_Database) {
    const require = createRequire(import.meta.url);
    _Database = require("better-sqlite3") as typeof DatabaseConstructor;
  }
  return _Database;
}

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface Chunk {
  title: string;
  content: string;
  hasCode: boolean;
}

export interface IndexResult {
  label: string;
  totalChunks: number;
}

export interface SearchResult {
  title: string;
  content: string;
  source: string;
  score: number;
  highlighted?: string;
  matchLayer?: "porter" | "trigram" | "fuzzy";
}

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const MAX_CHUNK_BYTES = 5000;
const DB_PREFIX = "output-indexer-";
const STALE_DB_HOURS = 24;

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "his", "how", "its", "may",
  "new", "now", "old", "see", "way", "who", "did", "get", "got", "let",
  "say", "she", "too", "use", "will", "with", "this", "that", "from",
  "they", "been", "have", "many", "some", "them", "than", "each", "make",
  "like", "just", "over", "such", "take", "into", "year", "your", "good",
  "could", "would", "about", "which", "their", "there", "other", "after",
  "should", "through", "also", "more", "most", "only", "very", "when",
  "what", "then", "these", "those", "being", "does", "done", "both",
  "same", "still", "while", "where", "here", "were", "much",
]);

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function sanitizeQuery(query: string): string {
  const words = query
    .replace(/['"(){}[\]*:^~]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 0 &&
        !["AND", "OR", "NOT", "NEAR"].includes(w.toUpperCase()),
    );
  if (words.length === 0) return '""';
  return words.map((w) => `"${w}"`).join(" OR ");
}

function sanitizeTrigramQuery(query: string): string {
  const cleaned = query.replace(/["'(){}[\]*:^~]/g, "").trim();
  if (cleaned.length < 3) return "";
  const words = cleaned.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length === 0) return "";
  return words.map((w) => `"${w}"`).join(" OR ");
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

function maxEditDistance(wordLength: number): number {
  if (wordLength <= 4) return 1;
  if (wordLength <= 12) return 2;
  return 3;
}

/** Deterministic DB path shared between hook and MCP server. */
export function getDbPath(pid?: number): string {
  const id = pid ?? process.pid;
  return join(tmpdir(), `${DB_PREFIX}${id}.db`);
}

// ─────────────────────────────────────────────────────────
// Stale DB cleanup
// ─────────────────────────────────────────────────────────

export function cleanupStaleDBs(): number {
  const dir = tmpdir();
  let cleaned = 0;
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const match = file.match(/^output-indexer-(\d+)\.db$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (pid === process.pid) continue;

      const dbPath = join(dir, file);

      // Always clean DBs older than 24h (PID may have been recycled)
      try {
        const stat = statSync(dbPath);
        const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
        if (ageHours > STALE_DB_HOURS) {
          for (const suffix of ["", "-wal", "-shm"]) {
            try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
          }
          cleaned++;
          continue;
        }
      } catch { /* ignore stat errors */ }

      // Check if PID is still alive
      try {
        process.kill(pid, 0);
      } catch {
        for (const suffix of ["", "-wal", "-shm"]) {
          try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
        }
        cleaned++;
      }
    }
  } catch { /* ignore readdir errors */ }
  return cleaned;
}

// ─────────────────────────────────────────────────────────
// Content detection
// ─────────────────────────────────────────────────────────

type ContentType = "json" | "stack-trace" | "markdown" | "plain";

function detectContentType(text: string): ContentType {
  // 1. JSON: try parse first (fast fail)
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch { /* not valid JSON */ }
  }

  // 2. Stack traces: scan first 20 lines for indentation patterns
  const firstLines = text.split("\n").slice(0, 20);
  const stackPatterns = [
    /^\s+at\s+/,                          // Node.js: "    at Module._compile"
    /^\s+File\s+"/,                        // Python: '  File "..."'
    /^goroutine\s+\d+/,                    // Go: "goroutine 1 [running]:"
    /^\s+\S+\.\S+\(\S+:\d+\)/,           // Java/Go: "    pkg.Func(file:line)"
    /^Traceback \(most recent call last\)/, // Python traceback header
    /^panic:/,                             // Go panic
  ];
  const stackLineCount = firstLines.filter(
    (line) => stackPatterns.some((p) => p.test(line))
  ).length;
  if (stackLineCount >= 3) return "stack-trace";

  // 3. Markdown: check for headings
  const headingCount = firstLines.filter((l) => /^#{1,4}\s+/.test(l)).length;
  if (headingCount >= 1) return "markdown";

  // 4. Fallback: plain text
  return "plain";
}

// ─────────────────────────────────────────────────────────
// ContentStore
// ─────────────────────────────────────────────────────────

export class ContentStore {
  #db: DatabaseInstance;
  #dbPath: string;

  constructor(dbPath?: string) {
    const Database = loadDatabase();
    this.#dbPath = dbPath ?? getDbPath();
    this.#db = new Database(this.#dbPath, { timeout: 5000 });
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = NORMAL");
    this.#initSchema();
  }

  get dbPath(): string {
    return this.#dbPath;
  }

  // ── Schema ──

  #initSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        title,
        content,
        source_id UNINDEXED,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        title,
        content,
        source_id UNINDEXED,
        tokenize='trigram'
      );

      CREATE TABLE IF NOT EXISTS vocabulary (
        word TEXT PRIMARY KEY
      );
    `);
  }

  // ── Index ──

  index(content: string, source: string): IndexResult {
    if (!content || content.trim().length === 0) {
      this.#db.prepare(
        "INSERT INTO sources (label, chunk_count) VALUES (?, 0)",
      ).run(source);
      return { label: source, totalChunks: 0 };
    }

    const contentType = detectContentType(content);
    let chunks: Chunk[];

    switch (contentType) {
      case "json":
        chunks = this.#chunkJSON(content);
        break;
      case "stack-trace":
        chunks = this.#chunkStackTrace(content);
        break;
      case "markdown":
        chunks = this.#chunkMarkdown(content);
        break;
      case "plain":
        chunks = this.#chunkPlainText(content).map((c) => ({
          ...c,
          hasCode: false,
        }));
        break;
    }

    if (chunks.length === 0) {
      this.#db.prepare(
        "INSERT INTO sources (label, chunk_count) VALUES (?, 0)",
      ).run(source);
      return { label: source, totalChunks: 0 };
    }

    const insertSource = this.#db.prepare(
      "INSERT INTO sources (label, chunk_count) VALUES (?, ?)",
    );
    const insertChunk = this.#db.prepare(
      "INSERT INTO chunks (title, content, source_id) VALUES (?, ?, ?)",
    );
    const insertChunkTrigram = this.#db.prepare(
      "INSERT INTO chunks_trigram (title, content, source_id) VALUES (?, ?, ?)",
    );

    const transaction = this.#db.transaction(() => {
      const info = insertSource.run(source, chunks.length);
      const sourceId = Number(info.lastInsertRowid);
      for (const chunk of chunks) {
        insertChunk.run(chunk.title, chunk.content, sourceId);
        insertChunkTrigram.run(chunk.title, chunk.content, sourceId);
      }
      return sourceId;
    });

    transaction();
    this.#extractAndStoreVocabulary(content);

    return { label: source, totalChunks: chunks.length };
  }

  // ── Search (Layer 1: Porter stemming) ──

  search(query: string, limit: number = 3, source?: string): SearchResult[] {
    const sanitized = sanitizeQuery(query);
    const sourceFilter = source ? "AND sources.label LIKE ?" : "";

    const stmt = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        sources.label,
        bm25(chunks, 2.0, 1.0) AS score,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? ${sourceFilter}
      ORDER BY score
      LIMIT ?
    `);

    const params = source
      ? [sanitized, `%${source}%`, limit]
      : [sanitized, limit];

    const rows = stmt.all(...params) as Array<{
      title: string;
      content: string;
      label: string;
      score: number;
      highlighted: string;
    }>;

    return rows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.label,
      score: r.score,
      highlighted: r.highlighted,
    }));
  }

  // ── Search (Layer 2: Trigram substring) ──

  searchTrigram(query: string, limit: number = 3, source?: string): SearchResult[] {
    const sanitized = sanitizeTrigramQuery(query);
    if (!sanitized) return [];

    const sourceFilter = source ? "AND sources.label LIKE ?" : "";
    const stmt = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        sources.label,
        bm25(chunks_trigram, 2.0, 1.0) AS score,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? ${sourceFilter}
      ORDER BY score
      LIMIT ?
    `);

    const params = source
      ? [sanitized, `%${source}%`, limit]
      : [sanitized, limit];

    const rows = stmt.all(...params) as Array<{
      title: string;
      content: string;
      label: string;
      score: number;
      highlighted: string;
    }>;

    return rows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.label,
      score: r.score,
      highlighted: r.highlighted,
    }));
  }

  // ── Search (Layer 3: Fuzzy correction) ──

  fuzzyCorrect(query: string): string | null {
    const word = query.toLowerCase().trim();
    if (word.length < 3) return null;

    const maxDist = maxEditDistance(word.length);
    const candidates = this.#db
      .prepare("SELECT word FROM vocabulary WHERE length(word) BETWEEN ? AND ?")
      .all(word.length - maxDist, word.length + maxDist) as Array<{ word: string }>;

    let bestWord: string | null = null;
    let bestDist = maxDist + 1;

    for (const { word: candidate } of candidates) {
      if (candidate === word) return null; // exact match — no correction needed
      const dist = levenshtein(word, candidate);
      if (dist < bestDist) {
        bestDist = dist;
        bestWord = candidate;
      }
    }

    return bestDist <= maxDist ? bestWord : null;
  }

  // ── Unified fallback search ──

  searchWithFallback(query: string, limit: number = 3, source?: string): SearchResult[] {
    // Layer 1: Porter stemming
    const porterResults = this.search(query, limit, source);
    if (porterResults.length > 0) {
      return porterResults.map((r) => ({ ...r, matchLayer: "porter" as const }));
    }

    // Layer 2: Trigram substring
    const trigramResults = this.searchTrigram(query, limit, source);
    if (trigramResults.length > 0) {
      return trigramResults.map((r) => ({ ...r, matchLayer: "trigram" as const }));
    }

    // Layer 3: Fuzzy correction + re-search
    const words = query.toLowerCase().trim().split(/\s+/).filter((w) => w.length >= 3);
    const original = words.join(" ");
    const correctedWords = words.map((w) => this.fuzzyCorrect(w) ?? w);
    const correctedQuery = correctedWords.join(" ");

    if (correctedQuery !== original) {
      const fuzzyPorter = this.search(correctedQuery, limit, source);
      if (fuzzyPorter.length > 0) {
        return fuzzyPorter.map((r) => ({ ...r, matchLayer: "fuzzy" as const }));
      }
      const fuzzyTrigram = this.searchTrigram(correctedQuery, limit, source);
      if (fuzzyTrigram.length > 0) {
        return fuzzyTrigram.map((r) => ({ ...r, matchLayer: "fuzzy" as const }));
      }
    }

    return [];
  }

  // ── Stats ──

  getStats(): { sources: number; chunks: number } {
    const sources = (this.#db.prepare("SELECT COUNT(*) as c FROM sources").get() as { c: number })?.c ?? 0;
    const chunks = (this.#db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number })?.c ?? 0;
    return { sources, chunks };
  }

  // ── Distinctive terms (vocabulary hints for the LLM) ──

  getDistinctiveTerms(source: string, maxTerms: number = 30): string[] {
    const sourceRow = this.#db.prepare(
      "SELECT id, chunk_count FROM sources WHERE label = ?",
    ).get(source) as { id: number; chunk_count: number } | undefined;

    if (!sourceRow || sourceRow.chunk_count < 2) return [];

    const totalChunks = sourceRow.chunk_count;
    const sourceId = sourceRow.id;
    const minAppearances = 2;
    const maxAppearances = Math.max(3, Math.ceil(totalChunks * 0.4));

    const stmt = this.#db.prepare("SELECT content FROM chunks WHERE source_id = ?");
    const docFreq = new Map<string, number>();

    for (const row of stmt.iterate(sourceId) as Iterable<{ content: string }>) {
      const words = new Set(
        row.content
          .toLowerCase()
          .split(/[^\p{L}\p{N}_-]+/u)
          .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
      );
      for (const word of words) {
        docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
      }
    }

    const filtered = Array.from(docFreq.entries())
      .filter(([, count]) => count >= minAppearances && count <= maxAppearances);

    const scored = filtered.map(([word, count]) => {
      const idf = Math.log(totalChunks / count);
      const lenBonus = Math.min(word.length / 20, 0.5);
      const identifierBonus = /[_]/.test(word) ? 1.5 : word.length >= 12 ? 0.8 : 0;
      return { word, score: idf + lenBonus + identifierBonus };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxTerms)
      .map((s) => s.word);
  }

  // ── Cleanup ──

  cleanup(): void {
    try { this.#db.close(); } catch { /* ignore */ }
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(this.#dbPath + suffix); } catch { /* ignore */ }
    }
  }

  close(): void {
    this.#db.close();
  }

  // ── Vocabulary extraction ──

  #extractAndStoreVocabulary(content: string): void {
    const words = content
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

    const unique = [...new Set(words)];
    const insert = this.#db.prepare("INSERT OR IGNORE INTO vocabulary (word) VALUES (?)");

    this.#db.transaction(() => {
      for (const word of unique) {
        insert.run(word);
      }
    })();
  }

  // ── Chunking: JSON by top-level keys ──

  #chunkJSON(text: string): Chunk[] {
    try {
      const parsed = JSON.parse(text.trim());

      // Only chunk objects — arrays go to plain text
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        const serialized = JSON.stringify(parsed, null, 2);
        if (Buffer.byteLength(serialized) <= MAX_CHUNK_BYTES) {
          return [{ title: "JSON Array", content: serialized, hasCode: false }];
        }
        return this.#chunkPlainText(serialized).map((c) => ({ ...c, hasCode: false }));
      }

      const chunks: Chunk[] = [];
      const keys = Object.keys(parsed);

      for (const key of keys) {
        const value = JSON.stringify(parsed[key], null, 2);
        if (Buffer.byteLength(value) > MAX_CHUNK_BYTES) {
          const subChunks = this.#chunkPlainText(value);
          for (const sub of subChunks) {
            chunks.push({ title: `${key} > ${sub.title}`, content: sub.content, hasCode: false });
          }
        } else {
          chunks.push({ title: key, content: `${key}: ${value}`, hasCode: false });
        }
      }

      return chunks;
    } catch {
      return this.#chunkMarkdown(text);
    }
  }

  // ── Chunking: Stack traces ──

  #chunkStackTrace(text: string): Chunk[] {
    const lines = text.split("\n");
    const chunks: Chunk[] = [];
    let currentBlock: string[] = [];
    let currentTitle = "";
    let inIndentedBlock = false;

    const flush = () => {
      const joined = currentBlock.join("\n").trim();
      if (joined.length === 0) return;
      chunks.push({
        title: currentTitle || joined.split("\n")[0].slice(0, 80),
        content: joined,
        hasCode: true,
      });
      currentBlock = [];
      currentTitle = "";
      inIndentedBlock = false;
    };

    for (const line of lines) {
      const isIndented = /^\s{2,}/.test(line);
      const isStackHeader = /^(Error|TypeError|RangeError|Traceback|panic:|goroutine\s)/.test(line);

      if (isStackHeader) {
        flush();
        currentTitle = line.slice(0, 80);
        currentBlock.push(line);
        inIndentedBlock = true;
      } else if (inIndentedBlock && isIndented) {
        currentBlock.push(line);
      } else if (inIndentedBlock && !isIndented && line.trim().length > 0) {
        flush();
        currentBlock.push(line);
      } else {
        currentBlock.push(line);
        if (!inIndentedBlock && isIndented) {
          inIndentedBlock = true;
        }
      }

      if (Buffer.byteLength(currentBlock.join("\n")) > MAX_CHUNK_BYTES) {
        flush();
      }
    }
    flush();

    return chunks;
  }

  // ── Chunking: Markdown by headings ──

  #chunkMarkdown(text: string): Chunk[] {
    const chunks: Chunk[] = [];
    const lines = text.split("\n");
    const headingStack: Array<{ level: number; text: string }> = [];
    let currentContent: string[] = [];
    let currentHeading = "";

    const flush = () => {
      const joined = currentContent.join("\n").trim();
      if (joined.length === 0) return;
      chunks.push({
        title: this.#buildTitle(headingStack, currentHeading),
        content: joined,
        hasCode: currentContent.some((l) => /^`{3,}/.test(l)),
      });
      currentContent = [];
    };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Horizontal rule separator
      if (/^[-_*]{3,}\s*$/.test(line)) {
        flush();
        i++;
        continue;
      }

      // Heading (H1-H4)
      const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        flush();
        const level = headingMatch[1].length;
        const heading = headingMatch[2].trim();

        while (
          headingStack.length > 0 &&
          headingStack[headingStack.length - 1].level >= level
        ) {
          headingStack.pop();
        }
        headingStack.push({ level, text: heading });
        currentHeading = heading;
        currentContent.push(line);
        i++;
        continue;
      }

      // Code block — collect entire block as a unit
      const codeMatch = line.match(/^(`{3,})(.*)?$/);
      if (codeMatch) {
        const fence = codeMatch[1];
        const codeLines: string[] = [line];
        i++;
        while (i < lines.length) {
          codeLines.push(lines[i]);
          if (lines[i].startsWith(fence) && lines[i].trim() === fence) {
            i++;
            break;
          }
          i++;
        }
        currentContent.push(...codeLines);
        continue;
      }

      currentContent.push(line);
      i++;
    }

    flush();
    return chunks;
  }

  // ── Chunking: Plain text ──

  #chunkPlainText(text: string): Array<{ title: string; content: string }> {
    // Try blank-line splitting first
    const sections = text.split(/\n\s*\n/);
    if (
      sections.length >= 3 &&
      sections.length <= 200 &&
      sections.every((s) => Buffer.byteLength(s) < MAX_CHUNK_BYTES)
    ) {
      return sections
        .map((section, i) => {
          const trimmed = section.trim();
          const firstLine = trimmed.split("\n")[0].slice(0, 80);
          return { title: firstLine || `Section ${i + 1}`, content: trimmed };
        })
        .filter((s) => s.content.length > 0);
    }

    const lines = text.split("\n");
    const linesPerChunk = 50;

    if (lines.length <= linesPerChunk) {
      return [{ title: lines[0]?.trim().slice(0, 80) || "Output", content: text }];
    }

    // Fixed-size groups with 5-line overlap (per PRD)
    const chunks: Array<{ title: string; content: string }> = [];
    const overlap = 5;
    const step = Math.max(linesPerChunk - overlap, 1);

    for (let i = 0; i < lines.length; i += step) {
      const slice = lines.slice(i, i + linesPerChunk);
      if (slice.length === 0) break;
      const firstLine = slice[0]?.trim().slice(0, 80);
      chunks.push({
        title: firstLine || `Lines ${i + 1}-${i + slice.length}`,
        content: slice.join("\n"),
      });
    }

    return chunks;
  }

  #buildTitle(
    headingStack: Array<{ level: number; text: string }>,
    currentHeading: string,
  ): string {
    if (headingStack.length === 0) return currentHeading || "Untitled";
    return headingStack.map((h) => h.text).join(" > ");
  }
}
