# 04 - Deep Analysis of Tool Orchestration: Why Not Use a DAG

---

## 1. partitionToolCalls: Greedy Partitioning Algorithm

### 1.1 Algorithm Core

```typescript
// toolOrchestration.ts:91-116
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data))
          } catch {
            return false  // conservative strategy
          }
        })()
      : false
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)  // append to current concurrent batch
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })  // create new batch
    }
    return acc
  }, [])
}
```

### 1.2 Algorithm Analysis

This is a **single-pass greedy** algorithm with time complexity O(n):

1. Scan the list of tool calls from left to right
2. If the current tool is concurrency-safe and the previous batch is also concurrency-safe → merge
3. Otherwise → create a new batch

**Example**:

```
Input: [Read, Read, Grep, Bash, Read, Write, Read, Read]

Scan process:
  Read   → concurrency-safe, create batch [Read]
  Read   → concurrency-safe, merge into batch [Read, Read]
  Grep   → concurrency-safe, merge into batch [Read, Read, Grep]
  Bash   → not safe, create batch [Bash]
  Read   → concurrency-safe, create batch [Read]
  Write  → not safe, create batch [Write]
  Read   → concurrency-safe, create batch [Read]
  Read   → concurrency-safe, merge into batch [Read, Read]

Result:
  [Read, Read, Grep] → concurrent batch
  [Bash]             → serial batch
  [Read]             → concurrent batch
  [Write]            → serial batch
  [Read, Read]       → concurrent batch
```

### 1.3 Concurrency Safety Determination

The `isConcurrencySafe` determination has three layers of defense:

```
1. inputSchema.safeParse(input) succeeded?
   → No: treat as unsafe (unable to parse input, handle conservatively)
2. tool.isConcurrencySafe(parsedInput) did not throw?
   → No: treat as unsafe (e.g., shell-quote parsing failed)
3. Return value is truthy?
   → No: treat as unsafe
```

**Why does shell-quote parsing failure lead to unsafe status?**

The Bash tool's `isConcurrencySafe` needs to parse the command to determine whether it is read-only (e.g., `ls` is safe, `rm` is not). If the command contains special characters that cause the shell-quote library to fail parsing, Claude Code chooses the **conservative approach** — treating it as unsafe and executing serially.

This is a safety-first design: it is better to be slower (serial) than to allow two commands with side effects to execute in parallel and cause race conditions.

### 1.4 Why Not Use Smarter Partitioning

A natural question is: why not perform dependency analysis? For example, `Read("a.ts")` and `Write("b.ts")` could theoretically run in parallel because they operate on different files.

Claude Code chooses not to do this for two reasons:

1. **The model has already made the decision** — if the model outputs `[Read, Read, Write]` in a single response, it has implicitly concluded that "this Write does not depend on the two Reads." If the Write did depend on the Read results, the model would output the Write in the next turn after the Reads complete.

2. **Dependency analysis at the framework layer is unreliable** — `Write("b.ts")` appears unrelated to `Read("a.ts")`, but if b.ts imports a.ts, modifying b.ts may affect the understanding of a.ts. This kind of semantic dependency cannot be reliably detected at the framework layer.

---

## 2. Execution Engine: Concurrent vs. Serial

### 2.1 runTools Main Controller

```typescript
// toolOrchestration.ts:19-82
export async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext
  for (const { isConcurrencySafe, blocks } of partitionToolCalls(...)) {
    if (isConcurrencySafe) {
      // concurrent path
      yield* runConcurrentBatch(blocks, currentContext)
    } else {
      // serial path
      yield* runSerialBatch(blocks, currentContext)
    }
  }
}
```

**Batches execute sequentially**, and within each batch, concurrent or serial execution is chosen based on type. This ensures that the **execution order** across batches is consistent with the order of model output.

### 2.2 Concurrent Execution Path

```typescript
// toolOrchestration.ts:152-177
async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  yield* all(
    toolUseMessages.map(async function* (toolUse) {
      yield* runToolUse(toolUse, assistantMessage, canUseTool, toolUseContext)
      markToolUseAsComplete(toolUseContext, toolUse.id)
    }),
    getMaxToolUseConcurrency(),  // default 10
  )
}
```

`all()` is a custom async generator merging function (from `utils/generators.ts`). It accepts multiple async generators, runs them at a maximum concurrency level, and yields results **in completion order**.

**Maximum concurrency of 10** is configurable via the environment variable `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`:

```typescript
// toolOrchestration.ts:8-11
function getMaxToolUseConcurrency(): number {
  return parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
}
```

### 2.3 Serial Execution Path

```typescript
// toolOrchestration.ts:118-150
async function* runToolsSerially(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext

  for (const toolUse of toolUseMessages) {
    for await (const update of runToolUse(toolUse, ...)) {
      if (update.contextModifier) {
        currentContext = update.contextModifier.modifyContext(currentContext)  // apply immediately
      }
      yield { message: update.message, newContext: currentContext }
    }
    markToolUseAsComplete(toolUseContext, toolUse.id)
  }
}
```

**Key difference**: In the serial path, context modifiers are applied **immediately** — each tool's modifications are **immediately visible** to the next tool.

---

## 3. Deferred Context Modifiers: The Core of Concurrency Safety

### 3.1 The Problem

When a tool executes, it may need to modify the shared `ToolUseContext`. For example, after the Read tool reads a file, it needs to update the file cache.

