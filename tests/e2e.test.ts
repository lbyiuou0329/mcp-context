/**
 * End-to-end test: full flow from tool output → hook → index → search.
 *
 * Proves:
 * 1. Tool output is intercepted and indexed (not lost)
 * 2. Context receives a summary (not the full output)
 * 3. Content is retrievable via search (not truncated away)
 * 4. The savings are real and measurable
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { ContentStore } from "../src/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(__dirname, "..", "hooks", "posttooluse.mjs");

function runHook(input: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn("node", [HOOK_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

// ─────────────────────────────────────────────────────────
// Generate realistic Playwright-style accessibility snapshot (~20KB)
// ─────────────────────────────────────────────────────────

function generatePlaywrightSnapshot(): string {
  const roles = ["button", "link", "textbox", "heading", "img", "navigation", "main", "list", "listitem"];
  const names = ["Submit", "Cancel", "Home", "Settings", "Search", "Profile", "Dashboard", "Login", "Logout", "Help"];
  const lines: string[] = [
    "- document [ref=s1]",
    "  - banner [ref=s2]",
    '    - navigation "Main Navigation" [ref=s3]',
  ];

  for (let i = 0; i < 400; i++) {
    const role = roles[i % roles.length];
    const name = names[i % names.length];
    const indent = "      ".slice(0, 2 + (i % 4) * 2);
    lines.push(`${indent}- ${role} "${name} ${i}" [ref=s${i + 10}]`);
    if (role === "textbox") {
      lines.push(`${indent}  - text "placeholder text for field ${i}"`);
    }
    if (role === "list") {
      for (let j = 0; j < 3; j++) {
        lines.push(`${indent}  - listitem "Item ${i}-${j}" [ref=s${1000 + i * 10 + j}]`);
      }
    }
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────
// E2E test
// ─────────────────────────────────────────────────────────

async function test_e2e_full_flow(): Promise<void> {
  const snapshot = generatePlaywrightSnapshot();
  const snapshotBytes = Buffer.byteLength(snapshot);
  assert.ok(snapshotBytes > 15_000, `Snapshot should be > 15KB, got ${snapshotBytes}`);

  console.log(`  Generated ${(snapshotBytes / 1024).toFixed(1)}KB Playwright snapshot`);

  // Step 1: Feed to hook via stdin
  const hookInput = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "mcp__plugin_playwright_playwright__browser_snapshot",
    tool_input: {},
    tool_response: {
      content: [{ type: "text", text: snapshot }],
    },
  });

  const { stdout, stderr, exitCode } = await runHook(hookInput);

  // Step 2: Assert hook produced replacement output
  assert.equal(exitCode, 0, `Hook should exit 0, got ${exitCode}. Stderr: ${stderr}`);
  assert.ok(stdout.length > 0, "Hook should produce replacement JSON");

  const parsed = JSON.parse(stdout);
  const summary = parsed.hookSpecificOutput?.updatedMCPToolOutput;
  assert.ok(summary, "Should have updatedMCPToolOutput");

  // Step 3: Summary should be small
  const summaryBytes = Buffer.byteLength(summary);
  assert.ok(summaryBytes < 500, `Summary should be < 500 bytes, got ${summaryBytes}`);
  console.log(`  Summary: ${summaryBytes} bytes (vs ${snapshotBytes} original)`);

  // Step 4: Summary should contain source label and search instructions
  assert.ok(summary.includes("search(queries:"), "Summary should include search instructions");
  assert.ok(summary.includes("[Output indexed, not in context]"), "Summary should indicate indexed");

  // Extract source label from summary
  const sourceMatch = summary.match(/source:\s*"([^"]+)"/);
  assert.ok(sourceMatch, "Summary should contain source label");
  const sourceLabel = sourceMatch![1];

  // Step 5: Open the shared DB and search
  // The hook's ppid is our pid, so the DB is at output-indexer-{our pid}
  const dbPath = join(tmpdir(), `output-indexer-${process.pid}.db`);
  const store = new ContentStore(dbPath);

  try {
    const results = store.searchWithFallback("button Submit", 5, sourceLabel);
    assert.ok(results.length > 0, "Search should find content from the indexed snapshot");

    // Step 6: Search results should be smaller than original
    const resultBytes = results.reduce((sum, r) => sum + Buffer.byteLength(r.content), 0);
    assert.ok(resultBytes < snapshotBytes, "Search results should be smaller than original content");
    console.log(`  Search returned ${resultBytes} bytes for 'button Submit'`);

    // Step 7: Search for specific content
    const navResults = store.searchWithFallback("navigation Main", 3, sourceLabel);
    assert.ok(navResults.length > 0, "Should find navigation content");
    assert.ok(
      navResults.some((r) => r.content.includes("navigation") || r.content.includes("Navigation")),
      "Results should contain navigation-related content"
    );

    // Step 8: Calculate savings
    const totalReturned = summaryBytes + resultBytes;
    const savingsPercent = ((1 - totalReturned / snapshotBytes) * 100).toFixed(1);
    console.log(`  Context savings: ${savingsPercent}% (${snapshotBytes} indexed, ${totalReturned} returned)`);
    assert.ok(
      parseFloat(savingsPercent) > 50,
      `Savings should be > 50%, got ${savingsPercent}%`
    );

    // Step 9: Verify store stats
    const stats = store.getStats();
    assert.ok(stats.sources > 0, "Should have at least one source");
    assert.ok(stats.chunks > 0, "Should have chunks indexed");
    console.log(`  Store: ${stats.sources} sources, ${stats.chunks} chunks`);
  } finally {
    store.cleanup();
  }

  console.log("  PASS: e2e_full_flow");
}

async function test_e2e_context7_docs(): Promise<void> {
  // Simulate a Context7 documentation response
  const docs = [
    "# React useEffect Hook",
    "",
    "## Basic Usage",
    "The `useEffect` hook lets you perform side effects in function components.",
    "",
    "```jsx",
    "import { useEffect, useState } from 'react';",
    "",
    "function Example() {",
    "  const [count, setCount] = useState(0);",
    "",
    "  useEffect(() => {",
    "    document.title = `You clicked ${count} times`;",
    "  });",
    "",
    "  return (",
    "    <button onClick={() => setCount(count + 1)}>",
    "      Click me",
    "    </button>",
    "  );",
    "}",
    "```",
    "",
    "## Cleanup",
    "Return a cleanup function from your effect:",
    "",
    "```jsx",
    "useEffect(() => {",
    "  const subscription = props.source.subscribe();",
    "  return () => {",
    "    subscription.unsubscribe();",
    "  };",
    "}, [props.source]);",
    "```",
    "",
    "## Dependencies Array",
    "Pass a dependency array as the second argument:",
    "- Empty array `[]` means the effect runs only on mount/unmount",
    "- No array means the effect runs after every render",
    "- Array with values means the effect runs when those values change",
    "",
    "## Common Patterns",
    "",
    "### Data Fetching",
    "```jsx",
    "useEffect(() => {",
    "  let cancelled = false;",
    "  async function fetchData() {",
    "    const response = await fetch(`/api/items/${id}`);",
    "    const data = await response.json();",
    "    if (!cancelled) setItems(data);",
    "  }",
    "  fetchData();",
    "  return () => { cancelled = true; };",
    "}, [id]);",
    "```",
    "",
    "### Event Listeners",
    "```jsx",
    "useEffect(() => {",
    "  function handleResize() {",
    "    setWidth(window.innerWidth);",
    "  }",
    "  window.addEventListener('resize', handleResize);",
    "  return () => window.removeEventListener('resize', handleResize);",
    "}, []);",
    "```",
  ].join("\n");

  // Repeat to get above threshold
  const fullDocs = Array(5).fill(docs).join("\n\n---\n\n");
  const docBytes = Buffer.byteLength(fullDocs);
  assert.ok(docBytes > 5120, `Docs should be > 5KB, got ${docBytes}`);

  const hookInput = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "mcp__plugin_context7_context7__query-docs",
    tool_input: { query: "useEffect" },
    tool_response: {
      content: [{ type: "text", text: fullDocs }],
    },
  });

  const { stdout, exitCode } = await runHook(hookInput);

  assert.equal(exitCode, 0);
  assert.ok(stdout.length > 0);

  const parsed = JSON.parse(stdout);
  const summary = parsed.hookSpecificOutput.updatedMCPToolOutput;
  const sourceMatch = summary.match(/source:\s*"([^"]+)"/);
  const sourceLabel = sourceMatch![1];

  // Search for specific React concepts
  const dbPath = join(tmpdir(), `output-indexer-${process.pid}.db`);
  const store = new ContentStore(dbPath);

  try {
    const results = store.searchWithFallback("useEffect cleanup function", 3, sourceLabel);
    assert.ok(results.length > 0, "Should find useEffect cleanup docs");
    assert.ok(
      results.some((r) => r.content.includes("unsubscribe") || r.content.includes("cleanup")),
      "Results should contain cleanup-related content"
    );

    const fetchResults = store.searchWithFallback("data fetching async", 3, sourceLabel);
    assert.ok(fetchResults.length > 0, "Should find data fetching pattern");

    console.log("  PASS: e2e_context7_docs");
  } finally {
    store.cleanup();
  }
}

// ─────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────

console.log("\n=== e2e.test.ts ===\n");

const tests = [
  test_e2e_full_flow,
  test_e2e_context7_docs,
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    await test();
    passed++;
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${test.name}`);
    console.error(`    ${(err as Error).message}`);
    if ((err as Error).stack) {
      console.error(`    ${(err as Error).stack!.split("\n").slice(1, 4).join("\n    ")}`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
