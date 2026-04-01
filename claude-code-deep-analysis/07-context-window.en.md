# 07 - Deep Analysis: Context Window Management — The Real Engineering Deep End

---

## 1. Why Four Layers of Compression Are Needed

A typical AI coding session can last 4 hours. Over those 4 hours:

```
- 50 files read (average 200 lines each) = ~50,000 lines
- 100 Bash commands executed (average 50 lines of output each) = ~5,000 lines
- 200 model responses generated (average 100 lines each) = ~20,000 lines
```

Rough estimate: **75,000 lines of text ≈ 300,000+ tokens**.

Even with a model that has a 200k context window, this far exceeds the limit. More importantly, longer context = slower inference + higher cost.

Claude Code's solution is not a generic compression algorithm, but a **four-layer progressive compression** approach — each layer addresses a different granularity of problem, with cost increasing from zero to high.

```
Raw messages ─→ Snip ─→ Microcompact ─→ Context Collapse ─→ AutoCompact ─→ API
                  │          │                │                  │
               zero cost  zero API calls  deferred summary   full summary
               drops turn  trims tool_result  read-time projection  separate API call
```

---

## 2. Layer 1: Snip — Zero-Cost Pruning

### 2.1 Trigger Condition

Runs automatically when `feature('HISTORY_SNIP')` is enabled.

### 2.2 Removal Rules

Snip removes **entire turns** — a paired assistant message + tool_result. The rules for determining "low value":

```
Low-value turn =
  ├─ Tool call returned empty result (grep found nothing, glob matched nothing)
  ├─ Tool call was rejected by the user (tool_result is REJECT_MESSAGE)
  └─ Turn already covered by a context collapse
```

### 2.3 Why It Is Zero-Cost

Snip is a purely local operation — it iterates over the message array and filters out qualifying turns. No API calls, no LLM-generated summaries; it is simply an `Array.filter()`.

### 2.4 Risk

Snip may remove information the model might need to reference later. In practice, however, turns with empty results genuinely carry almost no reference value — "not found" contains no useful information in itself.

---

## 3. Layer 2: Microcompact — Cache-Aware Trimming

### 3.1 Goal

Compress the content of `tool_result` while **leaving the message structure intact**.

### 3.2 Compressible Tools

```typescript
// microCompact.ts
const COMPACTABLE_TOOLS = new Set([
  'Read',          // file contents
  'Bash',          // command output
  'Grep',          // search results
  'Glob',          // file listings
  'WebSearch',     // search results
  'WebFetch',      // web page content
])
```

The output of these tools is often very long (a large file may be 1,000+ lines), but in subsequent conversation turns only a summary is typically needed.

### 3.3 Compression Strategies

Microcompact uses two strategies:

**Time-based cleanup**:
```typescript
// tool_results older than a threshold are replaced with a placeholder
if (messageAge > threshold) {
  toolResult.content = TIME_BASED_MC_CLEARED_MESSAGE
  // "[This tool result has been cleared to save context space]"
}
```

**Cache-aware compression**:
```typescript
// Only compress messages that are not in the prompt cache
if (!isInPromptCache(message)) {
  compress(message)
}
```

### 3.4 Deep Integration with Prompt Caching

This is the most clever aspect of Microcompact. Anthropic's prompt caching is based on **message prefix matching** — if you modify an earlier message in the list, the cache is invalidated for all subsequent messages.

Microcompact understands this rule, so it:

1. **Only compresses tail messages** — messages earlier in the list may be cached; compressing them would cause widespread cache invalidation.
2. **Delays emitting boundary messages** — the actual `cache_deleted_input_tokens` value is only available after the API response.
3. **Calculates compression benefit** — the tokens saved by compression must exceed the cost of cache invalidation.

```
Compression decision = tokens saved by compression > tokens lost from cache invalidation ?
  Yes → perform compression
  No  → leave as-is (preserving the cache is more cost-effective)
```

### 3.5 Image Token Estimation

Microcompact also handles image messages. Token estimation for images uses a fixed upper bound:

```typescript
const IMAGE_MAX_TOKEN_SIZE = 2000  // at most 2000 tokens per image
```

---

## 4. Layer 3: Context Collapse — Read-Time Projection

### 4.1 Design Philosophy

Context Collapse is the most innovative layer. Rather than modifying the original messages, it creates a **virtual view**.

Using a database analogy:
- Snip/Microcompact = modifying rows in-place (UPDATE/DELETE)
- Context Collapse = creating a view (CREATE VIEW)

