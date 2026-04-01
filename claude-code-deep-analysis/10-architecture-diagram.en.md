# 10 - Global Architecture Diagram: A Deep-Dive System Overview

---

## 1. Enhanced Call Relationship Diagram

```
User Input
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│ QueryEngine.submitMessage()                                      │
│  ├─ processUserInput()           // slash command expansion, @file parsing │
│  ├─ buildSystemPrompt()          // multi-source merged system prompt      │
│  │   ├─ Base Instructions                                        │
│  │   ├─ CLAUDE.md Rules                                          │
│  │   ├─ Memory Context ←─── startRelevantMemoryPrefetch()        │
│  │   ├─ Skill Context                                            │
│  │   └─ MCP Server Status                                        │
│  ├─ fileHistoryMakeSnapshot()    // file snapshot (supports undo)│
│  ├─ recordTranscript()           // WAL write (resume on break)  │
│  └─ query()                      // ← core main loop             │
└────────────────────────────────────│──────────────────────────────┘
                                    │
                                    ▼
┌─ queryLoop() ────────────────────────────────────────────────────┐
│  buildQueryConfig()  // immutable environment snapshot           │
│  while (true) {                                                  │
│    │                                                             │
│    ├─ Four-Layer Context Compression                             │
│    │  ├─ snip()                  // Layer 1: remove low-value turns      │
│    │  ├─ microcompact()          // Layer 2: cache-aware trimming         │
│    │  ├─ contextCollapse         // Layer 3: read-time projection         │
│    │  │   └─ projectView()       //   replay collapse log                │
│    │  └─ autocompact()           // Layer 4: full summary compaction (conditional) │
│    │      └─ compact()           //   fork API call to generate summary  │
│    │                                                             │
│    ├─ callModel()                // streaming API call           │
│    │  └─ for await (stream) {                                    │
│    │      ├─ yield text/thinking → UI                            │
│    │      ├─ collect tool_use blocks                             │
│    │      └─ StreamingToolExecutor.addTool() → execute while streaming   │
│    │  }                                                          │
│    │                                                             │
│    ├─ StreamingToolExecutor.getRemainingResults()                 │
│    │  └─ wait for all tools to finish, yield in order            │
│    │                                                             │
│    ├─ runTools() / toolOrchestration                              │
│    │  └─ partitionToolCalls()                                    │
│    │      ├─ concurrent batch → runToolsConcurrently()           │
│    │      │   └─ all() → max concurrency 10                      │
│    │      │       └─ runToolUse()                                │
│    │      │           ├─ canUseTool() → permission check         │
│    │      │           │   ├─ static rule matching                │
│    │      │           │   ├─ tool.checkPermissions()             │
│    │      │           │   ├─ (auto) speculative classifier       │
│    │      │           │   └─ (interactive) dialog confirmation   │
│    │      │           └─ tool.fn() → actual execution            │
│    │      │               ├─ Read/Grep/Glob (read-only)          │
│    │      │               ├─ Edit/Write (file modification)      │
│    │      │               ├─ Bash (command execution)            │
│    │      │               ├─ Agent → runAgent() → query() recursive │
│    │      │               │   ├─ createSubagentContext()         │
│    │      │               │   ├─ filterToolsForAgent()           │
│    │      │               │   └─ inherits 4-layer compression/error recovery/permissions │
│    │      │               └─ MCP tools → mcpClient.callTool()    │
│    │      └─ serial batch → runToolsSerially()                   │
│    │          └─ (same as above, but executed one by one)        │
│    │                                                             │
│    ├─ Apply deferred context modifiers                           │
│    │  └─ queuedContextModifiers → applied in declaration order   │
│    │                                                             │
│    ├─ Post-sampling hooks                                        │
│    │  └─ executePostSamplingHooks()                              │
│    │                                                             │
│    ├─ Stop hooks                                                 │
│    │  └─ handleStopHooks()                                       │
│    │      ├─ blockingErrors → continue (Site 6)                  │
│    │      └─ preventContinuation → return                        │
│    │                                                             │
│    └─ needsFollowUp?                                             │
│        ├─ true  → state={...}; continue                          │
│        │   ├─ normal tool continuation (Site: next_turn)         │
│        │   ├─ model downgrade (Site 1: tombstone + retry)        │
│        │   ├─ collapse drain (Site 2: drain)                     │
│        │   ├─ reactive compact (Site 3: emergency compaction)    │
│        │   ├─ max tokens upgrade (Site 4: 8k→64k)               │
│        │   ├─ max tokens recovery (Site 5: meta message)         │
│        │   ├─ stop hook block (Site 6: retry)                    │
│        │   └─ token budget continuation (Site 7: nudge)          │
│        └─ false → return { reason: 'completed' }                 │
│  }                                                               │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. Data Flow Diagram

### 2.1 Message Lifecycle

```
Create              Transform               Transmit            Consume
───────────────────────────────────────────────────────────────────

