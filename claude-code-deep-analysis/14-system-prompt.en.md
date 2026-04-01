# 14 - System Prompt Construction Deep Analysis: The Foundation of Model Behavior

---

## 1. Why the System Prompt Deserves Its Own Analysis

The system prompt is the **origin** of model behavior — every decision the model makes is influenced by it. Claude Code's system prompt is not a static string; it is a **dynamically assembled** multi-module system involving cache optimization, multi-source merging, and runtime adaptation.

---

## 2. Modular Architecture

### 2.1 The Section System

```typescript
// constants/systemPromptSections.ts:20
function systemPromptSection(name: string, compute: () => string) {
  // Caches the computed result of the section
  // cache break = false → result can be reused by prompt cache
}

// :32
function DANGEROUS_uncachedSystemPromptSection(name, compute, reason) {
  // cache break = true → recomputed on every call
  // Used for dynamically changing content (e.g., MCP server connection state)
}
```

The difference between the two section types:

| Type | Caching Behavior | Use Cases |
|------|-----------------|-----------|
| `systemPromptSection` | Caches result, reused across turns | Static content (rules, instructions) |
| `DANGEROUS_uncachedSystemPromptSection` | Recomputed every time | Dynamic content (MCP instructions) |

### 2.2 Dynamic Boundary

```typescript
// constants/prompts.ts:105-115
SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

This boundary splits the system prompt into two parts:

```
[Static Part - Globally Cacheable]
  ├─ Base instructions
  ├─ Code style rules
  ├─ Tool usage guidelines
  └─ Safety rules
  
__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__

[Dynamic Part - Different Per Session]
  ├─ Environment info (CWD, git status)
  ├─ Memory content
  ├─ MCP server instructions
  └─ User language preference
```

The **static part** shares a prompt cache across all users and all sessions. The **dynamic part** differs per session, but can be cached across multiple turns within the same session.

---

## 3. Prompt Assembly Flow

### 3.1 Main Function

```typescript
// constants/prompts.ts:491-577
function getSystemPrompt({
  tools,                        // Available tool set
  model,                        // Model ID
  additionalWorkingDirectories, // Additional working directories
  mcpClients,                   // MCP server connections
}): SystemPromptSection[] {
  
  return [
    // Static sections
    getSimpleIntroSection(),           // "You are an interactive agent..."
    getSimpleSystemSection(),          // System behavior rules
    getSimpleDoingTasksSection(),      // Task execution guidelines
    getActionsSection(),               // Risk assessment framework
    getUsingYourToolsSection(),        // Tool usage preferences
    getToneAndStyleSection(),          // Tone and style
    
    // Dynamic sections
    systemPromptSection('memory', () => loadMemoryPrompt()),
    systemPromptSection('env_info', () => computeEnvInfo()),
    systemPromptSection('language', () => getLanguageSection()),
    systemPromptSection('output_style', () => getOutputStyleSection()),
    
    // Cache-breaking sections
    DANGEROUS_uncachedSystemPromptSection(
      'mcp_instructions',
      () => getMcpInstructions(mcpClients),
      'MCP servers may connect/disconnect at runtime'
    ),
  ]
}
```

### 3.2 Section Resolution

```typescript
// systemPromptSections.ts:43
async function resolveSystemPromptSections(sections) {
  const results = []
  for (const section of sections) {
    const content = section.cached 
      ? getCachedOrCompute(section) 
      : section.compute()
    if (content) results.push(content)
  }
  return results.join('\n\n')
}
```

Empty sections are skipped — if there are no MCP instructions or language preferences, the corresponding section will not appear in the prompt.

---

## 4. Core Sections Explained

### 4.1 Intro Section: Role Definition

```
You are an interactive agent that helps users with software engineering tasks.
Use the instructions below and available tools to assist the user.
```

Also includes:
- Cybersecurity risk instructions (to prevent prompt injection)
- Output style reference (if configured by the user)

### 4.2 System Section: System Behavior

Defines how the model should handle system-level behavior:

- **Tool execution**: Executed under the permission mode chosen by the user
- **System Tag handling**: The meaning of tags such as `<system-reminder>`
- **Prompt Injection warning**: Tool results may contain injection attempts
- **Hook feedback**: How to interpret hook output
- **Auto-compaction**: Notification of the existence of context compaction

### 4.3 Doing Tasks Section: Code Style

This is one of the longest sections in the prompt, and defines Claude Code's coding philosophy:

```
- No over-engineering
- Do not add unrequested features
- Do not add unnecessary error handling
- Trust internal code and framework guarantees
- Only validate at system boundaries (user input, external APIs)
- Three lines of similar code is better than premature abstraction
- Do not create backward-compatibility hacks
```

### 4.4 Actions Section: Risk Assessment

Defines the **reversibility and blast radius** assessment framework:

```
For operations that are hard to reverse, affect shared systems, or may be risky:
- Destructive operations: deleting files/branches, dropping database tables
- Hard to reverse: force-push, git reset --hard
- Visible to others: pushing code, creating PRs, sending messages
- Uploading to third-party tools
```

### 4.5 Using Your Tools Section: Tool Preferences

```
- Do not use Bash to run cat/grep/sed; use dedicated tools (Read/Grep/Edit)
- Use TodoWrite to track progress
- Execute multiple independent tool calls in parallel
- Execute tool calls with dependencies sequentially
```

### 4.6 Environment Info Section: Runtime Context

```typescript
function computeEnvInfo() {
  return `
  - Primary working directory: ${cwd}
  - Is Git repo: ${isGitRepo}
  - Additional working directories: ${additionalDirs}
  - Platform: ${platform}
  - Shell: ${shell}
  - OS version: ${osVersion}
  - Model: ${modelDescription}
  - Knowledge cutoff: ${knowledgeCutoff}
  `
}
```

---

## 5. Cache Optimization

### 5.1 Cache Layers

```
Level 1: Memoize cache for systemPromptSection
  └─ Within the same session, each section is computed only once

