# 06 - Sub-Agent Deep Analysis: Recursion, Not Orchestration

---

## 1. Core Design: Recursive Calls to query()

### 1.1 One Line of Code Says It All

```typescript
// runAgent.ts:15
import { query } from '../../query.js'
```

The entire "magic" of sub-agents lives in this import. It imports the main loop's `query()` function and **calls it recursively**:

```typescript
// runAgent.ts core logic (heavily simplified)
export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  availableTools,
  ...
}): AsyncGenerator<Message, void> {
  // Create context for the sub-agent
  const childContext = createSubagentContext(toolUseContext)
  const childTools = filterToolsForAgent(agentDefinition, availableTools)
  
  // Recursively call the main loop
  for await (const event of query({
    messages: promptMessages,
    tools: childTools,
    toolUseContext: childContext,
    canUseTool,
  })) {
    yield event  // Stream the sub-agent's output
  }
}
```

This means sub-agents automatically inherit **all capabilities** of the main loop:
- Four-layer context compression
- Seven types of error recovery
- Streaming tool execution
- Permission checks
- Model fallback

**No separate infrastructure needs to be implemented for sub-agents.**

### 1.2 Recursion vs. Orchestration

| Feature | Recursion (Claude Code) | Orchestration (CrewAI/AutoGen) |
|---------|-------------------------|-------------------------------|
| Infrastructure code | Written once, automatically inherited | Independently implemented at each layer |
| New feature propagation | Automatic (just add it to query) | Manual (update each layer) |
| Maintenance cost | O(1) | O(n), n = number of agent layers |
| Nesting depth | Bounded by token budget | Bounded by architecture |
| Debugging complexity | Just look at one function | Requires understanding multiple framework concepts |

---

## 2. Isolation Design: Selective Sharing

### 2.1 createSubagentContext

A sub-agent's context is **derived** from its parent's, but with selective isolation:

```typescript
// utils/forkedAgent.ts (simplified)
function createSubagentContext(parentContext: ToolUseContext): ToolUseContext {
  return {
    // Isolated
    abortController: new AbortController(),            // Independent cancellation
    fileStateCache: parentContext.fileStateCache.clone(), // Cloned file cache
    agentId: generateId(),                              // Independent ID
    
    // Shared
    setAppState: parentContext.setAppState,   // Global state routes to root
    getAppState: parentContext.getAppState,   // Global state
    
    // Restricted
    options: {
      tools: filteredTools,                   // Possibly a subset of tools
      ...parentContext.options,
    },
  }
}
```

### 2.2 Why AbortController Is Isolated

If a sub-agent's abort were shared with the parent:
- Sub-agent cancelled → parent also cancelled → entire session terminated

This is not the desired behavior. A sub-agent might be terminated due to timeout or user cancellation, but the parent should be able to continue working (for example, telling the user "the sub-agent timed out, let me try a different approach").

### 2.3 Why the File Cache Is Cloned

The file cache is a performance optimization that avoids reading the same file repeatedly. The reasons for cloning:

1. **Parent → Child**: The sub-agent inherits the parent's already-read file cache, avoiding redundant I/O
2. **Child → Parent**: Files newly read by the sub-agent do not pollute the parent's cache (the sub-agent may be working in a different worktree)
3. **Child → Child**: Multiple sub-agents do not interfere with each other

```typescript
// Set a size limit when cloning
const childCache = parentCache.clone()
childCache.maxSize = READ_FILE_STATE_CACHE_SIZE  // Prevent memory leaks
```

### 2.4 Why AppState Is Shared

`AppState` holds global state, most importantly **permission updates**.

Scenario: a user clicks "Always Allow for Read" in a sub-agent's dialog. If AppState were not shared, this decision would only apply to the current sub-agent — the parent and other sub-agents would continue to show dialogs.

By routing to the root store, permission updates take **immediate global effect** across all agents.

---

## 3. The Agent Definition System

### 3.1 The AgentDefinition Type

Each agent type is described by a definition file:

