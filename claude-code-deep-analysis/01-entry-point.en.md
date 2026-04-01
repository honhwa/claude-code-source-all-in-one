# 01 - Deep Analysis of the Entry Point Flow: From User Pressing Enter to Agent Startup

---

## 1. Startup Phase: Parallel Prefetching in main.tsx

### 1.1 Side-effect-first Pattern

The first few lines of `main.tsx` are not imports — they are **side-effect calls**:

```typescript
// main.tsx top section (heavily simplified)
startMdmRawRead()           // prefetch MDM config
startKeychainPrefetch()     // prefetch keychain credentials
profileCheckpoint('main_tsx_entry')  // performance sampling point
```

These calls execute before any imports. Why?

Because Node.js (or Bun) module loading is **synchronous**. When you `import` a module, all module code in the entire dependency chain executes synchronously. In a large application like Claude Code, module loading can take hundreds of milliseconds.

By launching I/O operations (keychain reads, MDM config) before imports, these async operations can run **in parallel** with module loading. By the time the data is actually needed (e.g., when building an API request), it is typically already available.

### 1.2 Profile Checkpoint

`profileCheckpoint` is not ordinary logging — it is part of a **performance sampling system**:

```
main_tsx_entry → imports_done → repl_ready → first_api_call
```

Each checkpoint records a timestamp, allowing the team to track every phase of cold-start performance. This is user-experience-driven engineering — every time a user opens Claude Code they experience a cold start, so even shaving 100ms matters.

---

## 2. QueryEngine: Session Manager

### 2.1 Class Responsibilities

`QueryEngine` is the session management layer for all of Claude Code. It is not responsible for the specific AI logic (that belongs to `query()`), but rather for "everything surrounding the AI logic":

```typescript
// QueryEngine.ts:184
export class QueryEngine {
  // core method
  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown>
}
```

### 2.2 The Six Stages of submitMessage

`submitMessage` is an async generator that internally executes six stages in sequence:

```
Stage 1: processUserInput()     → slash command expansion
Stage 2: System Prompt assembly → multi-source merge
Stage 3: File History Snapshot  → snapshot for undo
Stage 4: Transcript Recording   → resumable sessions
Stage 5: query()                → core agent loop
Stage 6: Post-turn Cleanup      → cost accumulation, state update
```

### 2.3 Stage 1: processUserInput() — Slash Command Expansion

When the user types `/compact` or `/help`, these slash commands are not forwarded directly to the model; they are intercepted and handled inside `processUserInput()`:

```
User input: "/compact compress context"
  → processUserInput() recognizes /compact command
  → executes compact logic
  → returns result (does not enter query loop)
```

For non-command input, `processUserInput()` also performs preprocessing:
- Parses `@file` references and inlines file contents
- Handles image attachments
- Expands environment variables

### 2.4 Stage 2: System Prompt Assembly

Claude Code's system prompt is not a static string; it is **dynamically assembled from multiple sources**:

```
System Prompt =
  base instructions (role, capabilities)
  + user-defined rules (CLAUDE.md)
  + project context (git info, cwd)
  + tool descriptions (dynamically generated)
  + Memory context (relevant memories)
  + Skill context (activated skills)
  + MCP server state
```

This dynamic assembly ensures:
1. Different projects have different contexts (via CLAUDE.md)
2. The tool set can change dynamically (MCP servers can be added/removed at runtime)
3. Relevant memories are injected on demand (not all memories are loaded every time)

### 2.5 Stage 3: File History Snapshot

```typescript
// snapshot taken at the start of each turn
const snapshot = fileHistoryMakeSnapshot(modifiedFiles)
```

This snapshot records **the contents of all modified files at the start of the current turn**. When the user is unsatisfied with Claude Code's changes, they can revert to this snapshot via `/undo`.

Key design decisions:
- The snapshot is taken **before** calling the API — ensuring the snapshot is complete even if the API call crashes midway
- The snapshot is **incremental** — it only records modified files, not a full repository snapshot
- The snapshot lives **in memory** — it is not written to disk, avoiding I/O overhead

### 2.6 Stage 4: Transcript Recording — Foundation for Resumable Sessions

```typescript
// record the user message before calling the API
recordTranscript(userMessage)
```

This design reflects the engineering maturity of Claude Code. The conventional approach is to record conversation history after the API response. But what if the API call crashes midway?

Claude Code's approach is: **write the log first, then call the API**. This way, even if the process is killed, the network is interrupted, or the API returns a 500 error, the next startup can recover from the transcript.

