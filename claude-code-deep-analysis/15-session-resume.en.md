# 15 - Session Resume and Bridge Deep Analysis: Persistence and IDE Integration

---

## 1. Two Subsystems

Session Resume and Bridge are two related but independent systems:

- **Session Resume**: Session persistence and crash recovery — allows Claude Code to continue from where it was interrupted
- **Bridge**: Bidirectional communication between the CLI/terminal and the VS Code extension — allows Claude Code to run inside an IDE

---

## 2. Session Resume: WAL-Style Persistence

### 2.1 Transcript Storage

Messages for each session are persisted in **JSONL** (JSON Lines) format:

```
File: ~/.claude/projects/{project-hash}/sessions/{session-id}.jsonl

One message per line:
{"type":"user","uuid":"abc","content":"Help me modify app.ts",...}
{"type":"assistant","uuid":"def","content":[...],...}
{"type":"attachment","uuid":"ghi","attachment":{...},...}
```

### 2.2 What Gets Persisted

| Message Type | Persisted | Reason |
|-------------|-----------|--------|
| UserMessage | Yes | User input and tool results |
| AssistantMessage | Yes | Model responses |
| AttachmentMessage | Yes | Memory and skill context |
| SystemMessage | Yes | Compression boundaries, errors, etc. |
| ProgressMessage | **No** | Transient progress, meaningless on restore |
| TombstoneMessage | **No** | Already-processed retractions |

### 2.3 Message Chain Reconstruction

Messages are linked via `parentUuid`, forming a causal chain:

```
UserMessage(uuid: "a")
  → AssistantMessage(uuid: "b", parentUuid: "a")
    → UserMessage(uuid: "c", parentUuid: "b")  // tool_result
      → AssistantMessage(uuid: "d", parentUuid: "c")
```

On restore, the full message tree is reconstructed using `parentUuid`.

### 2.4 File History Snapshots

In addition to messages, **file modification history** is also persisted:

```jsonl
{"type":"file_history_snapshot","files":{"src/app.ts":"original content..."}}
{"type":"attribution_snapshot","attributions":{...}}
```

These snapshots power the `/undo` feature — even after Claude Code restarts, files can be rolled back to a previous state.

---

## 3. Crash Recovery Flow

### 3.1 Recovery Entry Point

```typescript
// utils/sessionRestore.ts: main function
async function processResumedConversation({
  sessionId,
  transcriptMessages,
  appState,
}) {
  // 1. Restore file history
  restoreFileHistoryFromLog(transcriptMessages)
  
  // 2. Restore attribution state
  restoreAttributionFromSnapshots(transcriptMessages)
  
  // 3. Restore TodoWrite state
  restoreTodoState(transcriptMessages)
  
  // 4. Restore agent settings
  restoreAgentSettings(transcriptMessages)
  
  // 5. Restore worktree (if crashed inside a worktree)
  restoreWorktreeForResume(transcriptMessages)
  
  // 6. Switch session ID
  switchSession(sessionId)
  
  // 7. Restore cost tracking
  restoreCostStateForSession(sessionId)
}
```

### 3.2 Worktree Restore

If Claude Code crashed while inside a worktree:

```typescript
// sessionRestore.ts:332-366
async function restoreWorktreeForResume(messages) {
  // Scan message history to find the last EnterWorktree event
  const lastWorktreeEntry = findLastWorktreeEntry(messages)
  
  if (lastWorktreeEntry && !hasMatchingExit(lastWorktreeEntry)) {
    // Was inside a worktree at the time of crash
    // → cd back to the worktree directory
    process.chdir(lastWorktreeEntry.worktreePath)
  }
}
```

### 3.3 TodoWrite Restore

```typescript
// sessionRestore.ts:77-93
function restoreTodoState(messages) {
  // Scan backward to find the last TodoWrite tool call
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isToolUse(messages[i], 'TodoWrite')) {
      return messages[i].input  // the most recent todo list
    }
  }
  return null  // no todos
}
```

---

## 4. Concurrent Session Management

### 4.1 Session Registration

Each running Claude Code instance registers itself on the filesystem:

```typescript
// utils/concurrentSessions.ts:59-109
function registerSession() {
  const pidFile = `~/.claude/sessions/${process.pid}.json`
  writeFileSync(pidFile, JSON.stringify({
    pid: process.pid,
    sessionId: currentSessionId,
    cwd: process.cwd(),
    startTime: Date.now(),
    name: sessionName,
  }))
}
```

### 4.2 Live Status Updates

```typescript
// Update activity status (shown by `claude ps`)
updateSessionActivity({
  lastActivity: Date.now(),
  currentTool: 'Bash(npm install)',
  status: 'executing',
})
```

### 4.3 Stale Entry Cleanup

