/**
 * Tests for the PostToolUse hook (hooks/posttooluse.mjs).
 *
 * Verifies threshold behavior, MCP output replacement, non-MCP passthrough,
 * summary format, and content indexing into the shared store.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { existsSync, unlinkSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(__dirname, "..", "hooks", "posttooluse.mjs");

/** Run the hook with given stdin input via spawn. */
function runHook(
  input: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn("node", [HOOK_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      timeout: 10_000,
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

function makeHookInput(toolName: string, text: string): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: {},
    tool_response: {
      content: [{ type: "text", text }],
    },
  });
}

// ─────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────

async function test_small_output_passes_through(): Promise<void> {
  const input = makeHookInput(
    "mcp__plugin_playwright_playwright__browser_snapshot",
    "Small output under threshold",
  );
  const { stdout, exitCode } = await runHook(input);

  assert.equal(exitCode, 0, "Hook should exit 0");
  assert.equal(stdout, "", "Small output should produce no stdout (pass through)");

  console.log("  PASS: small_output_passes_through");
}

async function test_large_mcp_output_replaced(): Promise<void> {
  const largeText = "A".repeat(6000);
  const input = makeHookInput(
    "mcp__plugin_playwright_playwright__browser_snapshot",
    largeText,
  );
  const { stdout, exitCode } = await runHook(input);

  assert.equal(exitCode, 0);
  assert.ok(stdout.length > 0, "Large MCP output should produce replacement JSON");

  const parsed = JSON.parse(stdout);
  assert.ok(parsed.hookSpecificOutput, "Should have hookSpecificOutput");
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.ok(
    parsed.hookSpecificOutput.updatedMCPToolOutput,
    "Should have updatedMCPToolOutput",
  );

  const summary = parsed.hookSpecificOutput.updatedMCPToolOutput;
  assert.ok(summary.includes("[Output indexed, not in context]"), "Summary should indicate output was indexed");
  assert.ok(summary.includes("search(queries:"), "Summary should include search instructions");
  assert.ok(summary.includes("You do NOT have this content"), "Summary should warn LLM");

  console.log("  PASS: large_mcp_output_replaced");
}

async function test_non_mcp_tool_ignored(): Promise<void> {
  const largeText = "B".repeat(6000);
  const input = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: {},
    tool_response: { content: [{ type: "text", text: largeText }] },
  });

  const { stdout, exitCode } = await runHook(input);

  assert.equal(exitCode, 0);
  assert.equal(stdout, "", "Non-MCP tool (Bash) should be ignored");

  console.log("  PASS: non_mcp_tool_ignored");
}

async function test_summary_format_correct(): Promise<void> {
  const largeText = "C".repeat(8000);
  const input = makeHookInput(
    "mcp__plugin_context7_context7__query-docs",
    largeText,
  );
  const { stdout } = await runHook(input);
  const parsed = JSON.parse(stdout);
  const summary = parsed.hookSpecificOutput.updatedMCPToolOutput;

  assert.ok(/\d+\.\d+KB/.test(summary), "Summary should include size in KB");
  assert.ok(/\d+ sections/.test(summary), "Summary should include section count");
  assert.ok(summary.includes("source:"), "Summary should include source label for search");

  console.log("  PASS: summary_format_correct");
}

async function test_content_indexed_in_store(): Promise<void> {
  const largeText = Array.from({ length: 100 }, (_, i) =>
    `Line ${i}: Playwright accessibility snapshot role=button name="Submit"`
  ).join("\n");

  assert.ok(Buffer.byteLength(largeText) >= 5120);

  const input = makeHookInput(
    "mcp__plugin_playwright_playwright__browser_snapshot",
    largeText,
  );
  const { stdout, exitCode } = await runHook(input);

  assert.equal(exitCode, 0);
  assert.ok(stdout.length > 0, "Should produce replacement output");

  // The hook's ppid is our pid, so DB is at output-indexer-{our pid}
  const dbPath = join(tmpdir(), `output-indexer-${process.pid}.db`);
  assert.ok(existsSync(dbPath), `DB file should exist at ${dbPath}`);

  // Clean up
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }

  console.log("  PASS: content_indexed_in_store");
}

async function test_threshold_configurable(): Promise<void> {
  const text = "D".repeat(2000); // 2KB, above 1KB threshold
  const input = makeHookInput(
    "mcp__plugin_playwright_playwright__browser_snapshot",
    text,
  );
  const { stdout, exitCode } = await runHook(input, {
    OUTPUT_INDEXER_THRESHOLD: "1024",
  });

  assert.equal(exitCode, 0);
  assert.ok(stdout.length > 0, "2KB output should be indexed with 1KB threshold");

  const parsed = JSON.parse(stdout);
  assert.ok(parsed.hookSpecificOutput.updatedMCPToolOutput);

  const dbPath = join(tmpdir(), `output-indexer-${process.pid}.db`);
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }

  console.log("  PASS: threshold_configurable");
}

async function test_own_tools_not_intercepted(): Promise<void> {
  const largeText = "E".repeat(6000);
  const input = makeHookInput("mcp__mcp_context__search", largeText);
  const { stdout, exitCode } = await runHook(input);

  assert.equal(exitCode, 0);
  assert.equal(stdout, "", "Our own mcp-context tools should not be intercepted");

  console.log("  PASS: own_tools_not_intercepted");
}

// ─────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────

console.log("\n=== hook.test.ts ===\n");

const tests = [
  test_small_output_passes_through,
  test_large_mcp_output_replaced,
  test_non_mcp_tool_ignored,
  test_summary_format_correct,
  test_content_indexed_in_store,
  test_threshold_configurable,
  test_own_tools_not_intercepted,
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
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
