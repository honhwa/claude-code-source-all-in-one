# 09 - Deep Analysis of Immutable API Messages: The Hidden Cost of Prompt Caching

---

## 1. How Prompt Caching Works

### 1.1 What Is Prompt Caching

Anthropic's prompt caching allows reuse of input tokens from previous API calls. The mechanism is analogous to HTTP caching:

```
API Call 1: [System Prompt] [Message 1] [Message 2]
                    └─────── all computed ─────────┘
                    
API Call 2: [System Prompt] [Message 1] [Message 2] [Message 3]
                    └─── cache hit ──────┘  └─ new ─┘
                    
API Call 3: [System Prompt] [Message 1*] [Message 2] [Message 3]
                    └ hit ┘ └───── all recomputed ──────────┘
```

**Key rule: cache matching is byte-level prefix matching.** Once any byte at a given position in the message list changes, all messages from that position onward must be recomputed.

### 1.2 Three Token Types

| Token Type | Meaning | Price |
|-----------|---------|-------|
| `input_tokens` | Non-cached input tokens | Standard price |
| `cache_creation_input_tokens` | Tokens cached for the first time | Standard price × 1.25 |
| `cache_read_input_tokens` | Tokens served from cache | Standard price × 0.1 |

**Cache reads cost only 10% of the standard price.** For a 100k-token session, each cache hit can save 90% of input costs.

### 1.3 Cost Quantification

Assume a 4-hour session:
- Average input per turn: 100,000 tokens
- Total turns: 200
- Standard input price: $3/M tokens

**Without caching**:
```
200 turns × 100,000 tokens × $3/M = $60
```

**With caching (90% hit rate)**:
```
200 turns × 10,000 new tokens × $3/M +
200 turns × 90,000 cached tokens × $0.3/M = $6 + $5.4 = $11.4
```

**Savings of approximately 80%.** This is the economic rationale for prompt caching.

---

## 2. Implementing the Immutability Constraint

### 2.1 Core Principle

> **AssistantMessage objects returned by the API are never modified.**

Because the messages in the `assistantMessages` array are ultimately placed back into the `messages` list and sent in the next API call, modifying any single byte of any message **invalidates all subsequent cache entries starting from that message**.

### 2.2 The Clone-Before-Modify Pattern

When a message needs to be modified (for example, to populate observable fields):

```typescript
// backfillObservableInput handling in query.ts
let yieldMessage = message  // default: yield the original message directly

if (message.type === 'assistant') {
  let clonedContent = undefined

  for (const block of message.message.content) {
    if (block.type === 'tool_use' && tool?.backfillObservableInput) {
      const inputCopy = { ...block.input }
      tool.backfillObservableInput(inputCopy)

      // Key: only clone if new fields were actually added
      if (hasNewFields) {
        clonedContent ??= [...message.message.content]
        clonedContent[i] = { ...block, input: inputCopy }
      }
    }
  }

  if (clonedContent) {
    yieldMessage = {
      ...message,
      message: { ...message.message, content: clonedContent }
    }
  }
}

yield yieldMessage  // yield the cloned version to the UI
// But the original message in assistantMessages remains unchanged!
```

### 2.3 Lazy Cloning

Notice the `clonedContent ??= [...]` idiom — cloning only happens when modification is **confirmed to be necessary**. This is a **lazy optimization**:

```
Scenario A: tool has no backfillObservableInput
  → zero clones, zero allocations

Scenario B: tool has backfillObservableInput, but no new fields
  → zero clones (inputCopy is discarded)

Scenario C: tool has backfillObservableInput, and has new fields
  → clones the content array and the modified block
```

Most cases are A or B — no cloning needed. Only scenario C requires new memory allocation.

### 2.4 Structural Sharing

Cloning uses **structural sharing**:

```typescript
yieldMessage = {
  ...message,                              // shares uuid, type, etc.
  message: {
    ...message.message,                    // shares usage, etc.
    content: clonedContent                 // new content array
  }
}
```

Only the `content` field is newly allocated; all other fields share references via the spread operator. This maximizes memory efficiency.

---

## 3. The Distinction Between messagesForQuery and messages

### 3.1 Two Message Pipelines

The main loop maintains two separate message pipelines:

```
messages (State.messages)
  │
  ├─ passed through four compression layers
  │
  └→ messagesForQuery (local variable)
       │
       ├─ sent to the API
       │
       └→ assistantMessages (returned by the API)
            │
            ├─ yielded to the UI (possibly after cloning)
            │
            └→ fed back into messages on the next iteration
```

