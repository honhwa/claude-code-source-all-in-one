# 17 - Hook System Deep Analysis: User-Programmable Lifecycle

---

## 1. What Are Hooks

Hooks are user-defined **lifecycle callbacks** — triggered at key moments during Claude Code's execution. They allow users to:

- Automatically run lint after every file modification
- Perform additional checks before executing dangerous commands
- Automatically commit code after a turn ends
- Block certain operations (e.g., prevent modifications to production configurations)

**Important distinction**: The Hooks discussed here are the **lifecycle Hook system** under `utils/hooks/`, not React hooks (the `hooks/` directory).

---

## 2. Hook Event Types

### 2.1 Full Event List

| Event | Trigger Timing | Blockable? |
|-------|---------------|-----------|
| `UserPromptSubmit` | Before user input is sent | Yes |
| `PreToolUse` | Before tool execution | Yes |
| `PostToolUse` | After successful tool execution | Yes (inject feedback) |
| `PostToolUseFailure` | After tool execution fails | No |
| `Stop` | When a turn ends normally | Yes (continue conversation) |
| `StopFailure` | When a turn ends due to error | No (fire-and-forget) |
| `SessionStart` | When a session starts/resumes | No |
| `SubagentStart` | When a subagent starts | No |
| `SubagentStop` | When a subagent ends | No |
| `PreCompact` | Before context compaction | No |
| `PostCompact` | After context compaction | No |
| `PermissionDenied` | When permission is denied | No |
| `Notification` | Notification events | No |

### 2.2 Matcher Filtering

Each event type has different matcher fields:

```
PreToolUse/PostToolUse → filter by tool_name
  e.g.: only trigger for the Bash tool

PermissionDenied → filter by tool_name

Notification → filter by notification_type

SessionStart → filter by source
  source: 'startup' | 'resume' | 'clear' | 'compact'

SubagentStart/Stop → filter by agent_type
```

---

## 3. Hook Configuration

### 3.1 settings.json Format

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'About to run Bash'",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "FileEdit",
        "hooks": [
          {
            "type": "command",
            "command": "npx eslint --fix $EDITED_FILE",
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Check whether all modified files have corresponding tests. $ARGUMENTS"
          }
        ]
      }
    ]
  }
}
```

### 3.2 Hook Types

| Type | Execution Method | Use Cases |
|------|-----------------|-----------|
| `command` | Shell command | lint, tests, git operations |
| `prompt` | Haiku model evaluation | code review, standards checking |
| `agent` | Multi-turn agent execution | complex validation (up to 50 turns) |
| `http` | HTTP POST | external service integration |
| `function` | TypeScript callback (session-only) | programmatic validation |

### 3.3 Conditional Execution

The `if` field supports permission rule pattern matching:

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "check-git-safety.sh",
      "if": "Bash(git push *)"
    }
  ]
}
```

This hook only triggers when Bash executes `git push` — other Bash commands do not trigger it.

---

## 4. Hook Execution Engine

### 4.1 Command Hook Execution

```
Hook triggered
  │
  ├─ Serialize input to JSON
  │   { "tool_name": "Bash", "tool_input": { "command": "npm test" } }
  │
  ├─ Replace $ARGUMENTS with JSON
  │
  ├─ Execute Shell command
  │   └─ Spawn child process
  │   └─ Set timeout (default 5-60 seconds)
  │   └─ Capture stdout and stderr
  │
  └─ Handle exit code
      ├─ 0: Success (passes silently)
      ├─ 2: Block (stderr sent to model, operation prevented)
      └─ Other: Non-blocking error (stderr shown to user)
```

The **special meaning of exit code 2** is the core design of this system — it allows a hook to **prevent an operation and tell the model why**. After seeing the stderr content, the model can adjust its strategy.

### 4.2 Prompt Hook Execution

```typescript
// execPromptHook.ts
async function execPromptHook(hook, jsonInput, signal) {
  // 1. Build prompt
  const prompt = hook.prompt.replace('$ARGUMENTS', jsonInput)
  
  // 2. Call Haiku model
  const response = await sideQuery({
    model: 'haiku',
    messages: [{ role: 'user', content: prompt }],
    timeout: 30_000,  // 30 second timeout
  })
  
  // 3. Parse JSON response
  // Expected format: { ok: true } or { ok: false, reason: "..." }
  const result = parseJSON(response)
  
  // 4. Return result
  return {
    outcome: result.ok ? 'success' : 'blocking',
    reason: result.reason,
  }
}
```

### 4.3 Agent Hook Execution

```typescript
// execAgentHook.ts
async function execAgentHook(hook, jsonInput) {
  // 1. Launch subagent (via recursive query())
  const agentResult = await runSubAgent({
    prompt: hook.prompt.replace('$ARGUMENTS', jsonInput),
    maxTurns: 50,          // up to 50 turns
    timeout: 60_000,       // 60 second timeout
    tools: filteredTools,  // filter out nested agent and plan mode tools
  })
  
  // 2. Get result from StructuredOutput tool
  return extractStructuredResult(agentResult)
}
```

Agent Hooks are the most powerful type — they can **reason across multiple turns**, read files, run tests, check results, and then make a decision.

---

## 5. Hook Integration with the Main Loop

### 5.1 UserPromptSubmit

