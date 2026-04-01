# 03 - Deep Analysis of Streaming Processing: More Than Just Character-by-Character Display

---

## 1. Core Design of StreamingToolExecutor

### 1.1 Why Streaming Tool Execution Is Needed

Traditional agent frameworks execute tools like this:

```
1. Wait for the complete API response
2. Parse out all tool_use blocks
3. Execute each tool sequentially
4. Collect all results
5. Send to the API
```

Claude Code's approach is entirely different:

```
1. API begins streaming the response
2. A tool_use block arrives in full → start executing immediately
3. Continue receiving the stream → more tool_use blocks → execute in parallel
4. API response ends
5. Wait for all tools to complete
```

**Core advantage: tool execution overlaps with API streaming.** If the model outputs 3 Read tools, the first Read starts executing while the model is still outputting the third.

### 1.2 Class Structure

```typescript
// StreamingToolExecutor.ts:40-62
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []           // All known tools
  private toolUseContext: ToolUseContext       // Shared context
  private hasErrored = false                  // Whether a Bash tool has errored
  private erroredToolDescription = ''         // Description of the errored tool
  private siblingAbortController: AbortController  // sibling abort
  private discarded = false                   // Whether discarded (model fallback)
  private progressAvailableResolve?: () => void    // Progress wake-up signal
}
```

### 1.3 TrackedTool Lifecycle

Each tool goes through four states:

```
queued → executing → completed → yielded
  │         │           │          │
  │         │           │          └─ Result has been passed to the consumer
  │         │           └─ Execution complete, result cached
  │         └─ Currently executing
  └─ Waiting to execute
```

```typescript
// StreamingToolExecutor.ts:21-32
type TrackedTool = {
  id: string
  block: ToolUseBlock
  assistantMessage: AssistantMessage
  status: ToolStatus   // 'queued' | 'executing' | 'completed' | 'yielded'
  isConcurrencySafe: boolean
  promise?: Promise<void>
  results?: Message[]
  pendingProgress: Message[]         // Progress messages (yielded immediately)
  contextModifiers?: Array<(ctx: ToolUseContext) => ToolUseContext>
}
```

**The separation of progress messages and result messages** is a key design decision. Progress messages (such as real-time output from Bash commands) must be passed to the UI **immediately**, while result messages must be passed **in order** (to ensure tool_use/tool_result pairing).

---

## 2. Concurrency Control Model

### 2.1 canExecuteTool Logic

```typescript
// StreamingToolExecutor.ts:129-135
private canExecuteTool(isConcurrencySafe: boolean): boolean {
  const executingTools = this.tools.filter(t => t.status === 'executing')
  return (
    executingTools.length === 0 ||                           // No tools are currently executing
    (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))  // All are concurrency-safe
  )
}
```

The rules are simple:
- If no tool is executing → can execute
- If a tool is executing, and both the current tool and all executing tools **are concurrency-safe** → can execute
- Otherwise → queue and wait

### 2.2 processQueue Scheduling

```typescript
// StreamingToolExecutor.ts:140-151
private async processQueue(): Promise<void> {
  for (const tool of this.tools) {
    if (tool.status !== 'queued') continue

    if (this.canExecuteTool(tool.isConcurrencySafe)) {
      await this.executeTool(tool)
    } else {
      // A non-concurrency-safe tool blocks all subsequent tools
      if (!tool.isConcurrencySafe) break
    }
  }
}
```

**Key detail**: When a non-concurrency-safe tool is encountered that cannot yet execute, the loop `break`s — it does not continue checking subsequent tools. This guarantees that **operations with side effects execute in the order the model output them**.

However, if a concurrency-safe tool cannot execute (because a non-concurrency-safe tool ahead of it is executing), it is **skipped** rather than breaking — it can execute after the preceding tool completes.

### 2.3 Execution Flow Example

Suppose the model outputs: `[Read_1, Read_2, Bash_1, Read_3, Read_4]`

```
Timeline:
T0: addTool(Read_1) → execute immediately (no tools executing)
T1: addTool(Read_2) → execute immediately (Read_1 is concurrency-safe)
T2: addTool(Bash_1) → queued (Read_1, Read_2 are executing)
T3: addTool(Read_3) → queued (Bash_1 is queued and non-concurrency-safe, break)
T4: addTool(Read_4) → queued
T5: Read_1 completes → processQueue → Bash_1 still cannot execute (Read_2 still running)
T6: Read_2 completes → processQueue → Bash_1 starts executing
T7: Bash_1 completes → processQueue → Read_3 starts, Read_4 starts
T8: Read_3 + Read_4 complete
```

---

## 3. Three-Level AbortController Hierarchy

### 3.1 Hierarchy Relationship

```
toolUseContext.abortController (top level - user presses Ctrl+C)
  ↓ createChildAbortController
siblingAbortController (middle level - Bash error cascade)
  ↓ createChildAbortController
toolAbortController (bottom level - per-tool independent)
```

This is a **tree-shaped cancellation propagation** model:
- Top-level abort → all tools stop
- Middle-level abort → sibling tools in the current batch stop, but does not affect the loop
- Bottom-level abort → only affects a single tool

### 3.2 Why Only Bash Triggers Sibling Abort

```typescript
// StreamingToolExecutor.ts:357-363
if (isErrorResult) {
  thisToolErrored = true
  if (tool.block.name === BASH_TOOL_NAME) {
    this.hasErrored = true
    this.erroredToolDescription = this.getToolDescription(tool)
    this.siblingAbortController.abort('sibling_error')
  }
}
```

**Only a Bash tool error triggers sibling abort.** The source code comment explains the reason:

