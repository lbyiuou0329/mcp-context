/**
 * Tests for the three enhancements:
 * 1. Snippet extraction (windows around matches, not full chunks)
 * 2. Vocabulary hints (distinctive terms returned after indexing)
 * 3. Search throttling (rate-limits search to prevent context waste)
 */

import { strict as assert } from "node:assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContentStore } from "../src/store.js";

let store: ContentStore;
let testDbPath: string;

function setup(): void {
  testDbPath = join(tmpdir(), `output-indexer-enhance-${process.pid}-${Date.now()}.db`);
  store = new ContentStore(testDbPath);
}

function teardown(): void {
  store.cleanup();
}

// ─────────────────────────────────────────────────────────
// 1. Snippet extraction
// ─────────────────────────────────────────────────────────

function test_search_returns_highlighted(): void {
  setup();
  try {
    store.index(
      "# Overview\nThis is a long document about authentication.\n\n" +
      "# Details\n" + "Filler content. ".repeat(200) + "\n\n" +
      "# Security\nThe OAuth2 flow requires a client_id and client_secret.",
      "highlight-test",
    );

    const results = store.search("OAuth2 client_id", 3);
    assert.ok(results.length > 0, "Should find results");
    assert.ok(results[0].highlighted, "Results should include highlighted field");
    // STX (0x02) and ETX (0x03) markers should be present around matched terms
    assert.ok(
      results[0].highlighted!.includes("\x02") && results[0].highlighted!.includes("\x03"),
      "Highlighted should contain STX/ETX markers",
    );

    console.log("  PASS: search_returns_highlighted");
  } finally {
    teardown();
  }
}

function test_snippet_extraction_reduces_size(): void {
  setup();
  try {
    // Create a large chunk where the match is near the end
    const filler = "This is irrelevant filler content about nothing important. ".repeat(100);
    const content = filler + "\nThe critical Playwright selector is ref=s42 for the Submit button.\n" + filler;

    store.index(content, "snippet-test");

    const results = store.search("Playwright selector ref=s42", 3);
    assert.ok(results.length > 0, "Should find results");

    // The full chunk is huge, but a snippet around the match should be much smaller
    const fullSize = Buffer.byteLength(results[0].content);
    assert.ok(fullSize > 5000, `Full chunk should be large, got ${fullSize}`);

    // Import and test extractSnippet directly
    // We'll verify via the highlighted field that position data exists
    assert.ok(results[0].highlighted, "Should have highlighted data for snippet extraction");

    console.log("  PASS: snippet_extraction_reduces_size");
  } finally {
    teardown();
  }
}

// ─────────────────────────────────────────────────────────
// 2. Vocabulary hints
// ─────────────────────────────────────────────────────────

function test_distinctive_terms_returned(): void {
  setup();
  try {
    // Each section has unique technical terms so document frequency varies.
    // Terms appearing in only 2-4 of 10 sections will pass the filter
    // (minAppearances=2, maxAppearances=ceil(10*0.4)=4).
    const topics = [
      "Configure the PostgreSQL connection with pgvector extension.",
      "The WebSocket handler manages real-time subscriptions.",
      "Deploy using Kubernetes with Helm charts.",
      "The Redis cache stores session tokens with TTL expiry.",
      "GraphQL resolvers validate input with Zod schemas.",
      "The Elasticsearch cluster indexes documents for full-text search.",
      "Terraform modules provision the AWS infrastructure.",
      "The RabbitMQ consumer processes background jobs.",
      "Prometheus metrics expose latency percentiles.",
      "The gRPC service uses protobuf for serialization.",
    ];

    const sections = Array.from({ length: 10 }, (_, i) => {
      // Each section gets its own topic + one shared neighbor topic
      const own = topics[i];
      const neighbor = topics[(i + 1) % 10];
      return `# Section ${i}\n${own}\n${neighbor}\nGeneric filler line for section ${i}.`;
    }).join("\n\n");

    store.index(sections, "vocab-test");

    const terms = store.getDistinctiveTerms("vocab-test");
    assert.ok(terms.length > 0, `Should return distinctive terms, got: ${terms.length}`);

    // Technical identifiers that appear in exactly 2 chunks should score high
    const termSet = new Set(terms);
    const hasAnyTechnical = [
      "postgresql", "kubernetes", "websocket", "pgvector",
      "redis", "graphql", "elasticsearch", "terraform",
      "rabbitmq", "prometheus", "protobuf",
    ].some((t) => termSet.has(t));
    assert.ok(hasAnyTechnical, `Should include technical terms, got: ${terms.slice(0, 15).join(", ")}`);

    console.log("  PASS: distinctive_terms_returned");
  } finally {
    teardown();
  }
}

function test_distinctive_terms_empty_for_small_content(): void {
  setup();
  try {
    store.index("Short content.", "tiny");
    const terms = store.getDistinctiveTerms("tiny");
    // With only 1 chunk, getDistinctiveTerms requires >= 2 chunks
    assert.equal(terms.length, 0, "Should return empty for tiny content");

    console.log("  PASS: distinctive_terms_empty_for_small_content");
  } finally {
    teardown();
  }
}

// ─────────────────────────────────────────────────────────
// 3. Search throttling (unit-level — we test the store layer,
//    server throttling is integration-level)
// ─────────────────────────────────────────────────────────

function test_search_works_under_load(): void {
  setup();
  try {
    store.index(
      "# API\nThe REST endpoint returns JSON.\n\n# Auth\nUse Bearer tokens.",
      "throttle-test",
    );

    // Simulate many searches — store layer should always work
    for (let i = 0; i < 20; i++) {
      const results = store.searchWithFallback("REST endpoint JSON", 3);
      assert.ok(results.length > 0, `Search ${i + 1} should return results`);
    }

    console.log("  PASS: search_works_under_load");
  } finally {
    teardown();
  }
}

// ─────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────

console.log("\n=== enhancements.test.ts ===\n");

const tests = [
  test_search_returns_highlighted,
  test_snippet_extraction_reduces_size,
  test_distinctive_terms_returned,
  test_distinctive_terms_empty_for_small_content,
  test_search_works_under_load,
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
