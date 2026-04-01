# 08 - Deep Analysis of the Message Type System: The Overlooked Infrastructure

---

## 1. Message Type Landscape

### 1.1 Seven Message Types

```typescript
type Message =
  | AssistantMessage       // Model's response
  | UserMessage            // User input / tool_result
  | SystemMessage          // Synthetic messages (compaction boundary, errors, progress)
  | ProgressMessage        // Tool execution progress
  | AttachmentMessage      // Dynamic context injection
  | ToolUseSummaryMessage  // Deferred summary of tool calls
  | TombstoneMessage       // Tombstone marker for retracted messages
```

### 1.2 The Role of Each Type

```
User input ──→ UserMessage
                │
                ▼
           API call
                │
                ▼
         AssistantMessage ──→ contains tool_use blocks
                │
                ▼
         Tool execution ──→ ProgressMessage (real-time progress)
                │
                ▼
         UserMessage (tool_result) ──→ back to API
                │
                ▼
         ToolUseSummaryMessage (async Haiku summary)
                │
                ▼
         SystemMessage (compaction boundary, errors, etc.)
                │
         AttachmentMessage (memory, skills)
                │
         TombstoneMessage (retract already-yielded messages)
```

---

## 2. AssistantMessage: The Model's Voice

### 2.1 Structure

```typescript
type AssistantMessage = {
  type: 'assistant'
  uuid: string              // Unique identifier
  message: {
    content: ContentBlock[]  // text, thinking, tool_use blocks
    usage: Usage             // Token usage
  }
  isApiErrorMessage?: boolean  // Whether this is an API error message
}
```

### 2.2 Three Kinds of Blocks in Content

```typescript
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: object }
```