This is essentially an application of the **Write-Ahead Log (WAL)** concept from database systems, applied to an agent system.

### 2.7 Stage 5: query() — The Core Loop

This is the heart of the entire chain; it is analyzed in detail in 02-main-loop.md. Here we focus only on how QueryEngine consumes the output of `query()`:

```typescript
for await (const message of query({
  messages,
  systemPrompt,
  userContext,
  systemContext,
  canUseTool: wrappedCanUseTool,
  toolUseContext: processUserInputContext,
  fallbackModel,
  querySource: 'sdk',
  maxTurns,
  taskBudget,
})) {
  // 1. record to transcript
  recordTranscript(message)
  
  // 2. convert to SDK message format
  const sdkMessage = toSDKMessage(message)
  
  // 3. yield to outer consumer
  yield sdkMessage
}
```

Note `wrappedCanUseTool` — QueryEngine **wraps** the permission-check function to inject additional logic (such as integration with UI confirmation dialogs).

### 2.8 Stage 6: Post-turn Cleanup

After the turn ends, QueryEngine performs cleanup:

```typescript
// accumulate token usage
accumulateUsage(response.usage)

// update cost
updateCost(response.usage)

// flush session storage
flushSessionStorage()
```

---

## 3. Cost Tracking System

### 3.1 Cumulative Tracking Across Turns

Claude Code tracks token usage and dollar cost throughout the entire session:

```
Turn 1: input=1000, output=500,  cost=$0.03
Turn 2: input=1500, output=800,  cost=$0.05
Turn 3: input=2000, output=1200, cost=$0.08
────────────────────────────────────────────
Total:  input=4500, output=2500, cost=$0.16
```

This data is exposed to the UI via `getTotalCost()`, letting users know at any time what the current session has cost.

### 3.2 Prompt Caching Awareness

Cost calculation is not a simple `tokens × price` — it distinguishes between:

- `cache_creation_input_tokens` — tokens that created the cache on first use (billed at normal price)
- `cache_read_input_tokens` — tokens served from cache (billed at 10% of normal price)
- Regular `input_tokens` — uncached tokens

This means Claude Code's cost tracking is **cache-aware** — it knows how much you saved due to prompt caching.

---

## 4. AbortController Propagation

### 4.1 The Cancellation Chain

When the user presses Ctrl+C in Claude Code, it triggers an AbortController chain:

```
User presses Ctrl+C
  → REPL layer abort
    → QueryEngine's abortController.abort()
      → query() loop detects abort signal
        → StreamingToolExecutor's siblingAbortController.abort()
          → each running tool receives abort
            → Bash process is killed
            → sub-agents are terminated
```

This chain ensures that **everything from the UI down to the lowest-level processes** can terminate gracefully.

### 4.2 Interrupt Semantics

`AbortController.signal.reason` distinguishes between different types of interrupts:

| reason | meaning | tool behavior |
|--------|---------|---------------|
| `undefined` | user pressed Ctrl+C | all tools stop |
| `'interrupt'` | user typed a new message | only stops `cancel`-typed tools |

`'interrupt'` is a subtle scenario: the user types a new message while a tool is executing. In this case, Claude Code does not brutally kill all tools — it only stops those that declared `interruptBehavior: 'cancel'`. For example, a tool that is writing a file should not be interrupted (which could corrupt the file), but a tool that is searching can be safely cancelled.

---

## 5. SDK Entry vs CLI Entry

Claude Code has two entry paths:

```
CLI entry:
  main.tsx → launchRepl() → React/Ink UI → QueryEngine

SDK entry:
  entrypoints/sdk/index.ts → QueryEngine (no UI)
```

The SDK entry skips all UI-related logic (React, Ink, terminal rendering) and directly exposes `QueryEngine`'s async generator interface. This allows third-party applications to embed Claude Code's agent capabilities without needing a terminal UI.

Both entries share the same `query()` core — a textbook example of the design principle "separate core logic from UI."

---

## 6. Summary: Engineering Wisdom in Entry Point Design

Claude Code's entry point design reflects several key principles:

1. **Parallelism first** — I/O operations during startup run in parallel with module loading
2. **Write before act** — WAL concept applied to an agent system
3. **Snapshot isolation** — file snapshots support undo, giving users confidence
4. **Graceful termination** — the AbortController chain ensures complete cancellation from UI to process
5. **Core-UI separation** — CLI and SDK share the same agent core

These designs are not "glamorous" — they won't appear at product launch events. But they are the foundation that allows Claude Code to remain stable during long sessions.
