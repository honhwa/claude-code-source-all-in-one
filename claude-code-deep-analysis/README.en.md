# Claude Code Source Code Deep Analysis Series

> Claude Code is Anthropic's official AI programming CLI tool and one of the most powerful AI agent systems available today. This series consists of 18 articles that provide an in-depth teardown of Claude Code's complete architecture at the source code level.

## What This Series Covers

Claude Code's source code was recently leaked. After reading through it from start to finish, we found that this system's design philosophy is fundamentally different from the vast majority of agent frameworks on the market — **it doesn't pursue architectural "elegance," but rather engineering "correctness."**

This series is our reading notes. We've broken Claude Code down into 18 subsystems, and each article includes:

- **Source-level code analysis** — not guessing implementations from documentation, but directly reading the 1,729 lines of `query.ts`, the 1,486 lines of `permissions.ts`, and the 3,348 lines of `client.ts`
- **Deep reasoning behind design decisions** — not just "this is what it does," but "why it does it this way, what alternatives exist, and what the trade-offs are"
- **Horizontal comparison with industry solutions** — LangGraph, CrewAI, AutoGen, Cursor, Copilot, etc., compared side by side to reveal the differences

## Core Findings

After reading the entire codebase, we distilled **five core design decisions** that set Claude Code apart from other agent frameworks:

### 1. Loops Over Graphs

90% of agent frameworks on the market use DAGs (Directed Acyclic Graphs) to orchestrate tool calls. Claude Code's core is simply a `while(true)` loop — no state machines, no graph orchestration engines, no workflow DSLs.

It sounds primitive, but this is precisely the most flexible choice. A graph's topology is determined at compile time; a loop's behavior is determined at runtime. When your agent needs to dynamically adjust its strategy based on intermediate results, a graph is a constraint — a loop is freedom.

→ See [00-Core Conclusion](00-core-conclusion.md) and [02-Main Loop](02-main-loop.md)

### 2. Recursion Over Orchestration

Sub-agents are not new processes, not microservices, not independent workflows. They simply recursively call the same `query()` function. This means all capabilities of the main loop — four-layer compression, seven error recovery mechanisms, streaming tool execution — automatically apply to all sub-agents. Maintenance cost is O(1), not O(n).

→ See [06-Sub-Agent](06-sub-agent.md)

### 3. Model Decides, Framework Executes

Claude Code doesn't attempt to understand task dependencies at the framework level. It trusts that the model knows what it's doing — if the model outputs three Read calls at once, they can be parallelized. The framework enforces only one safety constraint: operations with side effects execute serially. Everything else is left to the model.

→ See [04-Tool Orchestration](04-tool-orchestration.md)

### 4. Designed for the Real World, Not for Demos

Four-layer context compression, three-level 413 error recovery, max_output_tokens continuation, streaming fallback tombstone handling — none of these matter in a 5-minute demo. But an engineer using Claude Code for 4 hours will encounter all of these edge cases.

→ See [07-Context Window Management](07-context-window.md) and [11-Design Philosophy](11-design-philosophy.md)

### 5. Immutability Is Cost Optimization

API-returned message objects are never modified. This isn't a code style preference — it directly impacts prompt caching hit rates. A single immutability constraint reduces input costs for long sessions by 80%.

→ See [09-Immutable API Messages](09-immutable-api-messages.md)

---

## Table of Contents

### Part 1: Core Agent Engine

The core execution chain of the agent — from the user pressing Enter, to model response generation, to tool execution, to the next loop iteration.

| # | Topic | What You'll Learn |
|---|-------|-------------------|
| 00 | [Core Conclusion](00-core-conclusion.md) | Why `while(true)` is better suited for agents than DAGs. Comparison with LangGraph, CrewAI, AutoGen. The evolution of ReAct loops from academia to engineering. |
| 01 | [Entry Point](01-entry-point.md) | The complete call chain from `main.tsx` to `QueryEngine` to `query()`. Parallel prefetch optimization during startup. WAL-style checkpoint resume design. |
| 02 | [Main Loop](02-main-loop.md) | Line-by-line dissection of the 1,488-line `queryLoop` function. The story behind each of the 10 fields in the `State` type. Precise semantics and safeguards for 7 continue sites. |
| 03 | [Streaming](03-streaming.md) | How `StreamingToolExecutor` executes tools while the API is still streaming. Three-layer AbortController hierarchy. Why only Bash errors trigger sibling abort. |
| 04 | [Tool Orchestration](04-tool-orchestration.md) | The greedy partitioning algorithm of `partitionToolCalls`. Why dependency analysis isn't performed. How deferred context modifiers solve concurrency race conditions. |
| 05 | [Permission System](05-permission-system.md) | The 1,486-line permission decision chain. Behavioral differences across 5 permission modes. The 2-second timeout design for the speculative Bash classifier. How enterprise Policy Limits override user settings. |
| 06 | [Sub-Agent](06-sub-agent.md) | Why recursively calling `query()` is better than orchestration frameworks. Five dimensions of isolation design. How Worktree isolation lets agents experiment boldly. |
| 07 | [Context Window Management](07-context-window.md) | Four progressive compression layers (Snip → Microcompact → Context Collapse → AutoCompact). Cost and fidelity trade-offs for each layer. Three-level 413 recovery waterfall. |
| 08 | [Message Type System](08-message-types.md) | Roles and design rationale for 7 message types. How TombstoneMessage solves the retroactive revocation problem in streaming systems. The 5,512-line message utility library. |
| 09 | [Immutable API Messages](09-immutable-api-messages.md) | Anthropic's byte-matching mechanism for prompt caching. Clone-before-modify pattern and lazy clone optimization. Cost quantification analysis for long sessions. |
| 10 | [Global Architecture Diagram](10-architecture-diagram.md) | Enhanced call relationship diagram. Topology of four state scopes. Concurrency model diagram. Compile-time dead code elimination via Feature Flags. |
| 11 | [Design Philosophy](11-design-philosophy.md) | Deep expansion and boundary analysis of four core decisions. The "boring but necessary" engineering checklist. What makes a good agent framework. |