Level 2: Static prefix of Prompt Cache
  └─ Content before the dynamic boundary is reused across API calls

Level 3: Dynamic part of Prompt Cache
  └─ The dynamic part may also be cached within the same session
```

### 5.2 clearSystemPromptSections()

```typescript
// systemPromptSections.ts:65
function clearSystemPromptSections() {
  // Clears all memoize caches
  // Triggered by: /clear, /compact, MCP server connection changes
}
```

When the system prompt needs to be refreshed (e.g., the MCP server list changes), this function is called to clear the cache. The next API call will recompute all sections.

### 5.3 The Cost of DANGEROUS_uncachedSystemPromptSection

MCP instructions are marked as `DANGEROUS_uncached`, meaning they are **recomputed on every API call**. If MCP servers connect and disconnect frequently, this will cause the dynamic part of the prompt cache to be invalidated.

This is a deliberate trade-off: **correctness takes priority over cache efficiency**. MCP instructions must reflect the current connection state, even if that means more cache misses.

---

## 6. Multi-Source Merging

### 6.1 Sources of Information

The content of the system prompt comes from multiple sources:

```
1. Hard-coded instructions (constants/prompts.ts)
   └─ Role definition, code style, safety rules

2. User configuration
   ├─ CLAUDE.md files (project-level rules)
   ├─ Language preference (settings.json)
   └─ Output style preference (settings.json)

3. Runtime context
   ├─ Environment info (CWD, OS, model)
   ├─ Git status
   └─ MCP server connections

4. Memory system
   ├─ MEMORY.md (index)
   └─ Relevant memories (dynamically selected)

5. Tool descriptions
   └─ description() for each tool (dynamically generated)
```

### 6.2 CLAUDE.md Integration

CLAUDE.md is a project-level rules file whose content is injected into the system prompt:

```markdown
# CLAUDE.md Example
- Use pnpm instead of npm
- Use vitest for the testing framework
- Write commit messages in Chinese
```

Claude Code searches for CLAUDE.md in the current directory and its parent directories, merges them, and injects the result.

---

## 7. Agent Specialization

### 7.1 Prompt Differences Across Agents

Sub-agents use **different system prompts**, but share most of the static sections:

```
Main agent:
  [All sections] + [Full tool descriptions] + [MCP instructions]

Explore agent:
  [Base sections] + [Read-only tool descriptions] + [Exploration-specific instructions]

Plan agent:
  [Base sections] + [Read-only tool descriptions] + [Planning-specific instructions]
```

### 7.2 Proactive / KAIROS Path

Autonomous agents have an independent prompt assembly path:

```typescript
// constants/prompts.ts:466-489
if (isProactiveAgent()) {
  return [
    reminders, memory, envInfo, language,
    mcpInstructions, scratchpad, frc, summarization,
    getProactiveSection(),  // Autonomous behavior guidelines
  ]
}
```

---

## 8. Summary

Building Claude Code's system prompt is not a matter of "writing a prompt" — it is an **engineering system**:

1. **Modular** — 20+ sections managed independently, cacheable and clearable
2. **Cache-aware** — the dynamic boundary divides the prompt into cacheable and non-cacheable parts
3. **Multi-source merging** — 5 sources of information assembled dynamically
4. **Security layering** — code style, risk assessment, and prompt injection protection
5. **Adaptability** — content adjusted based on agent type, model capability, and runtime environment

The system prompt is the **source code** of Claude Code's behavior — if query.ts is the heart of the framework, then prompts.ts is its soul.
