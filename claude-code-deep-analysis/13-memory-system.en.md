# 13 - Memory System Deep Analysis: Cross-Session Memory

---

## 1. Why Memory Is Needed

A fundamental problem with AI coding assistants is that **every session starts from scratch.** Last time you told it "our project uses pnpm, not npm," the next session it uses npm again.

Claude Code's Memory system solves this problem — it allows the model to remember user preferences, project context, and working patterns across sessions.

---

## 2. Storage Architecture

### 2.1 Directory Structure

```
~/.claude/
  └─ projects/
      └─ {project-hash}/
          └─ memory/
              ├─ MEMORY.md          # Entry file (index)
              ├─ user_role.md       # User role memory
              ├─ feedback_testing.md # Feedback memory
              ├─ project_auth.md    # Project memory
              └─ ...                # Up to 200 files
```

### 2.2 Memory File Format

Each memory file uses frontmatter format:

```markdown
---
name: User Preference - Testing
description: User prefers using a real database instead of mocks for integration tests
type: feedback
---

Integration tests must use a real database, not mocks.

**Why:** An incident last quarter where mock tests passed but production migration failed.
**How to apply:** When writing tests, configure a connection to the test database rather than mocks.
```

### 2.3 MEMORY.md: The Index Entry Point

`MEMORY.md` is an **index file**, not memory itself:

```markdown
- [User Role](user_role.md) — Senior backend engineer, proficient in Go and React
- [Testing Preferences](feedback_testing.md) — Integration tests use real database
- [Project Auth](project_auth.md) — Auth rewrite driven by compliance requirements
```

Key constraints:
- Maximum 200 lines (`MAX_ENTRYPOINT_LINES`)
- Maximum 25KB (`MAX_ENTRYPOINT_BYTES`)
- Truncated with a warning when limits are exceeded

---

## 3. Memory Retrieval: findRelevantMemories()

### 3.1 Retrieval Flow

```
User input: "Help me write tests"
  │
  ├─ 1. Scan memory directory (memoryScan)
  │     └─ Read frontmatter of each file (first 30 lines)
  │     └─ Sort by modification time
  │     └─ Up to 200 files
  │
  ├─ 2. Build memory manifest
  │     └─ "[feedback] feedback_testing.md (3 days ago): Integration tests use real database"
  │     └─ "[user] user_role.md (7 days ago): Senior backend engineer"
  │
  ├─ 3. Call Claude Sonnet to select relevant memories
  │     └─ Input: user message + memory manifest + recently used tools
  │     └─ Output: JSON { selected_memories: ["feedback_testing.md", ...] }
  │     └─ Up to 5 selected
  │
  └─ 4. Read the full content of selected memory files
        └─ Injected into context as AttachmentMessage
```

### 3.2 Intelligent Filtering

```typescript
// findRelevantMemories.ts:39
async function findRelevantMemories({
  query,
  memoryDir,
  recentlyUsedTools,      // Recently used tools (suppresses API-doc-type memories)
  alreadySurfacedPaths,   // Memories already surfaced (avoids duplicates)
}) {
  // Exclude MEMORY.md (already in system prompt)
  // Exclude memories already read via FileRead
  // Exclude memories already surfaced in this session
}
```

**Tool-aware filtering** is a clever design — if the user just read a memory file via FileRead, there is no need to inject it again through the Memory system.

### 3.3 Session Byte Budget

```typescript
const MAX_SESSION_BYTES = 60 * 1024  // 60KB cumulative limit
```

The total bytes injected via Memory throughout a session must not exceed 60KB. This prevents memory accumulation from filling up the context window during long sessions.

---

## 4. Async Prefetch: startRelevantMemoryPrefetch()

### 4.1 RAII Pattern

```typescript
// query.ts:301-304
using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
  state.messages,
  state.toolUseContext,
)
```

The `using` keyword ensures lifecycle management for the prefetch:
- **Start**: on the first loop iteration
- **Consume**: after tool execution, before the next API call
- **Cleanup**: automatically disposed when the generator exits (logging telemetry data)

### 4.2 Fire-and-Forget + Deferred Consumption