**`messages`**: the raw, complete message history. Persists across iterations.  
**`messagesForQuery`**: the compressed version of messages. Regenerated each iteration. Never written back to `messages`.

### 3.2 Why Keep Them Separate

If there were only one pipeline (where compression directly modified `messages`), the following problems would arise:

1. Compression is irreversible — once compressed, the original information is lost.
2. The next iteration might need a different compression strategy (e.g., a turn that was snipped last time may not need to be snipped this time).
3. The results of Snip/Microcompact should not persist — they are "views," not "facts."

---

## 4. Cache Hit Tracking

### 4.1 Tracked Metrics

Claude Code tracks cache hit statistics for every API call:

```typescript
// cumulative tracking
getTotalCacheCreationInputTokens()  // total cache-creation tokens
getTotalCacheReadInputTokens()      // total cache-hit tokens
getTotalInputTokens()               // total input tokens
```

### 4.2 Cache Break Detection

```typescript
// promptCacheBreakDetection.ts
function detectCacheBreak(
  previousMessages: Message[],
  currentMessages: Message[],
): CacheBreakInfo | null {
  // compare messages one by one, find the first differing position
  // if a break is detected, record the reason and location
}
```

Cache break detection helps engineers diagnose:
- Which operations caused cache invalidation
- How large the invalidation scope was
- Whether optimizations can prevent future invalidations

### 4.3 Common Causes of Cache Breaks

| Cause | Impact | Avoidable? |
|-------|--------|-----------|
| Microcompact compressed an old message | All messages after it are invalidated | Yes (weigh the trade-off) |
| A message was modified (e.g., backfill) | All messages after it are invalidated | Yes (clone-before-modify) |
| AutoCompact rewrote history | Full invalidation (new prefix) | No (but reduces total tokens) |
| User edited a message | All messages after it are invalidated | No (user action) |

---

## 5. Immutability in the Codebase

### 5.1 Message Creation

All messages are created through factory functions and are never modified after creation:

```typescript
// factory function creation
const msg = createUserMessage({ content: '...' })
// msg.uuid is assigned at creation and never changes

// Wrong approach (never seen in Claude Code):
msg.content = 'modified content'  // ❌ violates immutability

// Correct approach:
const newMsg = createUserMessage({ content: 'modified content' })  // ✅ create a new message
```

### 5.2 Message Array Operations

Operations on message arrays also follow immutability:

```typescript
// ✅ Correct: create a new array
const newMessages = [...messages, newMessage]

// ❌ Wrong: mutate the original array
messages.push(newMessage)
```

There is one exception: `assistantMessages.length = 0` (used to clear intermediate state during model downgrade). This is an **intentional mutation** because at that point these messages have already been tombstoned as discarded and will no longer be used by the API.

### 5.3 Building Tool Results

After a tool finishes executing, the `tool_result` is a **newly created** message — not a modification of an existing one:

```typescript
// tool execution
const result = await tool.fn(input)

// create a new tool_result message
const resultMessage = createUserMessage({
  content: [{
    type: 'tool_result',
    tool_use_id: toolUseBlock.id,
    content: result,
  }],
})
```

---

## 6. Comparison with Other Systems

### 6.1 OpenAI's Prompt Caching

OpenAI also supports prompt caching, but the mechanism differs:
- Anthropic: the client controls cache boundaries and must manually maintain immutability.
- OpenAI: caching is handled automatically server-side; the client needs no special handling.

Claude Code's immutability constraint is the **client-side cost** of Anthropic prompt caching — it requires more engineering effort but provides finer-grained control.

### 6.2 Google's Context Caching

Google's context caching is explicit — you actively create a "cached content" object that subsequent requests reference. This is easier to reason about than Anthropic's implicit caching, but offers less flexibility.

---

## 7. Summary

Immutable API messages are not a "code style" choice — they are a **cost optimization decision**.

```
Immutability constraint
  → prompt caching byte-level matching
    → 90% of input tokens served from cache
      → 80% reduction in input costs
        → economic viability of long sessions
```

This causal chain reveals an important engineering lesson: **system-level constraints (immutability) can yield enormous runtime benefits (cost savings).**

The Claude Code team chose to absorb the complexity of immutability at the code level (clone-before-modify, structural sharing, dual message pipelines) in exchange for reduced costs and improved performance at the user level. This is a classic "developer experience vs. user experience" trade-off — and they chose the user.