```typescript
// countConcurrentSessions.ts:168-204
function countConcurrentSessions() {
  const pidFiles = readdir('~/.claude/sessions/')
  let liveCount = 0
  
  for (const file of pidFiles) {
    const { pid } = JSON.parse(readFileSync(file))
    if (isProcessRunning(pid)) {
      liveCount++
    } else {
      // Process is dead, clean up the PID file
      unlinkSync(file)
    }
  }
  
  return liveCount
}
```

---

## 5. Bridge System: IDE Integration

### 5.1 Architecture Overview

```
VS Code Extension
  │
  ├─ WebSocket / SSE connection
  │
  ▼
Bridge Server (bridgeMain.ts)
  │
  ├─ Message routing
  │
  ▼
Claude Code CLI (replBridge.ts)
  │
  ├─ QueryEngine
  │
  ▼
Agent execution
```

### 5.2 Two Generations of Transport

**v1: WebSocket + POST**

```
Read:  WebSocket long-lived connection receives messages
Write: HTTP POST sends tool results
```

**v2: SSE + CCR**

```
Read:  SSE (Server-Sent Events) streaming receive
Write: CCR (Claude Code Remote) Client event push
Sequence numbers: supports safe reconnection (no full replay needed)
```

The sequence number mechanism in v2 is the key improvement — on reconnection, only the delta from the last received point is needed, rather than replaying the entire session.

### 5.3 Message Flow

```
User types in VS Code
  → Extension wraps it as a control request
    → Transport delivers it to the CLI
      → replBridge.ts parses it
        → handleIngressMessage()
          → Routes to QueryEngine
            → Agent executes
              → Results sent back via Transport
                → Extension renders to UI
```

### 5.4 Bridge State Machine

```
ready → connected → (communicating) → disconnected → reconnecting → connected
                                           │
                                           └→ failed (retry limit exceeded)
```

Reconnection uses **exponential backoff**, with a maximum of 5 attempts.

### 5.5 Control Request Types

Bridge supports multiple types of control requests:

| Request Type | Direction | Purpose |
|-------------|-----------|---------|
| Model switch | Extension → CLI | User switches model |
| Permission approval | Extension → CLI | User approves permission in IDE |
| Cancel request | Extension → CLI | User presses ESC |
| Progress update | CLI → Extension | Tool execution progress |
| Message output | CLI → Extension | Model response |
| State sync | Bidirectional | Bridge connection state |

### 5.6 Remote Permission Bridging

```typescript
// bridge/remotePermissionBridge.ts
// When the CLI needs permission confirmation, but the UI is in the VS Code Extension,
// the permission request is sent to the Extension via the bridge.
// The Extension shows a confirmation dialog.
// The user's choice is sent back to the CLI via the bridge.
```

This ensures that even when the CLI runs in the background (with no terminal UI), permission confirmations can still be handled through the IDE interface.

---

## 6. Session Creation and Archiving

### 6.1 Creation

```typescript
// bridge/createSession.ts
async function createSession(bridgeConfig) {
  const response = await fetch('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({
      environment_id: bridgeConfig.environmentId,
      title: deriveTitle(messages),
    })
  })
  return response.json()  // { session_id, ... }
}
```

### 6.2 Title Update

Session titles are **lazily generated** — after the first exchange completes, a title is automatically derived from the conversation content:

```
User: "Help me fix the JWT expiry bug in the auth module"
  → Auto title: "Fix JWT expiry bug"
```

### 6.3 Archiving

Sessions that complete or time out are archived:

```typescript
// Status: 'completed' | 'failed' | 'interrupted'
archiveSession(sessionId, { status: 'completed' })
```

---

## 7. Trusted Devices

### 7.1 Device Trust

```typescript
// bridge/trustedDevice.ts
// Bridge connections require device trust verification.
// Prevents unauthorized devices from controlling Claude Code via the bridge.
```

Device trust ensures that only the user's own device (or a device explicitly authorized by the user) can connect to Claude Code through the bridge.

---

## 8. Summary

The Session Resume and Bridge systems address two core problems:

**Session Resume** answers: "What happens if Claude Code crashes?"
- JSONL transcript provides WAL-style persistence
- Message chains are reconstructed via parentUuid
- File history snapshots power /undo
- Worktree and todo state are automatically restored

**Bridge** answers: "How do you use Claude Code inside an IDE?"
- Bidirectional communication links the CLI and VS Code Extension
- Two generations of transport (WebSocket → SSE+CCR) with continuous improvement
- Permission requests are transparently bridged to the IDE interface
- Sequence number mechanism enables safe reconnection

Together, these two systems elevate Claude Code from a "terminal tool" to a **persistent, cross-interface programming environment**.