> "Only Bash errors cancel siblings. Bash commands often have implicit dependency chains (e.g. mkdir fails → subsequent commands pointless). Read/WebFetch/etc are independent — one failure shouldn't nuke the rest."

This is an engineering decision based on **domain knowledge**:
- Bash commands often have implicit dependencies (`mkdir` fails → subsequent `cd` is pointless)
- Read/Grep/WebFetch are independent (failing to read one file does not affect another)

### 3.3 Synthetic Error Messages

Aborted tools cannot simply "disappear" — the API requires every `tool_use` block to have a corresponding `tool_result`. Therefore, cancelled tools receive a **synthetic error message**:

```typescript
// StreamingToolExecutor.ts:153-204
private createSyntheticErrorMessage(
  toolUseId: string,
  reason: 'sibling_error' | 'user_interrupted' | 'streaming_fallback',
  assistantMessage: AssistantMessage,
): Message {
  if (reason === 'sibling_error') {
    return createUserMessage({
      content: [{
        type: 'tool_result',
        content: `<tool_use_error>Cancelled: parallel tool call ${desc} errored</tool_use_error>`,
        is_error: true,
        tool_use_id: toolUseId,
      }],
    })
  }
  // ... synthetic messages for other reasons
}
```

These synthetic messages ensure the **pairing integrity** of API tool_use/tool_result — even when a tool is cancelled, the model can see "this tool was cancelled for reason X."

### 3.4 Special Handling for Permission Denial

When a user denies permission for a tool, the per-tool abort needs to **bubble up** to the top level:

```typescript
// StreamingToolExecutor.ts:304-318
// Permission-dialog rejection also aborts this controller
// — that abort must bubble up to the query controller so the
// query loop's post-tool abort check ends the turn.
const toolAbortController = createChildAbortController(this.siblingAbortController)
toolAbortController.signal.addEventListener('abort', () => {
  if (toolAbortController.signal.reason === 'permission_rejected') {
    toolUseContext.abortController.abort('permission_rejected')
  }
})
```

This is **selective bubbling** — only the `permission_rejected` reason bubbles up to the top level; other reasons (such as `sibling_error`) do not. This ensures that permission denial correctly terminates the entire turn, while sibling tool errors only affect the current batch.

---

## 4. discard() and Model Fallback

When the primary model is overloaded and a fallback model must be used, what happens to tools already mid-stream?

```typescript
// StreamingToolExecutor.ts:68-71
discard(): void {
  this.discarded = true
}
```

`discard()` sets a flag. Afterwards:
1. Queued tools will not start executing
2. Executing tools will find `discarded === true` on their next abort check
3. All unfinished tools receive a `streaming_fallback` synthetic error message

The main loop (query.ts) calls discard() on model fallback, then creates a **new** StreamingToolExecutor:

```typescript
// query.ts:913-918
streamingToolExecutor.discard()
streamingToolExecutor = new StreamingToolExecutor(
  toolUseContext.options.tools,
  canUseTool,
  toolUseContext,
)
```

This ensures that the new model's tool execution does not get mixed up with leftover results from the old model.

---

## 5. Result Ordering and Progress Streaming

### 5.1 getCompletedResults: Synchronous Collection

```typescript
// Collect results from completed tools (no waiting)
*getCompletedResults() {
  for (const tool of this.tools) {
    // Yield progress messages first
    yield* tool.pendingProgress
    
    if (tool.status === 'completed') {
      yield* tool.results
      tool.status = 'yielded'
    } else {
      break  // Preserve ordering
    }
  }
}
```

### 5.2 getRemainingResults: Asynchronous Waiting

```typescript
// Wait for all tools to complete and collect results
async *getRemainingResults() {
  while (hasUnfinishedTools()) {
    await Promise.race([
      ...toolPromises,           // Wait for any tool to complete
      progressAvailablePromise,  // Or for new progress messages
    ])
    // Collect and yield available results
    yield* getCompletedResults()
  }
}
```

The use of `Promise.race` ensures **low-latency progress feedback** — there is no need to wait for all tools to finish; any progress update from any tool can be immediately delivered to the UI.

### 5.3 Interrupt Behavior Classification

```typescript
// StreamingToolExecutor.ts:233-241
private getToolInterruptBehavior(tool: TrackedTool): 'cancel' | 'block' {
  const definition = findToolByName(this.toolDefinitions, tool.block.name)
  if (!definition?.interruptBehavior) return 'block'  // Default: non-interruptible
  try {
    return definition.interruptBehavior()
  } catch {
    return 'block'  // Conservative fallback on error
  }
}
```

Each tool can declare its own interrupt behavior:
- `'block'` (default) — non-interruptible; the user must wait for it to complete
- `'cancel'` — can be safely cancelled

When the user inputs a new message during tool execution (the `interrupt` reason), only `cancel`-type tools are stopped. This prevents file-write operations from being accidentally interrupted and causing file corruption.

---

## 6. Comparison with Traditional Approaches

| Feature | Traditional Agent Framework | Claude Code |
|---------|----------------------------|-------------|
| Tool execution timing | After API response completes | During streaming |
| Concurrency control | None / manual | Automatic (based on concurrency-safe declaration) |
| Error propagation | Global abort | Selective cascade (Bash-only) |
| Progress feedback | Polling / callbacks | Streaming yield |
| Interrupt handling | Cancel all | Classified cancellation (block/cancel) |
| Result ordering | Execution order | Declaration order (guaranteed pairing) |

Claude Code's streaming processing is not a simple "display characters one by one" — it is a complete **concurrent execution framework** that addresses the core problems of ordering, cancellation, error propagation, and resource cleanup in a streaming system.