### 4.2 How It Works

```
Original messages: [M1, M2, M3, M4, M5, M6, M7, M8, M9, M10]

Collapse operation:
  "Summarize M3–M7 as S1"

Collapse store:
  { range: [3,7], summary: S1 }

Output of projectView():
  [M1, M2, S1, M8, M9, M10]

The original messages are unchanged!
```

### 4.3 Read-Time Projection: projectView()

At the entry point of each loop iteration, `projectView()` replays the collapse log to produce a compressed view:

```typescript
// Each iteration
const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
  messagesForQuery, toolUseContext, querySource,
)
messagesForQuery = collapseResult.messages
// The original messages are unchanged! This is a projection, not a mutation.
```

### 4.4 Why Not Modify In-Place

Two reasons:

1. **Cross-turn persistence** — collapse records live in the store and remain valid even after Claude Code restarts. If messages were modified directly, summaries would be lost after a restart (the original messages would have been replaced).

2. **Decoupling from autocompact** — if collapse has already brought the token count below the threshold, autocompact does not need to run, saving one API call. If messages were modified directly, it would be impossible to distinguish between "already collapsed" and "still needs autocompact".

### 4.5 Overflow Recovery

When the API returns 413 (prompt too long), Context Collapse provides the first level of recovery:

```typescript
// contextCollapse.recoverFromOverflow()
const drained = contextCollapse.recoverFromOverflow(messagesForQuery, querySource)
// Immediately commits all pending collapses (freeing more space)
// If there were previously deferred summaries, they are all committed now
```

The "drain" metaphor is apt — like draining accumulated water from a pipe, all pending collapses are committed at once.

---

## 5. Layer 4: AutoCompact — Full Summarization

### 5.1 Trigger Condition

```typescript
// autoCompact.ts:72-91
function getAutoCompactThreshold(): number {
  const effectiveContextWindow = getModelContextWindow()
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS  // subtract a 13,000-token buffer
}

// Triggered when token usage exceeds the threshold
if (tokenCount > getAutoCompactThreshold()) {
  await autocompact()
}
```

### 5.2 Compression Process

AutoCompact is the heaviest operation — it forks a separate API call to generate a summary:

```
1. Remove images (reduce tokens)
2. Remove re-injected attachments (skill_discovery, etc.)
3. Call the LLM to generate a summary of the entire session
4. Restore file context (up to 5 files, 50K token budget)
5. Re-inject skills (up to 5K tokens per skill)
6. Construct the compressed message array
```

### 5.3 Circuit Breaker

```typescript
// Automatically disabled after 3 consecutive compression failures
if (consecutiveFailures >= 3) {
  disableAutoCompact()
  logEvent('tengu_autocompact_circuit_breaker')
}
```

Why is a circuit breaker needed? Because compression failures typically indicate a systemic issue (API unavailable, prompt too long to even generate a summary). Continuing to retry would only waste tokens and time.

### 5.4 Token Budget Carried Across Compressions

```typescript
// query.ts:282-291
let taskBudgetRemaining: number | undefined = undefined

// Record before compression
const preCompactContext = finalContextTokensFromLastResponse(messagesForQuery)
taskBudgetRemaining = Math.max(
  0,
  (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
)
```

This ensures **continuity** of the token budget across compressions — the compressed summary message does not contain the full history, so the server cannot accurately calculate the budget already consumed. The client passes this information via `taskBudgetRemaining`.

### 5.5 The compact_boundary Message

```typescript
// Emitted as a boundary message after compression completes
yield createSystemMessage('compact_boundary', {
  preCompactTokenCount: result.preCompactTokenCount,
  postCompactTokenCount: result.postCompactTokenCount,
})
```

This boundary message lets SDK consumers know that "a context compression occurred here." The UI can use it to render a visual separator.

---

## 6. Three-Level Error Recovery Waterfall

### 6.1 prompt_too_long (413) Recovery

```
API returns 413
  │
  ├─ Level 1: Context Collapse drain
  │  ├─ Condition: CONTEXT_COLLAPSE feature enabled
  │  │            AND last transition was not collapse_drain_retry
  │  ├─ Action: recoverFromOverflow() commits all pending collapses
  │  └─ Outcome:
  │      ├─ committed > 0 → continue (retry the API call)
  │      └─ committed = 0 → escalate to Level 2
  │
  ├─ Level 2: Reactive Compact
  │  ├─ Condition: REACTIVE_COMPACT feature enabled
  │  │            AND hasAttemptedReactiveCompact === false
  │  ├─ Action: tryReactiveCompact() performs an emergency full compression
  │  └─ Outcome:
  │      ├─ Compression succeeded → continue (retry with compressed messages)
  │      └─ Compression failed → escalate to Level 3
  │
  └─ Level 3: Give up
     └─ yield error message to the user
     └─ return { reason: 'prompt_too_long' }
```