A single `AssistantMessage` may simultaneously contain `thinking` (the model's reasoning process), `text` (the reply to the user), and `tool_use` (tool calls). The order of these three block types reflects the model's processing flow: think first, then reply, then call tools.

### 2.3 The isApiErrorMessage Flag

When the API returns an error (413, 429, 500, etc.), the error is wrapped into an `AssistantMessage` with `isApiErrorMessage: true` set.

The purpose of this flag:
1. **UI layer**: Renders error messages with a distinct style
2. **Main loop**: Skips stop hooks (API errors should not trigger stop hooks)
3. **Recovery logic**: Determines whether error recovery is needed

---

## 3. UserMessage: A Dual Identity

### 3.1 User Input

```typescript
const userInput = createUserMessage({
  content: "Please help me modify app.ts",
})
```

### 3.2 Tool Results

```typescript
const toolResult = createUserMessage({
  content: [{
    type: 'tool_result',
    tool_use_id: 'toolu_123',
    content: 'File content...',
  }],
  toolUseResult: 'File read successfully',   // Summary shown in the UI
  sourceToolAssistantUUID: 'asst_456',       // Associated assistant message
})
```

**The same type carries two different semantics** — this is due to the Anthropic API design: `tool_result` must be included in a message with the `user` role. Claude Code uses the `sourceToolAssistantUUID` field to distinguish "genuine user input" from "tool results."

### 3.3 The isMeta Flag

```typescript
const metaMessage = createUserMessage({
  content: 'Output token limit hit. Resume directly...',
  isMeta: true,
})
```

`isMeta: true` indicates that this is a **framework-injected meta message**, not actual user input. The UI typically does not display meta messages directly.

---

## 4. SystemMessage: A Taxonomy of Synthetic Messages

### 4.1 Subtype Enumeration

`SystemMessage` has more than 15 subtypes:

| Subtype | Purpose |
|--------|------|
| `compact_boundary` | Marks the location where compaction occurred |
| `microcompact_boundary` | Marks the location of a microcompaction |
| `api_error` | An API call failed |
| `api_metrics` | Token usage and cache hit information |
| `turn_duration` | Timing information |
| `informational` | General informational message |
| `away_summary` | Session suspension data |
| `scheduled_task_fire` | Scheduled task triggered |
| `bridge_status` | Cross-machine connection status |
| `local_command` | Local shell command |
| `memory_saved` | Automatic memory checkpoint |
| `stop_hook_summary` | Stop hook result |
| `agents_killed` | Sub-agent terminated |
| `permission_retry` | Permission recovery signal |

### 4.2 Severity Levels

```typescript
type Severity = 'info' | 'warning' | 'error'
```

- `info`: Normal information (e.g., `compact_boundary`)
- `warning`: Requires attention (e.g., model downgrade notification)
- `error`: Requires user attention (e.g., persistent API failure)

---

## 5. TombstoneMessage: Retroactive Retraction

### 5.1 The Problem Scenario

```
Timeline:
T1: Model begins streaming output → yield AssistantMessage_1 (user sees it)
T2: Model continues output → yield AssistantMessage_2 (user sees it)
T3: Model errors / downgrades → need to retract messages from T1 and T2
```

In a batch processing system, this is not a problem — you can check for errors before returning. But in a **streaming system**, messages have already been yielded to the consumer, and the user has already seen them on screen.

### 5.2 The Tombstone Solution

```typescript
type TombstoneMessage = {
  type: 'tombstone'
  targetUUID: string  // UUID of the message to retract
}
```

The main loop emits a tombstone when the model downgrades:

```typescript
// query.ts model downgrade handling
for (const msg of assistantMessages) {
  yield { type: 'tombstone', targetUUID: msg.uuid }
}
```

When the UI layer receives a tombstone:
1. Removes the message with the matching UUID from the display list
2. May show a "message retracted" indicator
3. Replaces the old output with the new model's output

### 5.3 Why Not Other Approaches

**Option A: No streaming — wait for the full response**
- Problem: Users wait too long, poor experience

**Option B: Stream output, but display an error when one occurs**
- Problem: The screen is left with a partial old output + error message + new output, creating confusion

**Option C: Tombstone (Claude Code's choice)**
- Advantage: The UI can cleanly remove old output and replace it with new output
- Trade-off: The UI layer must implement tombstone handling logic

### 5.4 Design Principle

> **Error recovery in streaming systems is an order of magnitude harder than in batch processing systems.**

Once you have yielded something, the user has already seen it — you cannot pretend it never happened. Tombstone is a "retroactive retraction" mechanism: it acknowledges that the past event occurred, but explicitly says "please disregard it."

---

## 6. ProgressMessage: Real-Time Feedback

### 6.1 Purpose

When a tool takes a long time to execute (e.g., a Bash command running `npm install`), `ProgressMessage` provides real-time feedback:

```typescript
type ProgressMessage = {
  type: 'progress'
  toolUseId: string
  content: string   // Description of the current progress
}
```

### 6.2 Separation from Result Messages

Inside `StreamingToolExecutor`, progress messages and result messages are handled **separately**:

```typescript
// Progress messages: yield immediately, without waiting for ordering
if (message.type === 'progress') {
  tool.pendingProgress.push(message)
  // Wake up the awaiter in getRemainingResults
  this.progressAvailableResolve?.()
}

// Result messages: buffer and yield in order
else {
  tool.results.push(message)
}
```

Progress messages require **low latency** (the user is waiting for feedback), while result messages require **ordering** (tool_use/tool_result pairing). Separating the two keeps both requirements from interfering with each other.

---

## 7. AttachmentMessage: Dynamic Context Injection

### 7.1 Purpose

`AttachmentMessage` is used to inject additional context into the conversation:

```typescript
type AttachmentMessage = {
  type: 'attachment'
  attachment: {
    type: 'memory' | 'skill' | 'file' | 'context'
    content: string
  }
}
```

### 7.2 Injection Timing

```
User inputs "Help me optimize this function"
  │
  ├─ Memory system retrieves relevant memories → AttachmentMessage(memory)
  ├─ Skill system matches and activates skills → AttachmentMessage(skill)
  └─ These attachments are sent to the API together with the user message
```

Attachments are inserted into the message list with special markers. The model can see them but knows they are not direct user input.

---

## 8. ToolUseSummaryMessage: Asynchronous Summary

### 8.1 Generation Flow

```
Turn N: Model called 3 tools
  │
  ├─ Tool execution completes
  ├─ Asynchronously starts Haiku to generate a summary (~1 second)
  └─ Does not wait; proceeds to Turn N+1

Turn N+1 begins:
  ├─ await pendingToolUseSummary (the summary from the previous turn)
  ├─ If already complete → yield ToolUseSummaryMessage
  └─ Continue with the current turn's logic
```

### 8.2 Design Trade-offs

- **Non-blocking**: Summary generation runs in parallel with the next API call
- **Optional**: If the Haiku call fails, the summary does not affect the main flow
- **Lightweight**: Haiku is the smallest model, with extremely low cost

---

## 9. Message Factories and Transformations

### 9.1 The Scale of utils/messages.ts

This is the **largest utility file** in the entire codebase — 5,512 lines. It contains:

- Message creation factory functions (`createUserMessage`, `createSystemMessage`, etc.)
- Message transformation functions (`normalizeMessagesForAPI`)
- Message query functions (`getMessagesAfterCompactBoundary`)
- Message manipulation functions (`stripSignatureBlocks`)
- Constant definitions (`SYNTHETIC_MESSAGES`, `REJECT_MESSAGE`)

### 9.2 normalizeMessagesForAPI

```typescript
function normalizeMessagesForAPI(messages: Message[]): APIMessage[] {
  return messages
    .filter(isAPIRelevant)        // Filter out Progress, Tombstone, etc.
    .map(toAPIFormat)             // Convert to API format
    .reduce(mergeConsecutive, []) // Merge consecutive messages of the same role
}
```

The API only accepts messages with `user` and `assistant` roles, and does not allow two consecutive messages with the same role. `normalizeMessagesForAPI` is responsible for converting Claude Code's 7 internal message types into a format the API can accept.

### 9.3 UUID Stability

Every message is assigned a `uuid` at creation time (via `crypto.randomUUID()`). This UUID remains unchanged throughout the message's entire lifecycle:

- Assigned at creation
- Preserved during compaction (summary messages inherit the UUID of the compacted messages)
- Tombstone uses the UUID to precisely locate the message to retract
- Logs and analytics use the UUID to trace messages

---

## 10. SDK Message Type Mapping

### 10.1 Internal → SDK Conversion

Claude Code's internal message types differ from the types exposed to SDK consumers:

```typescript
// Internal types
type Message = AssistantMessage | UserMessage | SystemMessage | ...

// SDK types
type SDKMessage = {
  type: 'assistant' | 'user' | 'system' | 'compact_boundary' | ...
  content: string | ContentBlock[]
  // Simplified fields
}
```

The SDK types are simpler — they hide internal implementation details (such as `isApiErrorMessage` and `sourceToolAssistantUUID`) and only expose the information that consumers need.

### 10.2 Special SDK Messages

```typescript
type SDKCompactBoundaryMessage = {
  type: 'compact_boundary'
  preCompactTokenCount: number
  postCompactTokenCount: number
}

type SDKPermissionDenial = {
  type: 'permission_denial'
  tool: string
  reason: string
}
```

These are SDK-specific message types — represented internally as `SystemMessage`, but exposed to SDK consumers as dedicated types for easier handling.

---

## 11. Summary

Claude Code's message type system may look like it "merely defines a few types," but it is in fact the **data model foundation** for the entire system.

The 7 message types correspond to 7 information flows in the agent system:
- User → Model (`UserMessage`)
- Model → User (`AssistantMessage`)
- Framework → User (`SystemMessage`)
- Tool → User (`ProgressMessage`)
- Context → Model (`AttachmentMessage`)
- Summary → User (`ToolUseSummaryMessage`)
- Retraction → UI (`TombstoneMessage`)

Each one has its own engineering reason to exist, and none can be omitted.
