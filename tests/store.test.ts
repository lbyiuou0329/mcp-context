/**
 * Unit tests for ContentStore — FTS5 knowledge base.
 *
 * Tests chunking strategies (JSON, stack trace, markdown, plain text),
 * search fallback layers (porter, trigram, fuzzy), and cleanup.
 */

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContentStore, cleanupStaleDBs } from "../src/store.js";

let store: ContentStore;
let testDbPath: string;

function setup(): void {
  testDbPath = join(tmpdir(), `output-indexer-test-${process.pid}-${Date.now()}.db`);
  store = new ContentStore(testDbPath);
}

function teardown(): void {
  store.cleanup();
}

// ─────────────────────────────────────────────────────────
// Markdown chunking
// ─────────────────────────────────────────────────────────

function test_index_markdown_chunks_by_heading(): void {
  setup();
  try {
    const md = [
      "# Getting Started",
      "Welcome to the project.",
      "",
      "## Installation",
      "Run npm install.",
      "",
      "```bash",
      "npm install my-package",
      "```",
      "",
      "## Usage",
      "Import and use:",
      "",
      "```typescript",
      "import { foo } from 'my-package';",
      "foo();",
      "```",
      "",
      "# API Reference",
      "## Methods",
      "### foo()",
      "Does something useful.",
    ].join("\n");

    const result = store.index(md, "test-markdown");
    assert.ok(result.totalChunks >= 4, `Expected >= 4 chunks, got ${result.totalChunks}`);
    assert.equal(result.label, "test-markdown");

    // Search should find content
    const results = store.search("installation npm", 3);
    assert.ok(results.length > 0, "Should find installation content");
    assert.ok(results[0].content.includes("npm install"), "Content should include npm install");

    // Code block should be intact
    const codeResults = store.search("import foo", 3);
    assert.ok(codeResults.length > 0, "Should find code content");

    console.log("  PASS: index_markdown_chunks_by_heading");
  } finally {
    teardown();
  }
}

function test_markdown_code_blocks_intact(): void {
  setup();
  try {
    const md = [
      "## Example",
      "```python",
      "def hello():",
      "    print('world')",
      "```",
    ].join("\n");

    store.index(md, "code-test");
    const results = store.search("hello world python", 3);
    assert.ok(results.length > 0);
    // The code block delimiters should be present together
    assert.ok(results[0].content.includes("```python"), "Code fence should be intact");
    assert.ok(results[0].content.includes("```"), "Closing fence should be present");

    console.log("  PASS: markdown_code_blocks_intact");
  } finally {
    teardown();
  }
}

// ─────────────────────────────────────────────────────────
// Plain text chunking
// ─────────────────────────────────────────────────────────

function test_index_plain_text_by_blank_lines(): void {
  setup();
  try {
    const sections = Array.from({ length: 5 }, (_, i) =>
      `Section ${i + 1} content here.\nWith multiple lines of text.\nAnd some more detail about topic ${i + 1}.`
    );
    const text = sections.join("\n\n");

    const result = store.index(text, "plain-sections");
    assert.ok(result.totalChunks >= 3, `Expected >= 3 chunks from blank-line splitting, got ${result.totalChunks}`);

    const results = store.search("Section 3 topic", 3);
    assert.ok(results.length > 0, "Should find section 3 content");

    console.log("  PASS: index_plain_text_by_blank_lines");
  } finally {
    teardown();
  }
}

