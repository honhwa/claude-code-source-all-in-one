# 05 - Deep Analysis of the Permission System: Security Is Not a Checkbox

---

## 1. Permission Modes Overview

### 1.1 External Modes

Permission modes available to users:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `default` | Prompts for confirmation on every sensitive operation | First-time use, sensitive projects |
| `acceptEdits` | Automatically accepts file edits; other operations still require confirmation | Day-to-day development |
| `plan` | Model outputs a plan first; execution begins only after human approval | Large-scale refactoring |
| `bypassPermissions` | Skips all permission checks | Trusted environments, CI/CD |
| `dontAsk` | No prompts, but also no automatic allow — requests are directly rejected | Automated scripts |

### 1.2 Internal Modes

Modes used internally by the framework:

| Mode | Trigger Condition | Behavior |
|------|-------------------|----------|
| `auto` | `TRANSCRIPT_CLASSIFIER` feature is enabled | Classifier approves automatically |
| `bubble` | Sub-agent needs a decision from the parent agent | Permission request bubbles up |

The `auto` mode is the most technically sophisticated — it uses a machine learning classifier to automatically determine whether a tool call is safe.

---

## 2. Permission Decision Chain

### 2.1 Full Decision Flow

The decision chain of `hasPermissionsToUseToolInner()` (permissions.ts:1158-1319):

```
Step 1a: Deny rule check
  └─ Tool is in the deny list? → {behavior: 'deny'}

Step 1b: Ask rule check
  └─ Tool has an ask rule? → {behavior: 'ask'}
  └─ Exception: Bash in sandbox is automatically allowed

Step 1c: Tool's own permission check
  └─ tool.checkPermissions(input, context)
  └─ Returns PermissionResult (allow/deny/ask/passthrough)

Step 2a: Bypass mode handling
  └─ bypassPermissions or plan mode? → {behavior: 'allow'}

Step 2b: Always-allow rule check
  └─ Tool is in the allow list? → {behavior: 'allow'}

Step 3: Passthrough → Ask conversion
  └─ tool returns passthrough → converted to {behavior: 'ask'}
```

### 2.2 Rule Source Hierarchy

Permission rules come from multiple sources with defined priorities:

```
Policy Limits (highest priority)
  └─ Mandatory rules set by organization administrators
  └─ Cannot be overridden by users

Managed Settings
  └─ Remotely managed configuration
  └─ Can be overridden by Policy Limits

Project Settings (.claude/settings.json)
  └─ Project-level rules
  └─ Can be overridden by higher layers

Global Config (~/.claude/settings.json)
  └─ User global configuration
  └─ Lowest priority
```

This hierarchical structure supports enterprise scenarios: administrators can use Policy Limits to forcibly prohibit certain operations (e.g., `rm -rf /`), and these cannot be bypassed even when the user has set `bypassPermissions`.

### 2.3 Tool's Own Permission Check

Each tool can implement the `checkPermissions` method to define its own permission logic:

```typescript
// In the tool definition
checkPermissions(input: ParsedInput, context: PermissionContext): PermissionResult {
  if (input.command.includes('sudo')) {
    return { type: 'ask', message: 'This command uses sudo' }
  }
  if (isReadOnlyCommand(input.command)) {
    return { type: 'allow' }
  }
  return { type: 'passthrough' }  // Let the framework decide
}
```

`passthrough` is a key return value — it means "the tool itself has no opinion; please handle this according to the user's permission mode." This allows tools to focus only on their own domain logic without needing to be aware of the global permission configuration.

---

## 3. Speculative Bash Classifier

### 3.1 Design Goal

In `auto` mode, users do not want a confirmation prompt for every Bash command, but they also do not want to skip security checks entirely.

The solution: use a **fast classifier** to determine whether a command is safe within 2 seconds.

### 3.2 Workflow

```
User enables auto mode
  │
  ├─ Model outputs a Bash tool call
  │
  ├─ Framework starts speculative classification (async)
  │     └─ Classifier analyzes command safety
  │
  ├─ Promise.race([classifier result, 2-second timeout])
  │     ├─ Classifier returns "safe" within 2s → automatically allowed
  │     ├─ Classifier returns "unsafe" within 2s → prompt for confirmation
  │     └─ 2s timeout → fall back to prompt for confirmation
  │
  └─ Classification decision is logged for analysis
```

### 3.3 Speculative Execution

The classifier is "speculative" — it begins running **before** the permission check. When `addTool()` is called (when a tool_use block arrives from the API stream), the classifier immediately starts analyzing. By the time `canUseTool()` is called, the classification result may already be ready.

```typescript
// At permission check time
const speculativeResult = peekSpeculativeClassifierCheck(command)
if (speculativeResult && speculativeResult.confidence > threshold) {
  // Classifier already has a result, use it directly
  return speculativeResult.decision
}
// Otherwise wait or show prompt
```

The effect of this design is that for most safe commands (`ls`, `cat`, `git status`), users experience no permission delay — the classifier starts working the moment the command arrives from the API stream, and is done by the time a permission decision is needed.