```
Loop iteration starts
  │
  ├─ startRelevantMemoryPrefetch() → starts asynchronously
  │     └─ calls findRelevantMemories()
  │     └─ records settledAt timestamp
  │
  ├─ Four-layer context compression
  ├─ API call
  ├─ Tool execution
  │
  └─ getAttachmentMessages()
        └─ Checks if pendingMemoryPrefetch has completed
        └─ If complete → create AttachmentMessage
        └─ If not complete → skip (non-blocking)
```

**Non-blocking is key** — memory retrieval typically takes 1–3 seconds (calling Sonnet), and blocking the main loop would hurt response speed. Through async prefetch, memory retrieval overlaps with model calls and tool execution.

### 4.3 Telemetry Tracking

```typescript
// Logged on dispose
logEvent('tengu_memdir_prefetch_collected', {
  settledAt: prefetch.settledAt,
  consumedOnIteration: prefetch.consumedOnIteration,
  // -1=never consumed, 0=hidden (filtered out), N=visible on iteration N
})
```

---

## 5. Memory Types

### 5.1 Five Memory Types

| Type | Purpose | Example |
|------|---------|---------|
| `user` | User role and preferences | "Senior backend engineer, proficient in Go" |
| `feedback` | Behavioral feedback (do/don't) | "Don't mock the database" |
| `project` | Project context and progress | "Auth rewrite driven by compliance requirements" |
| `reference` | Pointers to external resources | "Bug tracking in Linear INGEST project" |

### 5.2 What Should NOT Be Stored as Memory

- Code patterns and architecture (read from the code)
- Git history (read from git log)
- Debugging solutions (the fix is already in the code)
- Content already present in CLAUDE.md
- Temporary information from the current session

---

## 6. Session Memory: Automatic Memory Extraction

### 6.1 How It Works

```
Session in progress...
  │
  ├─ Token/tool call threshold reached
  │
  ├─ shouldExtractMemory() → true
  │
  ├─ Launch background sub-agent (non-blocking)
  │   └─ buildSessionMemoryUpdatePrompt()
  │   └─ Agent analyzes conversation, extracts key information
  │   └─ Writes/updates memory files
  │
  └─ markSessionMemoryInitialized()
      └─ Periodic updates thereafter
```

### 6.2 Incremental Extraction

Session Memory is not extracted all at once — it is **incremental**:

1. **Initialization**: extracted after the first threshold is reached
2. **Incremental updates**: tracks `lastSummarizedMessageId`, processes only new messages
3. **Periodic triggering**: based on token delta and number of tool calls

---

## 7. Team Memory

### 7.1 Team Sharing

```
~/.claude/memories/team/    # Team memory directory
  ├─ onboarding.md          # Onboarding guide
  ├─ code_style.md          # Code style
  └─ deployment.md          # Deployment process
```

Team Memory lives in a separate `team/` directory and is shared among team members via a sync mechanism.

### 7.2 Two-Layer Memory Prompt

When Team Memory is enabled, the system prompt includes two layers of memory:

```
Personal memory (~/.claude/memories/)
  + Team memory (~/.claude/memories/team/)
    → Merged and injected into system prompt
```

---

## 8. Integration with the System Prompt

### 8.1 Static Injection

The content of `MEMORY.md` is injected as part of the system prompt at the start of each turn:

```typescript
// constants/prompts.ts:495
systemPromptSection('memory', () => loadMemoryPrompt())
```

This is a **cache-friendly** operation — because MEMORY.md typically does not change during a session, this section can be reused by the prompt cache.

### 8.2 Dynamic Injection

Additional memories found by `findRelevantMemories()` are dynamically injected via `AttachmentMessage`:

```
System Prompt (containing MEMORY.md index)
  + AttachmentMessage(memory: "full content of feedback_testing.md")
    → The model sees both the index and the specific memory
```

---

## 9. Summary

Claude Code's Memory system is a **multi-layer, asynchronous, intelligent** memory architecture:

1. **Storage layer**: File system + frontmatter format, simple and reliable
2. **Retrieval layer**: Sonnet-driven relevance matching, more accurate than keyword search
3. **Injection layer**: Static (MEMORY.md) + dynamic (AttachmentMessage), tiered injection
4. **Extraction layer**: Session Memory automatic extraction, no manual user intervention needed
5. **Sharing layer**: Team Memory supports team-wide knowledge propagation

This system transforms Claude Code from a tool that "starts from scratch every time" into a **coding partner that understands you better the more you use it**.