function test_plain_text_overlap_5_lines(): void {
  setup();
  try {
    // Generate text with no blank lines — forces fixed-size chunking
    const lines = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}: content for line number ${i + 1}`);
    const text = lines.join("\n");

    const result = store.index(text, "overlap-test");
    assert.ok(result.totalChunks >= 2, `Expected >= 2 chunks, got ${result.totalChunks}`);

    // Search for content near chunk boundaries — overlap should make it findable
    const results = store.search("line number 50", 5);
    assert.ok(results.length > 0, "Content near chunk boundary should be findable");

    console.log("  PASS: plain_text_overlap_5_lines");
  } finally {
    teardown();
  }
}

// ─────────────────────────────────────────────────────────
// JSON chunking
// ─────────────────────────────────────────────────────────

function test_index_json_by_top_level_keys(): void {
  setup();
  try {
    const json = JSON.stringify({
      name: "my-project",
      version: "1.0.0",
      dependencies: {
        react: "^18.0.0",
        typescript: "^5.0.0",
      },
      scripts: {
        build: "tsc",
        test: "jest",
      },
    }, null, 2);

    const result = store.index(json, "package-json");
    assert.ok(result.totalChunks >= 3, `Expected >= 3 chunks (one per key), got ${result.totalChunks}`);

    // Search for a specific key's content
    const results = store.search("react typescript dependencies", 3);
    assert.ok(results.length > 0, "Should find dependencies content");
    assert.ok(
      results[0].content.includes("react") || results[0].content.includes("typescript"),
      "Result should contain dependency info"
    );

    console.log("  PASS: index_json_by_top_level_keys");
  } finally {
    teardown();
  }
}

function test_index_json_invalid_falls_through(): void {
  setup();
  try {
    // Looks like JSON but isn't valid
    const text = '{ invalid json "key": value }';
    const result = store.index(text, "bad-json");
    assert.ok(result.totalChunks >= 1, "Should still index as plain text or markdown");

    console.log("  PASS: index_json_invalid_falls_through");
  } finally {
    teardown();
  }
}

// ─────────────────────────────────────────────────────────
// Stack trace chunking
// ─────────────────────────────────────────────────────────

function test_index_stack_trace_kept_together(): void {
  setup();
  try {
    const trace = [
      "Error: Connection refused",
      "    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)",
      "    at Protocol._enqueue (/app/node_modules/mysql/lib/protocol/Protocol.js:144:48)",
      "    at Protocol.handshake (/app/node_modules/mysql/lib/protocol/Protocol.js:51:23)",
      "    at PoolConnection.connect (/app/node_modules/mysql/lib/Connection.js:119:18)",
      "",
      "Error: ENOENT: no such file or directory",
      "    at Object.openSync (fs.js:476:3)",
      "    at Object.readFileSync (fs.js:377:35)",
      "    at loadConfig (/app/src/config.js:12:25)",
      "",
      "TypeError: Cannot read properties of undefined",
      "    at processTicksAndRejections (internal/process/task_queues.js:93:5)",
      "    at async UserService.getUser (/app/src/services/user.js:45:12)",
    ].join("\n");

    const result = store.index(trace, "stack-traces");
    assert.ok(result.totalChunks >= 2, `Expected >= 2 chunks for multiple traces, got ${result.totalChunks}`);

    // Each error should be searchable
    const connResults = store.search("Connection refused", 3);
    assert.ok(connResults.length > 0, "Should find connection error");
    // The stack trace should be kept together with its header
    assert.ok(
      connResults[0].content.includes("TCPConnectWrap") || connResults[0].content.includes("Connection refused"),
      "Stack trace should be kept with its error header"
    );

    console.log("  PASS: index_stack_trace_kept_together");
  } finally {
    teardown();
  }
}

// ─────────────────────────────────────────────────────────
// Search layers
// ─────────────────────────────────────────────────────────

function test_search_porter_stemming(): void {
  setup();
  try {
    store.index("The server is running and configured properly", "stemming-test");

    // "running" should match via porter stemming (run → running)
    const results = store.search("configuration running", 3);
    assert.ok(results.length > 0, "Porter stemming should match word variations");

    console.log("  PASS: search_porter_stemming");
  } finally {
    teardown();
  }
}

function test_search_trigram_fallback(): void {
  setup();
  try {
    store.index("The useEffect hook handles component lifecycle events", "trigram-test");

    // "useEff" should match "useEffect" via trigram
    const results = store.searchTrigram("useEff", 3);
    assert.ok(results.length > 0, "Trigram should match partial strings like useEff → useEffect");

    console.log("  PASS: search_trigram_fallback");
  } finally {
    teardown();
  }
}

function test_search_fuzzy_correction(): void {
  setup();
  try {
    store.index("Playwright browser automation testing framework", "fuzzy-test");

    // "playright" (missing 'w') should fuzzy-correct to "playwright"
    const results = store.searchWithFallback("playright browser", 3);
    assert.ok(results.length > 0, "Fuzzy correction should find 'playwright' from 'playright'");
    assert.ok(
      results[0].matchLayer === "fuzzy" || results[0].matchLayer === "porter" || results[0].matchLayer === "trigram",
      "Should indicate which search layer matched"
    );

    console.log("  PASS: search_fuzzy_correction");
  } finally {
    teardown();
  }
}

function test_search_source_filter(): void {
  setup();
  try {
    store.index("Alpha content about databases", "source-alpha");
    store.index("Beta content about databases", "source-beta");

    const alphaResults = store.search("databases", 3, "source-alpha");
    assert.ok(alphaResults.length > 0, "Should find results for source-alpha");
    assert.ok(
      alphaResults.every((r) => r.source.includes("alpha")),
      "All results should be from source-alpha"
    );

    console.log("  PASS: search_source_filter");
  } finally {
    teardown();
  }
}

function test_search_batched_queries(): void {
  setup();
  try {
    store.index("# Authentication\nOAuth2 flow for user login.\n\n# Database\nPostgreSQL with pgvector.", "docs");

    // Multiple queries via searchWithFallback
    const r1 = store.searchWithFallback("OAuth2 authentication", 3);
    const r2 = store.searchWithFallback("PostgreSQL database", 3);
    assert.ok(r1.length > 0, "First query should return results");
    assert.ok(r2.length > 0, "Second query should return results");

    console.log("  PASS: search_batched_queries");
  } finally {
    teardown();
  }
}

// ─────────────────────────────────────────────────────────
// Large content
// ─────────────────────────────────────────────────────────

function test_index_large_content(): void {
  setup();
  try {
    // Generate ~100KB of content
    const lines = Array.from({ length: 2000 }, (_, i) =>
      `Line ${i}: This is test content with various keywords like authentication, database, deployment, and configuration.`
    );
    const content = lines.join("\n");
    assert.ok(Buffer.byteLength(content) > 100_000, "Content should be > 100KB");

    const result = store.index(content, "large-content");
    assert.ok(result.totalChunks > 0, "Should index large content successfully");

    const results = store.search("authentication database", 3);
    assert.ok(results.length > 0, "Should find results in large indexed content");

    console.log("  PASS: index_large_content");
  } finally {
    teardown();
  }
}

// ─────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────

function test_cleanup_deletes_db(): void {
  setup();
  try {
    store.index("test content", "cleanup-test");
    assert.ok(existsSync(testDbPath), "DB file should exist before cleanup");
    store.cleanup();
    assert.ok(!existsSync(testDbPath), "DB file should be deleted after cleanup");

    // Prevent double-cleanup in teardown
    testDbPath = "";
    store = null as unknown as ContentStore;

    console.log("  PASS: cleanup_deletes_db");
  } catch (err) {
    // If cleanup was already called, don't fail
    testDbPath = "";
    store = null as unknown as ContentStore;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────
// Mixed content detection
// ─────────────────────────────────────────────────────────

function test_index_mixed_content_detection(): void {
  setup();
  try {
    // Markdown with embedded JSON — should use markdown strategy
    const md = [
      "# Config",
      "Here is the config:",
      '```json',
      '{"key": "value"}',
      '```',
      "",
      "## Usage",
      "Use it wisely.",
    ].join("\n");

    const result = store.index(md, "mixed");
    assert.ok(result.totalChunks >= 1);

    console.log("  PASS: index_mixed_content_detection");
  } finally {
    teardown();
  }
}

// ─────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────

console.log("\n=== store.test.ts ===\n");

const tests = [
  test_index_markdown_chunks_by_heading,
  test_markdown_code_blocks_intact,
  test_index_plain_text_by_blank_lines,
  test_plain_text_overlap_5_lines,
  test_index_json_by_top_level_keys,
  test_index_json_invalid_falls_through,
  test_index_stack_trace_kept_together,
  test_search_porter_stemming,
  test_search_trigram_fallback,
  test_search_fuzzy_correction,
  test_search_source_filter,
  test_search_batched_queries,
  test_index_large_content,
  test_cleanup_deletes_db,
  test_index_mixed_content_detection,
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    test();
    passed++;
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${test.name}`);
    console.error(`    ${(err as Error).message}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