UserMessage ──→ normalizeForAPI ──→ API Request ──→ Claude Model
                                                        │
AssistantMessage ←───────────── API Response ←──────────┘
     │
     ├─ yield → UI (possibly clone-before-modify)
     │
     ├─ tool_use blocks → StreamingToolExecutor
     │                          │
     │                    tool.fn() execution
     │                          │
     │                    tool_result (UserMessage)
     │                          │
     └──────── + ──────────────┘
              │
         placed back into messages array
              │
         next turn → four-layer compression → API Request → ...
```

### 2.2 Context Flow

```
User message + history messages
     │
     ├─ + System Prompt (assembled dynamically)
     │    ├─ Base instructions
     │    ├─ CLAUDE.md
     │    ├─ Memory
     │    ├─ Skills
     │    └─ MCP status
     │
     ├─ + Attachment Messages
     │    ├─ Relevant memories
     │    └─ Active skills
     │
     └─ → Four-layer compression
          │
          └─ → API call
```

---

## 3. Module Dependency Diagram

```
┌─────────────────────────────────────────────────────┐
│                  Entrypoints Layer                    │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐ │
│  │ main.tsx  │  │ sdk/     │  │ vscode extension   │ │
│  │ (CLI)     │  │ index.ts │  │                    │ │
│  └────┬──────┘  └────┬─────┘  └────────┬───────────┘ │
└───────┼──────────────┼─────────────────┼─────────────┘
        │              │                 │
        ▼              ▼                 ▼
┌─────────────────────────────────────────────────────┐
│                    Core Layer                         │
│  ┌──────────────┐  ┌─────────┐  ┌────────────────┐  │
│  │ QueryEngine  │  │ query   │  │ Tool           │  │
│  │ .ts          │→ │ .ts     │→ │ .ts            │  │
│  │ (1295 lines) │  │(1729 ln)│  │(792 lines)     │  │
│  └──────────────┘  └─────────┘  └────────────────┘  │
└─────────────────────────────────────────────────────┘
        │              │                 │
        ▼              ▼                 ▼
┌─────────────────────────────────────────────────────┐
│                   Services Layer                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ compact/ │  │ tools/   │  │ api/     │          │
│  │(11 files)│  │ (5 files)│  │(10 files)│          │
│  └──────────┘  └──────────┘  └──────────┘          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ mcp/     │  │analytics/│  │ remote   │          │
│  │          │  │          │  │ Settings/│          │
│  └──────────┘  └──────────┘  └──────────┘          │
└─────────────────────────────────────────────────────┘
        │              │                 │
        ▼              ▼                 ▼
┌─────────────────────────────────────────────────────┐
│                  Utilities Layer                      │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ permissions/ │  │ messages │  │ hooks/        │  │
│  │ (1486+ lines)│  │(5512 ln) │  │ (17 files)    │  │
│  └──────────────┘  └──────────┘  └───────────────┘  │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ generators   │  │ session  │  │ forkedAgent   │  │
│  │ .ts          │  │ Storage  │  │ .ts           │  │
│  └──────────────┘  └──────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## 4. State Management Topology

Claude Code has four distinct state scopes:

```
┌─────────────────────────────────────────────┐
│ AppState (global, shared)                    │
│  ├─ permission updates (Always Allow, etc.)  │
│  ├─ user preferences                         │
│  └─ MCP connection status                   │
│  Scope: all agents (parent + child)          │
│  Lifetime: entire session                    │
└─────────────────────────────────────────────┘
         │
┌────────┴────────────────────────────────────┐
│ ToolUseContext (per agent, selectively shared)│
│  ├─ available tool list                      │
│  ├─ current model                            │
│  ├─ file cache (cloned)                      │
│  ├─ AbortController (independent)            │
│  └─ progress tracking                        │
│  Scope: single agent instance                │
│  Lifetime: while agent is running            │
└─────────────────────────────────────────────┘
         │
┌────────┴────────────────────────────────────┐
│ State (per iteration, fully replaced)        │
│  ├─ messages                                 │
│  ├─ autoCompactTracking                      │
│  ├─ maxOutputTokensRecoveryCount             │
│  ├─ hasAttemptedReactiveCompact              │
│  ├─ transition                               │
│  └─ ... (10 fields total)                    │
│  Scope: single iteration of queryLoop        │
│  Lifetime: one continue/return               │
└─────────────────────────────────────────────┘
         │
┌────────┴────────────────────────────────────┐
│ Local Variables (per iteration, inside loop) │
│  ├─ messagesForQuery (compressed messages)   │
│  ├─ assistantMessages (current turn response)│
│  ├─ toolResults (current turn tool results)  │
│  └─ taskBudgetRemaining (across compact boundary) │
│  Scope: while(true) loop body                │
│  Lifetime: single iteration                  │
└─────────────────────────────────────────────┘
```

---

## 5. Concurrency Model Diagram

```
Main Thread (queryLoop)
  │
  ├─ Streaming API call ─────────────────────────┐
  │  (for await stream)                          │
  │       │                                      │
  │       ├─ StreamingToolExecutor               │
  │       │   ├─ Tool_1 (concurrent) ──→ done    │ Streaming output
  │       │   ├─ Tool_2 (concurrent) ──→ done    │ executed
  │       │   └─ Tool_3 (serial) ────→ wait 1,2  │ simultaneously
  │       │                                      │
  │       └─ yield text/thinking → UI ───────────┘
  │
  ├─ Fork Agent: AutoCompact
  │   └─ independent API call to generate summary
  │       └─ returns compaction result when done
  │
  ├─ Background Agent (run_in_background)
  │   └─ runs query() recursively and independently
  │       ├─ has its own AbortController
  │       ├─ notifies parent agent on completion
  │       └─ may run inside a worktree
  │
  ├─ Haiku Summary (async)
  │   └─ generates ToolUseSummaryMessage
  │       └─ awaited at the start of the next turn
  │
  └─ Memory Prefetch (async)
      └─ queries relevant memories
          └─ poll for result when needed

Abort Propagation:
  User Ctrl+C
    └─ AbortController (top-level)
        ├─ siblingAbortController
        │   └─ per-tool AbortControllers
        └─ child agent AbortControllers (independent, no cascade)
```

---

## 6. Feature Flag Architecture

### 6.1 Compile-Time vs. Runtime

```typescript
// Compile-time feature flag (dead-code eliminated by Bun bundler)
if (feature('CONTEXT_COLLAPSE')) {
  // This import is completely removed when the feature is off
  const contextCollapse = require('./services/contextCollapse/index.js')
}

// Runtime feature flag (Statsig)
const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE('tengu_otk_slot_v1', false)
```

### 6.2 Why Use Compile-Time Flags

Advantages of compile-time feature flags:
1. **Dead code elimination** — disabled features do not appear in the final bundle
2. **Zero runtime overhead** — no need to check flag values at runtime
3. **Smaller bundle size** — reduces the amount of code users need to download

The tradeoff is that changing a flag requires a rebuild. But for a CLI tool like Claude Code, every release involves a fresh build, so this cost is acceptable.

---

## 7. Summary

From a global perspective, Claude Code's architecture can be described using three concentric circles:

```
┌─────────────────────────────────────────┐
│ Outer Ring: Entrypoints and UI           │
│  (main.tsx, SDK, VS Code Extension)      │
│  ┌───────────────────────────────────┐   │
│  │ Middle Ring: Session Management   │   │
│  │  and Orchestration                │   │
│  │  (QueryEngine, query, Tool)       │   │
│  │  ┌───────────────────────────┐    │   │
│  │  │ Inner Ring: Infrastructure │    │   │
│  │  │  (compaction, permissions, │    │   │
│  │  │   messages, cache)         │    │   │
│  │  └───────────────────────────┘    │   │
│  └───────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

- The **inner ring** is the most complex (compaction system, permissions system), but changes the least
- The **middle ring** contains the core logic and changes at a moderate pace
- The **outer ring** is the simplest, but changes most frequently (new entrypoints, new UI)

This layering ensures: **the most complex code is the most stable, and the code that changes most often is the simplest**.