In serial execution, this is straightforward — after each tool modifies the context, the next tool sees the latest state.

But in concurrent execution, if three Read tools modify the file cache simultaneously, a **race condition** occurs — the last write overwrites the previous two.

### 3.2 Solution: Collect-Then-Apply Pattern

```typescript
// toolOrchestration.ts:30-62
// During concurrent execution
const queuedContextModifiers: Record<string, ((ctx) => ToolUseContext)[]> = {}

for await (const update of runToolsConcurrently(blocks, ...)) {
  if (update.contextModifier) {
    const { toolUseID, modifyContext } = update.contextModifier
    queuedContextModifiers[toolUseID] ??= []
    queuedContextModifiers[toolUseID].push(modifyContext)
  }
  yield { message: update.message, newContext: currentContext }  // old context
}

// After the concurrent batch ends, apply in tool declaration order
for (const block of blocks) {
  const modifiers = queuedContextModifiers[block.id]
  if (!modifiers) continue
  for (const modifier of modifiers) {
    currentContext = modifier(currentContext)
  }
}
```

Three key points of this pattern:

1. **Collection phase** (during concurrent execution): Only record modifier functions, do not execute them
2. **Application phase** (after concurrent execution): Apply them sequentially in **tool declaration order**
3. **Determinism**: Regardless of the order in which tools complete, the application order is always deterministic

### 3.3 Why Apply in Declaration Order

Applying modifiers in declaration order (rather than completion order) ensures **determinism** — the same input always produces the same output.

Consider this scenario: Read_1 and Read_2 execute concurrently, Read_1 completes first, Read_2 completes second. If applied in completion order:

```
Scenario A (Read_1 completes first): ctx → modifier_1(ctx) → modifier_2(result)
Scenario B (Read_2 completes first): ctx → modifier_2(ctx) → modifier_1(result)
```

Different network latencies could lead to different execution results. With declaration order:

```
Always: ctx → modifier_1(ctx) → modifier_2(result)
```

In practice this may rarely matter (file cache modifications are typically independent), but **determinism is the foundation of correctness**.

---

## 4. Tool Execution Details: toolExecution.ts

### 4.1 Execution Flow of runToolUse

`runToolUse` (toolExecution.ts, 1745 lines) is the entry point for executing a single tool:

```
runToolUse(toolUse, assistantMessage, canUseTool, context)
  │
  ├─ 1. findToolByName → look up tool definition
  ├─ 2. inputSchema.safeParse → validate input
  ├─ 3. canUseTool → permission check
  │     ├─ allow → continue
  │     ├─ deny → generate rejected tool_result
  │     └─ ask → prompt user for confirmation
  ├─ 4. tool.fn(input, context) → actual execution
  │     ├─ yield ProgressMessage → real-time progress
  │     └─ return result
  └─ 5. build tool_result message
        ├─ contextModifier (if any)
        └─ yield MessageUpdate
```

### 4.2 backfillObservableInput

After tool execution, Claude Code may need to backfill **observable fields** into the tool_use input — allowing the UI to display more useful information:

```typescript
if (tool.backfillObservableInput) {
  const inputCopy = { ...block.input }
  tool.backfillObservableInput(inputCopy)
  
  if (hasNewFields) {
    // clone the message, do not modify the original object
    clonedContent[i] = { ...block, input: inputCopy }
  }
}
```

For example, the Bash tool may backfill an `exitCode` field after execution, allowing the UI to display the command's exit code.

**Important**: Only **new fields are added** here, not modifications to existing fields — to avoid breaking the byte-level matching required for prompt caching.

### 4.3 Tool Progress Tracking

```typescript
// mark tool as started
toolUseContext.setInProgressToolUseIDs(prev => new Set(prev).add(toolUse.id))

// after tool execution completes
markToolUseAsComplete(toolUseContext, toolUse.id)
```

`setInProgressToolUseIDs` uses **functional updates** (passing a function rather than a new value), ensuring correctness in concurrent scenarios — similar to React's `setState(prev => ...)`.

---

## 5. Comparison with Other Orchestration Approaches

### 5.1 OpenAI Function Calling

OpenAI's `parallel_tool_calls` allows the model to output multiple tool calls simultaneously, but **does not provide an orchestration layer** — the client is responsible for deciding how to execute these tools.

Claude Code's `partitionToolCalls` + `runTools` is Anthropic's answer: a client-side orchestration layer that automatically handles concurrent/serial partitioning.

### 5.2 LangChain ToolExecutor

LangChain's ToolExecutor is serial — each tool executes sequentially. There is no concept of concurrent batches.

### 5.3 CrewAI Task Orchestration

CrewAI requires users to manually define dependencies between tasks. Claude Code's approach is **zero-configuration** — concurrency safety is declared on the tool definition, and the framework orchestrates automatically.

---

## 6. Summary

Claude Code's tool orchestration follows one core principle:

> **The framework is responsible for safety constraints; the model is responsible for decision logic.**

- The framework knows which tools are read-only (concurrency-safe)
- The framework ensures tools with side effects are never run concurrently
- The framework ensures determinism in context modifications
- The model decides which tools to call, what parameters to pass, and in what order

This division of responsibility keeps the framework code simple (188 lines), while giving the model maximum flexibility. Compared to frameworks that require manually drawing a DAG or defining dependency relationships, this is a far more elegant solution.