```typescript
type AgentDefinition = {
  name: string              // "Explore", "Plan", "general-purpose"
  prompt: string            // the agent's system prompt
  tools: string[]           // list of available tools (or ['*'])
  model?: string            // model override
  permissionMode?: string   // permission mode override
  mcpServers?: McpServer[]  // MCP servers exclusive to this agent
}
```

### 3.2 Built-in Agent Types

Claude Code ships with several built-in agent types:

| Agent | Tool Restrictions | Typical Use |
|-------|-------------------|-------------|
| `general-purpose` | All tools | Complex multi-step tasks |
| `Explore` | Read-only tools (no Edit/Write) | Code search and exploration |
| `Plan` | Read-only tools (no Edit/Write) | Designing implementation plans |

### 3.3 Tool Filtering

`filterToolsForAgent()` filters available tools according to the agent definition:

```typescript
// agentToolUtils.ts:70-116
function filterToolsForAgent(
  agentDefinition: AgentDefinition,
  allTools: Tools,
): Tools {
  // 1. MCP tools (mcp__*) are always allowed
  // 2. ALL_AGENT_DISALLOWED_TOOLS are disabled for all agents
  // 3. CUSTOM_AGENT_DISALLOWED_TOOLS are disabled for non-built-in agents
  // 4. Async agents have additional allowed-tool list restrictions
}
```

The design of always allowing MCP tools is interesting — it means tools provided by custom MCP servers are available to all agent types, unaffected by tool filtering.

---

## 4. Background Agents

### 4.1 Fire-and-Forget Mode

When `run_in_background: true`:

```
Parent agent:  [process tool 1] [process tool 2] [continue conversation...]
                                                        ↑
Sub-agent:     [running independently...]  ──done notification──→ ┘
```

The parent agent does not wait for the sub-agent to finish. The sub-agent runs independently in the background and notifies the parent via a notification mechanism when complete.

### 4.2 Lifecycle Management

```typescript
// agentToolUtils.ts:508-686
async function runAsyncAgentLifecycle({
  agentGenerator,
  taskId,
  progressTracker,
  ...
}) {
  try {
    // 1. Drive the query generator
    for await (const message of agentGenerator) {
      // Update progress
      updateAsyncAgentProgress(taskId, message)
    }
    
    // 2. Successful completion
    transitionTaskState(taskId, 'completed')
    enqueueNotification(taskId, 'completed')
    
  } catch (error) {
    // 3. Failure handling
    transitionTaskState(taskId, 'failed')
    enqueueNotification(taskId, 'failed')
  }
}
```

### 4.3 Permission Handling

Background agents have a tricky problem: they need permission confirmations, but UI focus is on the parent agent.

The solution depends on configuration:

```typescript
if (isAsync) {
  // Default: skip permission dialogs, use shouldAvoidPermissionPrompts
  shouldAvoidPermissionPrompts: true
  
  // But if canShowPermissionPrompts is explicitly configured:
  if (canShowPermissionPrompts) {
    // Dialogs are allowed, but wait for automated checks to finish first
    awaitAutomatedChecksBeforeDialog: true
  }
}
```

`awaitAutomatedChecksBeforeDialog: true` ensures all automated checks (such as classifiers) run before any dialog is shown — reducing unnecessary interruptions.

---

## 5. Worktree Isolation

### 5.1 What Is a Git Worktree

Git worktrees let you check out multiple branches from the same repository simultaneously:

```bash
git worktree add /tmp/my-experiment feature-branch
# Now /tmp/my-experiment is a complete copy of the repo
# working on feature-branch
```

### 5.2 How It Is Used in Claude Code

When `isolation: "worktree"`:

```
1. Create a temporary worktree (new branch)
2. Sub-agent works inside the worktree directory
3. All file operations happen in the worktree (main repo is unaffected)
4. After the sub-agent finishes:
   ├─ Has changes → return the worktree path and branch name
   └─ No changes → automatically clean up the worktree
```

### 5.3 Use Cases