### 6.2 Why Collapse Drain Takes Priority

Collapse drain is far cheaper than reactive compact:
- Collapse drain: zero API calls, merely commits already-generated summaries
- Reactive compact: one full API call to generate a new summary

Try the cheap option first; escalate to the expensive one only if it is insufficient.

### 6.3 max_output_tokens Recovery

```
Model output truncated
  │
  ├─ Level 1: Upgrade token limit
  │  ├─ Condition: currently using the default 8k limit
  │  │            AND tengu_otk_slot_v1 feature enabled
  │  ├─ Action: set maxOutputTokensOverride = 64k
  │  └─ Retry the same request (without injecting any messages)
  │
  └─ Level 2: Inject continuation prompt
     ├─ Condition: maxOutputTokensRecoveryCount < 3
     ├─ Action: inject meta message
     │   "Output token limit hit. Resume directly —
     │    no apology, no recap of what you were doing.
     │    Pick up mid-thought if that is where the cut happened.
     │    Break remaining work into smaller pieces."
     └─ Retry (up to 3 times)
```

### 6.4 Analysis of the Continuation Prompt Wording

```
"no apology, no recap"
```

Why explicitly say "no apology, no recap"?

Because the **default behavior** of an LLM after truncation is to apologize and then recap what it was saying — "Sorry, I was in the middle of saying… let me continue." This wastes a large number of tokens, and the user has already seen the prior output, making a recap unnecessary.

```
"Pick up mid-thought if that is where the cut happened"
```

This tells the model it can resume from the **middle of a sentence** — it does not need to start a complete new sentence. This maximizes the efficiency of the continuation.

```
"Break remaining work into smaller pieces"
```

This is a **strategy-adjustment instruction** — it tells the model to keep subsequent outputs shorter to avoid being truncated again.

**A single meta prompt solves three problems at once: avoiding waste, maintaining coherence, and preventing recurrence.**

### 6.5 Media Size Error Recovery

In addition to 413, there is a special variant of prompt_too_long caused by oversized images or PDFs.

```typescript
const isWithheldMedia = mediaRecoveryEnabled &&
  reactiveCompact?.isWithheldMediaSizeError(lastMessage)
```

Media errors **bypass collapse drain** (collapse does not handle images) and go directly to reactive compact. Reactive compact's strip-retry removes the oversized media and retries.

If the request is still too large after removal (oversized media is in the "retained tail"), `hasAttemptedReactiveCompact` prevents an infinite loop.

---

## 7. Collaboration Between the Four Layers

### 7.1 Execution Order

```typescript
// query.ts — each loop iteration
let messagesForQuery = messages

// Layer 1: Snip
messagesForQuery = snip(messagesForQuery)

// Layer 2: Microcompact
messagesForQuery = microcompact(messagesForQuery)

// Layer 3: Context Collapse
messagesForQuery = contextCollapse.projectView(messagesForQuery)

// Layer 4: AutoCompact (conditionally triggered)
if (tokenCount > threshold) {
  messagesForQuery = autocompact(messagesForQuery)
}

// Send to API
callModel(messagesForQuery)
```

### 7.2 Complementary Roles

| Layer | Granularity | Cost | Fidelity |
|-------|-------------|------|----------|
| Snip | Entire turn | Zero | Low (entire turn disappears) |
| Microcompact | tool_result content | Zero | Medium (structure preserved) |
| Context Collapse | Range spanning multiple turns | Low | Medium-high (LLM summary) |
| AutoCompact | Entire session | High | Highest (complete summary) |

The four-layer design guarantees: **if a problem can be solved cheaply, it will not be solved expensively.**

---

## 8. Summary

Context window management is the **most complex, most critical, and most overlooked** system in Claude Code.

It never appears in product-launch demos — a 5-minute demo will not trigger any compression layer. But for real users — engineers who spend 4 hours with Claude Code completing a large-scale refactor — this system is the foundation that allows them to keep working.

Four-layer progressive compression, three-level error recovery, cache-aware compression decisions — these "unglamorous but essential" engineering efforts are what separates a demo from a product.