### 3.4 Dangerous Pattern Detection

Part of the classifier is pattern-based `dangerousPatterns` matching:

```typescript
// Typical dangerous patterns
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,           // rm -rf /
  /chmod\s+777/,              // open all permissions
  />\s*\/etc\//,              // write to system config
  /curl.*\|\s*sh/,            // download and execute
  /eval\s*\(/,                // eval execution
  // ...
]
```

These patterns provide the **first line of defense** — even if the classifier API is unavailable, these obviously dangerous commands will still be intercepted.

---

## 4. Permission Persistence

### 4.1 Propagation of "Always Allow"

When a user clicks "Always Allow", the decision needs to:

1. **Take effect immediately** — the same tool in the current turn no longer prompts
2. **Persist across turns** — the same tool in subsequent turns is automatically allowed
3. **Propagate across agents** — sub-agents also automatically allow it

This is achieved through the shared `AppState`:

```typescript
// Sub-agent's AppState routes to the root store
// User clicked "Always Allow" in a sub-agent's prompt
// → Updates the root store
// → Parent agent and all other sub-agents are immediately affected
```

### 4.2 Writing Permission Rules

"Always Allow" not only updates in-memory state — it also **persists** to the configuration file:

```
User clicks "Always Allow for Read"
  → Updates AppState (memory)
  → Writes to ~/.claude/settings.json (disk)
  → Automatically loaded the next time Claude Code starts
```

---

## 5. Sandbox Integration

### 5.1 When to Use Sandbox

Claude Code supports executing Bash commands inside a sandboxed environment (such as a Docker container or macOS sandbox). Commands inside a sandbox have a different permission policy:

```typescript
// Bash commands inside sandbox
if (shouldUseSandbox()) {
  // Sandbox provides isolation guarantees
  // → Permission requirements can be relaxed
  // → Some commands that normally require confirmation can be automatically allowed
}
```

### 5.2 Relationship Between Sandbox and Permissions

The sandbox and the permission system are **complementary**:

- The permission system is **intent control** — "Does this operation match the user's intent?"
- The sandbox is **impact control** — "Even if an operation goes wrong, it cannot harm the host system."

Inside a sandbox, the permission system can be more permissive, because even if there is a misjudgment (allowing an unsafe operation), the sandbox limits the blast radius.

---

## 6. Shell Rule Matching

### 6.1 Path Patterns

Permission rules can use path patterns to restrict the scope of a tool:

```json
// .claude/settings.json
{
  "permissions": {
    "allow": [
      "Edit:src/**",          // Allow editing files under the src directory
      "Bash:npm test",        // Allow running npm test
      "Bash:git *"            // Allow all git commands
    ],
    "deny": [
      "Bash:rm -rf *",        // Deny rm -rf
      "Edit:/etc/**"          // Deny editing system directories
    ]
  }
}
```

### 6.2 Shell Command Matching

For the Bash tool, rule matching needs to understand shell syntax:

```
Rule:    "Bash:npm *"
Command: "npm install express"      → match ✓
Command: "npm run test && echo ok"  → match ✓ (npm part matches)
Command: "npx create-react-app"     → no match ✗ (npx ≠ npm)
```

`shellRuleMatching.ts` implements this matching, and it needs to handle:
- Pipes (`|`)
- Chained commands (`&&`, `||`)
- Subshells (`$()`)
- Spaces inside quotes
- Environment variables

### 6.3 Shadowed Rule Detection

`shadowedRuleDetection.ts` detects rule conflicts — for example, an allow rule being "shadowed" by a higher-priority deny rule:

```
allow: "Bash:npm *"     ← this rule is shadowed
deny:  "Bash:*"         ← because this denies all Bash
```

When a shadowed rule is detected, a warning is issued to help users understand why an operation is still being denied.

---

## 7. Comparison With Other Systems

### 7.1 VS Code Extension Permissions

VS Code extensions use static declarations (`permissions` in `package.json`), granting authorization once at install time. Claude Code's permissions are **dynamic, runtime-based, and revocable**.

### 7.2 Docker-based Sandboxing

Some agent frameworks (e.g., E2B, Open Interpreter) use Docker containers as their sole security mechanism. Claude Code's approach is **layered** — the permission system plus an optional sandbox — providing finer-grained control.

### 7.3 Cursor/Windsurf Permissions

Cursor's permission model is relatively simple — "Accept" or "Reject" edits. Claude Code's permissions cover a much wider scope (file operations, Bash commands, network requests, sub-agents) and provide more control dimensions (modes, rules, path patterns, classifiers).

---

## 8. Summary

Claude Code's permission system reflects a key insight:

> **Security is not a binary choice (safe/unsafe), but a multi-dimensional trade-off (speed / safety / convenience / control).**

- `default` mode: most secure, slowest
- `auto` mode: balances security and speed (classifier + timeout fallback)
- `bypassPermissions` mode: fastest, least secure

Users can choose the right point on this spectrum based on their context. The framework ensures that even in the most permissive mode, the mandatory rules of Policy Limits still apply — this is the non-negotiable baseline for enterprise security.