```
User: "Try replacing Memcached with Redis and see how the performance looks"

Claude Code:
  ├─ Main branch: untouched
  └─ Worktree (sub-agent):
      ├─ Replace Memcached → Redis
      ├─ Run benchmark
      ├─ Report results
      └─ If user is happy → merge branch
         If not happy → discard worktree
```

This solves a real pain point: **letting agents experiment boldly without fear of breaking things**.

### 5.4 Engineering Details

Worktree creation and cleanup are managed by `EnterWorktreeTool` and `ExitWorktreeTool`:

- On creation: `git worktree add` + set working directory
- On cleanup: check for uncommitted changes
  - Has changes: keep the worktree, return path information
  - No changes: `git worktree remove` automatic cleanup

---

## 6. MCP Server Lifecycle

### 6.1 Agent-Exclusive MCP Servers

An agent definition can declare the MCP servers it requires:

```yaml
# agent definition
name: database-explorer
mcpServers:
  - name: postgres
    command: npx
    args: ["@modelcontextprotocol/server-postgres"]
```

### 6.2 Initialization and Cleanup

```typescript
// runAgent.ts:95-218
async function initializeAgentMcpServers(
  agentDefinition: AgentDefinition,
  parentClients: McpClients,
): Promise<{ clients: McpClients; cleanup: () => Promise<void> }> {
  // 1. Inherit the parent agent's MCP connections
  const mergedClients = { ...parentClients }
  
  // 2. Start MCP servers exclusive to this agent
  for (const server of agentDefinition.mcpServers) {
    mergedClients[server.name] = await startMcpServer(server)
  }
  
  // 3. Return a cleanup function (only cleans up newly created ones, does not close inherited ones)
  return {
    clients: mergedClients,
    cleanup: async () => {
      for (const server of agentDefinition.mcpServers) {
        await mergedClients[server.name].close()
      }
    }
  }
}
```

**Only newly created servers are cleaned up** — inherited MCP connections are managed by the parent agent; sub-agents should not close them.

---

## 7. Context Propagation

### 7.1 forkContextMessages

The parent agent can pass a portion of its conversation history to a sub-agent:

```typescript
// runAgent.ts:369-378
if (forkContextMessages) {
  // Filter out incomplete tool calls
  const filtered = filterIncompleteToolCalls(forkContextMessages)
  promptMessages = [...filtered, ...promptMessages]
}
```

**Filtering incomplete tool calls** is critical — if the parent's history contains a `tool_use` with no corresponding `tool_result` (e.g., a tool is still executing), passing it to the sub-agent will cause an API 400 error.

### 7.2 Prompt Cache Stability

`forkContextMessages` also has a cache optimization benefit: if sub-agents use the same context prefix, prompt caching can exploit those shared prefixes.

---

## 8. Classification Checks in Auto Mode

### 8.1 Handoff Classification

When `auto` mode is enabled, a sub-agent's output goes through a **classification check** before being returned to the user:

```typescript
// agentToolUtils.ts:404-460
async function classifyHandoffIfNeeded(
  agentOutput: Message[],
  autoModeEnabled: boolean,
) {
  if (!autoModeEnabled) return
  
  const decision = await classifyYoloAction(agentOutput)
  
  if (decision === 'block') {
    // Prevent the sub-agent's output from being shown directly to the user
    // Human confirmation is required
  }
}
```

This is an **additional safety net** — even if the sub-agent's permission checks passed, its final output is still reviewed by the classifier.

---

## 9. Summary

Claude Code's sub-agent system demonstrates a counterintuitive design principle:

> **The most powerful abstraction is not creating new concepts, but reusing existing ones.**

- No new "Crew" abstraction — sub-agents are just recursive `query()` calls
- No new communication protocol — sub-agents pass messages via `yield`
- No new state management — isolation is achieved through context cloning
- No new permission model — sub-agents inherit the parent's permissions

The result is a sub-agent system with **zero additional concepts** — understand `query()` and you understand sub-agents.
