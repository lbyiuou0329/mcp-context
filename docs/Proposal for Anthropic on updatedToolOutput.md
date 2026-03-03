# Proposal: `updatedToolOutput` for Built-in Tools in PostToolUse Hooks

## Feature request: let PostToolUse hooks replace built-in tool output

### The problem

Tool output consumes context. A Playwright snapshot is 30-60KB. A `npm test` run is 10-50KB. A `git log` can be 20KB. Most of this content is never needed by the LLM — but it all enters context, crowding out the code and conversation that matter.

Every major coding agent faces this problem and handles it poorly:

| Agent | Strategy | Result |
|-------|----------|--------|
| Codex CLI | Head+tail truncation (10KB cap) | Middle content permanently lost ([#6426](https://github.com/openai/codex/issues/6426), [#7906](https://github.com/openai/codex/issues/7906)) |
| Cursor | Drop-from-beginning truncation | Early context lost ([forum complaints](https://forum.cursor.com/t/terminal-output-truncated/147195)) |
| Gemini CLI | Configurable line truncation | Line-based, not semantic; large output still causes [429 errors](https://github.com/google-gemini/gemini-cli/issues/14775) |
| Amazon Q | `/compact` conversation summary | Summarizes history, not output; [drops important context](https://github.com/aws/amazon-q-developer-cli/issues/2787) |

Nobody indexes tool output for on-demand retrieval. Content is either dumped into context (wasteful) or truncated away (lossy).

### What users are doing today

A third-party MCP plugin called [context-mode](https://github.com/mksglu/claude-context-mode) achieves 98% context savings by indexing tool output into a SQLite FTS5 knowledge base and returning summaries. The LLM searches indexed content on demand.

However, context-mode works by **instructing the LLM to voluntarily use unsandboxed MCP subprocess tools (`execute`, `batch_execute`) instead of Claude Code's sandboxed Bash tool**. A skill prompt loaded into the LLM's context says: "Default to context-mode for ALL commands. Only use Bash for file mutations, git writes, and navigation." The LLM obeys and routes `gh pr list`, `npm test`, `git log`, etc. through context-mode's `execute` tool — which spawns an unsandboxed subprocess with 25+ credential environment variables (`GH_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `KUBECONFIG`, etc.). A PreToolUse hook additionally hard-blocks `curl`/`wget`/`WebFetch`, forcing those through context-mode's `fetch_and_index`.

The plugin author [correctly identified](https://github.com/mksglu/claude-context-mode/pull/24#issuecomment-3983610477) that server-side sandboxing is the wrong fix — sandboxing belongs to the client.

Community users have [independently confirmed](https://news.ycombinator.com/item?id=47193064) that context-mode cannot intercept MCP tool responses — "the response went straight into context — zero entries in context-mode's FTS5 database."

This architecture exists because **there's no way to intercept and replace built-in tool output after execution**. If there were, the plugin could index Bash output post-execution — no execution redirect, no sandbox bypass, no credential exposure. The LLM would use Bash normally, and a PostToolUse hook would handle context compression transparently.

### The one-field fix

The PostToolUse hook API already supports `updatedMCPToolOutput` for MCP tools. Adding the equivalent for built-in tools enables the entire output-indexing pattern without any security compromise:

```jsonc
// Current: PostToolUse hook response for MCP tools
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "updatedMCPToolOutput": "..."   // ← works today, replaces MCP tool output
  }
}

// Proposed: same thing for built-in tools
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "updatedToolOutput": "..."       // ← new field, replaces built-in tool output
  }
}
```

### Why this is safe

1. **The tool has already executed.** The user already approved the tool call. The hook fires after completion. No execution behavior changes.

2. **Output can only be compressed, not escalated.** The hook replaces what the LLM sees — it can't grant new capabilities, run new commands, or access new resources.

3. **The user approved the hook.** Hooks are configured in the user's settings. The user opted into this behavior.

4. **Backward compatible.** Hooks that don't return `updatedToolOutput` behave exactly as before. Existing hooks are unaffected.

### Why this is a win for Anthropic's infrastructure

Tool output that enters the LLM's context becomes inbound tokens that Anthropic's servers must process. A 50KB Playwright snapshot is ~12K tokens. A `npm test` run is ~10K tokens. These tokens are processed on every subsequent LLM call for the rest of the conversation.

Indexing locally and sending a 200-byte summary instead means:
- **Fewer inbound tokens** — reduced compute cost per request
- **Faster TTFT (Time To First Token)** — less input to process before generating
- **Higher effective context utilization** — the context budget is spent on code and conversation, not on stale tool output the LLM already processed

### What this enables

With this one field, a PostToolUse hook can:

```
Any tool (Bash, Read, Playwright, Context7, anything)
  → Produces output
  → PostToolUse hook fires
  → If output > threshold: index into FTS5, return summary
  → If output < threshold: pass through unchanged
  → LLM searches indexed content on demand
```

No execution redirect. No sandbox bypass. No credential passthrough. No MCP subprocess needed for execution. The hook is a pure text processor — it reads tool output, indexes it, and returns a summary.

This approach:
- **Preserves the sandbox**: execution stays in Claude Code's sandboxed path
- **Preserves credential safety**: no credentials leaked to external processes
- **Enables the plugin ecosystem**: any plugin can implement smart output processing
- **Is additive**: small outputs work exactly as before; only large outputs are affected
- **Is competitive**: makes Claude Code the first agent with semantic output retrieval instead of blind truncation

### References

- [context-mode](https://github.com/mksglu/claude-context-mode) — third-party plugin proving demand (98% savings, growing adoption)
- [context-mode PR #24](https://github.com/mksglu/claude-context-mode/pull/24) — OS sandbox attempt rejected; owner confirms client should own sandboxing
- [Codex CLI #7906](https://github.com/openai/codex/issues/7906), [#6426](https://github.com/openai/codex/issues/6426) — users requesting better output handling
- [Gemini CLI #14775](https://github.com/google-gemini/gemini-cli/issues/14775) — large output causes errors
- [Amazon Q #2787](https://github.com/aws/amazon-q-developer-cli/issues/2787) — auto-compact loses important context