### Part 2: Peripheral Subsystems

Six major systems beyond the core engine — they transform Claude Code from "a working agent" into "a usable product."

| # | Topic | What You'll Learn |
|---|-------|-------------------|
| 12 | [MCP Integration](12-mcp-integration.md) | The 3,348-line MCP client architecture. 6 Transport types (Stdio/SSE/HTTP/WebSocket/InProcess/SdkControl). OAuth + XAA enterprise authentication. LRU caching strategy for tool discovery. |
| 13 | [Memory System](13-memory-system.md) | Five memory types and frontmatter storage format. Sonnet-driven relevance retrieval. RAII lifecycle management for async prefetch. Progressive automatic extraction for Session Memory. |
| 14 | [System Prompt Construction](14-system-prompt.md) | How dynamic boundaries split cacheable and non-cacheable prompt regions. Modular assembly of 20+ Sections. Merge strategy for five information sources. |
| 15 | [Session Resume & Bridge](15-session-resume.md) | WAL-style persistence for JSONL transcripts. Message chain reconstruction via parentUuid. Two generations of Bridge Transport (WebSocket → SSE+CCR). Remote permission bridging for VS Code extension. |
| 16 | [Tool Implementations](16-tool-implementations.md) | 30+ methods/properties of the `Tool` interface. Fail-closed security defaults in `buildTool()`. BashTool's 430KB of security code. Lazy loading & ToolSearch. |
| 17 | [Hook System](17-hook-system.md) | 13 lifecycle event types. 5 Hook types (Command/Prompt/Agent/HTTP/Function). The exit code 2 blocking mechanism. How Hooks drive the 6th continue site in the main loop. |

## Recommended Reading Paths

Choose a reading path based on your goals:

**"I want to quickly understand Claude Code's design philosophy"** (30 minutes)
> 00 → 11

**"I want to deeply understand the core Agent engine"** (2-3 hours)
> 00 → 01 → 02 → 03 → 04 → 07 → 09

**"I'm building my own Agent system and want to learn best practices"** (3-4 hours)
> 00 → 02 → 04 → 05 → 06 → 07 → 11

**"I want a comprehensive understanding of Claude Code's complete architecture"** (6-8 hours)
> Read sequentially from 00 to 17

**"I'm focused on security and permission design"**
> 05 → 17 → 16 (BashTool security section)

**"I'm focused on performance and cost optimization"**
> 07 → 09 → 14 → 03

## Key Numbers

| Metric | Value |
|--------|-------|
| Total lines of source code analyzed | ~50,000+ |
| Core files | 15 key files |
| Number of tools | 45+ |
| Main loop continue sites | 7 |
| Context compression layers | 4 |
| Error recovery levels | 3 (413) + 2 (max_tokens) |
| Permission modes | 5 |
| Hook event types | 13 |
| MCP Transport types | 6 |
| Message types | 7 |

## Key Source File Index

| File | Lines | Core Responsibility |
|------|-------|---------------------|
| `query.ts` | 1,729 | Agent main loop, all recovery logic |
| `QueryEngine.ts` | 1,295 | Session management, entry orchestration |
| `StreamingToolExecutor.ts` | 530 | Streaming tool concurrent execution |
| `toolOrchestration.ts` | 188 | Tool batch partitioning & orchestration |
| `toolExecution.ts` | 1,745 | Single tool execution, permission checks |
| `permissions.ts` | 1,486 | Permission decision chain |
| `runAgent.ts` | 973 | Sub-Agent recursive invocation |
| `utils/messages.ts` | 5,512 | Message factory & transformation |
| `services/compact/` | ~11 files | Four-layer context compression |
| `services/mcp/client.ts` | 3,348 | MCP connection & tool invocation |
| `memdir/` | 8 files | Memory storage & retrieval |
| `constants/prompts.ts` | 914 | System Prompt assembly |
| `bridge/replBridge.ts` | ~2,800 | Bridge communication layer |
| `Tool.ts` | 793 | Tool interface definition |
| `utils/hooks/` | ~17 files | Hook lifecycle system |