```
User inputs "Help me deploy to production"
  │
  ├─ executeUserPromptSubmitHooks()
  │   └─ Hook: "Check whether it is outside working hours"
  │       ├─ Exit code 0 → stdout passed to model ("It is currently 2 AM, be aware")
  │       └─ Exit code 2 → Block ("Deployments prohibited outside working hours", clear input)
  │
  └─ If passed → continue into query() loop
```

### 5.2 PreToolUse

```
Model decides to execute Bash("rm -rf /tmp/cache")
  │
  ├─ Permission check (canUseTool)
  │
  ├─ executePreToolUseHooks()
  │   └─ Hook: "Check the target of the rm command"
  │       ├─ Exit code 0 → allow execution
  │       └─ Exit code 2 → block, stderr sent to model
  │           Model sees: "Deleting /tmp/cache is not allowed, please use the cleanup script"
  │           Model adjusts: switches to executing "cleanup.sh"
  │
  └─ Execute tool
```

### 5.3 Stop Hook

The Stop Hook is the core of the **6th continue site** in query.ts:

```
Model finishes response (needsFollowUp = false)
  │
  ├─ handleStopHooks()
  │   └─ Hook: "Check whether modified files have tests"
  │       ├─ Exit code 0 → end normally
  │       ├─ Exit code 2 → blockingErrors
  │       │   ├─ Add stderr as a message to messages
  │       │   ├─ state = { ..., stopHookActive: true }
  │       │   └─ continue → model sees the error and keeps working
  │       └─ preventContinuation → force end
  │
  └─ return { reason: 'completed' }
```

**`stopHookActive: true`** prevents the hook from executing again on retry — avoiding the infinite loop of "hook blocks → retry → hook blocks again".

---

## 6. Hook Source Priority

```
User settings (~/.claude/settings.json)           Highest priority
  │
Project settings (.claude/settings.json)
  │
Local settings (.claude/settings.local.json)
  │
Plugin hooks (~/.claude/plugins/*/hooks/)
  │
Built-in hooks                                    Lowest priority
```

### 6.1 Enterprise Control

```typescript
// Enterprise policy can restrict hook sources
if (policySettings.allowManagedHooksOnly) {
  // Only allow hooks pushed by administrators
  // User/project/local/plugin hooks are all ignored
}
```

---

## 7. Hook Input/Output Schema

### 7.1 PreToolUse Input

```json
{
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test",
    "description": "Run tests"
  }
}
```

### 7.2 PostToolUse Input

```json
{
  "tool_name": "FileEdit",
  "inputs": {
    "file_path": "src/app.ts",
    "old_string": "...",
    "new_string": "..."
  },
  "response": {
    "success": true,
    "patch": "..."
  }
}
```

### 7.3 PostToolUseFailure Input

```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" },
  "error": "Command failed with exit code 1",
  "error_type": "execution_error",
  "is_interrupt": false,
  "is_timeout": false,
  "tool_use_id": "toolu_abc123"
}
```

### 7.4 StopFailure Input

```json
{
  "error_type": "rate_limit",
  "message": "Rate limit exceeded, retry after 30s"
}
```

Error types include: `rate_limit`, `authentication_failed`, `billing_error`, `invalid_request`, `server_error`, `max_output_tokens`, `unknown`.

---

## 8. Function Hooks: Programmatic Callbacks

```typescript
// sessionHooks.ts
// TypeScript callbacks valid only for the current session

addFunctionHook('PreToolUse', {
  id: 'my-validator',
  callback: async (input) => {
    if (input.tool_name === 'Bash' && input.tool_input.command.includes('sudo')) {
      return false  // block
    }
    return true  // allow
  }
})

// Can be removed by ID
removeFunctionHook('my-validator')
```

Function Hooks are used for **programmatic integration** — for example, temporary hooks registered by the Skill system that are automatically removed after the skill finishes executing.

---

## 9. Performance and Telemetry

### 9.1 Performance Tracking

```typescript
// Hook execution time is tracked
addToTurnHookDuration(hookDuration)
// Accumulated into the total hook duration per turn
// Used to identify slow hooks (which may affect user experience)
```

### 9.2 Progress Indication

```typescript
// Long-running hooks display progress
startHookProgressInterval(hookName)
// Updates "Running hook: validate-tests..." every second
```

### 9.3 Timeout Handling

```typescript
// Timeout = abort signal
const signal = createCombinedAbortSignal(
  parentAbortSignal,      // user cancellation
  timeoutSignal(timeout), // timeout
)
// After timeout, outcome = 'cancelled', operation is not blocked
```

---

## 10. Summary

Claude Code's Hook system makes **users co-authors of the framework**:

1. **Declarative configuration** — defined in settings.json, no code required
2. **Multiple execution methods** — Shell commands, LLM evaluation, multi-turn agents, HTTP, TypeScript callbacks
3. **Fine-grained control** — filter by tool name, command pattern, and event type
4. **Safe integration** — the exit code 2 blocking mechanism lets hooks safely prevent operations
5. **Enterprise control** — policy can restrict usage to only administrator-approved hooks

The Hook system answers a key question: **How do you adapt an agent framework to each team's unique workflow?** Not by modifying framework code, but through user-configurable lifecycle callbacks.
