# Changelog

All notable changes tracked here. This is a local/educational source mirror of Claude Code, not an official release stream.

## 2.1.118 — April 23, 2026

Applies the user-facing, tractable subset of the upstream 2.1.118 changelog.

### Applied in this local source tree

- **Added `DISABLE_UPDATES` env var** — stricter than `DISABLE_AUTOUPDATER`: also blocks the manual `claude update` path, not just the background auto-update. Wired into `getAutoUpdaterDisabledReason()` (returned with `envVar: 'DISABLE_UPDATES'` so `/doctor` shows the right reason); new `areManualUpdatesDisabled()` helper for any future manual-update command to consult. Added to `SAFE_ENV_VARS` so managed deployments can set it without the dangerous-env-var dialog (`src/utils/config.ts`, `src/utils/managedEnvConstants.ts`).
- **Added `wslInheritsWindowsSettings` policy key** — when set true in managed-settings.json, a Claude Code session running inside WSL inherits managed settings from the Windows-side managed-settings.json. Lets a single Windows managed deployment cover both native Windows and WSL sessions (`src/utils/settings/types.ts`). Schema only — actual WSL-side merge is a Windows runtime detail not present in this mirror.
- **Hooks can now invoke MCP tools directly via `type: "mcp_tool"`** — added `McpToolHookSchema` (server, tool, optional arguments record, plus the standard `if`/`timeout`/`statusMessage`/`once` fields), wired into the `HookCommandSchema` discriminated union, exported `McpToolHook` type, and extended `hooksSettings.ts` switch cases (`hookCommandsAreEqual` + `getHookDisplayText`) so the new variant is identity-comparable and renders as `${server}.${tool}` in /hooks. The actual hook executor still routes only the existing variants — adding the dispatch path is a follow-up; this lands the schema and identity surface so settings.json validation accepts the new shape and unknown executor variants don't trip exhaustive-switch fallthroughs (`src/schemas/hooks.ts`, `src/utils/hooks/hooksSettings.ts`).
- **Auto mode: `"$defaults"` sentinel in `autoMode.allow` / `soft_deny` / `environment` keeps the built-in list alongside custom rules** — `buildYoloSystemPrompt()` now splits each user-supplied array into a `keepDefault` flag (true iff `"$defaults"` is present) and the user-rules tail. Built-in rules are included when the user provided no list (preserving prior default-on behavior) OR when `"$defaults"` is present; a non-empty list without the sentinel now REPLACES built-ins, matching upstream documented semantics. The sentinel itself is stripped before rules go into the prompt so it never surfaces as a literal entry. Schema descriptions updated to document the new contract (`src/utils/permissions/yoloClassifier.ts`, `src/utils/settings/types.ts`).
- **Bumped local source version to `2.1.118`** (from `2.1.117`) — `package.json` and `preload.ts` MACRO.

### Not applied (upstream-only or out of scope)

- Vim visual-mode `v` / visual-line `V` (selection, operators, visual feedback) — input/TUI rendering work in obfuscated Ink components.
- Merge `/cost` and `/stats` into `/usage` tabs while keeping both as typing shortcuts — `/cost` is a `local` text command, `/stats` and `/usage` are `local-jsx`; merging them as tabs requires turning `/cost` into a JSX component and reshaping the Settings tabs UI which sits in obfuscated source.
- Named custom themes via `/theme create`/`switch` + `~/.claude/themes/` JSON files + plugin `themes/` directory — theme system + plugin scaffold restructure beyond the local mirror's surface.
- Auto-mode "Don't ask again" opt-in checkbox — auto-mode dialog UI in obfuscated Ink source.
- `claude plugin tag` for creating plugin release git tags with version validation — plugin CLI subcommand outside this mirror.
- `--continue`/`--resume` finding sessions added via `/add-dir` — session-discovery internals.
- `/color` syncing accent color to claude.ai/code over Remote Control — bridge feature.
- `/model` picker honoring `ANTHROPIC_DEFAULT_*_MODEL_NAME`/`_DESCRIPTION` overrides under custom `ANTHROPIC_BASE_URL` gateways — model picker UI internals.
- Auto-update plugin-skip surfacing in `/doctor` and `/plugin Errors` tab — plugin subsystem internals.
- Various MCP OAuth fixes (headersHelper menu, custom-headers stuck "needs auth", missing `expires_in`, step-up `insufficient_scope` re-consent, OAuth flow timeout/cancel unhandled rejection, refresh cross-process lock, macOS keychain race, server-revoked tokens, `~/.claude/.credentials.json` corruption on Linux/Windows) — auth client/MCP OAuth internals in obfuscated source.
- `/login` in CLAUDE_CODE_OAUTH_TOKEN-launched session not clearing the env token — auth bootstrap path.
- Unreadable text in "new messages" scroll pill / `/plugin` badges — Ink color theme internals.
- Plan-acceptance dialog "auto mode" vs "bypass permissions" labelling under `--dangerously-skip-permissions` — dialog UI in obfuscated source.
- Agent-type hooks "Messages are required for agent hooks" failure on non-Stop events; prompt hooks re-firing on agent-hook verifier subagent tool calls — hook executor internals.
- `/fork` writing full parent conversation per fork (now pointer + hydrate) — session storage internals.
- `Alt+K` / `Alt+X` / `Alt+^` / `Alt+_` keyboard freezes — Ink keypress edge cases.
- Remote-session connect overwriting local model setting; typeahead "No commands match" on pasted slash file paths; plugin install dep wrong-version re-resolve; file-watcher ENOENT/EMFILE unhandled errors; CCR transient blip session archival; SendMessage subagent `cwd` restore — Remote/plugin/session internals.

---

## 2.1.117 — April 22, 2026

Applies the user-facing, tractable subset of the upstream 2.1.117 changelog.

### Applied in this local source tree

- **Allowlisted `CLAUDE_CODE_FORK_SUBAGENT` in `SAFE_ENV_VARS`** — upstream enables forked subagents on external builds via this env var; managed settings can now set it without tripping the dangerous-env-var dialog (`src/utils/managedEnvConstants.ts`).
- **Default effort on Opus 4.6 / Sonnet 4.6 for Pro/Max subscribers is now high** — removed the `isProSubscriber() → 'medium'` override in `getDefaultEffortForModel()`. Pro/Max now fall through to `undefined` (= high in the API) alongside every other user type; ultrathink branch and the ant-side overrides are unchanged (`src/utils/effort.ts`).
- **Extended `cleanupPeriodDays` retention sweep to `~/.claude/tasks/`, `~/.claude/shell-snapshots/`, `~/.claude/backups/`** — added a shared `cleanupOldTopLevelEntries(dirName)` helper (mirrors `cleanupOldSessionEnvDirs`'s mtime-vs-cutoff pattern, but tolerates both files and directories) and three thin wrappers wired into `cleanupOldMessageFilesInBackground()`. These buckets previously grew unbounded because they match session lifetime, not user retention policy (`src/utils/cleanup.ts`).
- **WebFetch truncates HTML before Turndown** — added `MAX_HTML_LENGTH = 2 MiB`. On multi-megabyte HTML pages Turndown's DOM build + tree walk could spin for tens of seconds; truncating before conversion yields more than `MAX_MARKDOWN_LENGTH` of markdown anyway, so the tail we drop was destined for the post-conversion cap (`src/tools/WebFetchTool/utils.ts`).
- **OTEL `user_prompt` events now carry `command_name` and `command_source` on slash-command paths** — both the unknown-command fallthrough and the new known-command emission in `processSlashCommand.tsx` include these attributes. `command_name` is redacted to the existing `'custom'`/`'mcp'` sanitized form unless `OTEL_LOG_TOOL_DETAILS=1`. `command_source` is one of `'builtin'`, `'custom'`, `'mcp'`, or `'unknown'`. Previously valid `/slash` invocations emitted no `user_prompt` event at all (`src/utils/processUserInput/processSlashCommand.tsx`).
- **Bumped local source version to `2.1.117`** (from `2.1.116`) — `package.json` and `preload.ts` MACRO.

### Not applied (upstream-only or out of scope)

- Forked-subagent dispatch for `--agent` main-thread sessions, agent-frontmatter `mcpServers` loading — subagent runner + agent-frontmatter parser live in obfuscated code.
- `/model` pin-source indicator ("from project" / "from managed-settings" label in startup header) and persist-across-restarts-even-when-project-pins-different — requires reworking the model pin resolution + header render.
- `/resume` stale-large-session summarize-before-read prompt — internal `/resume` UX path in obfuscated source.
- Concurrent local + claude.ai MCP connect on startup — MCP orchestrator in obfuscated init code.
- `plugin install` resolve missing dependencies on already-installed; `claude plugin marketplace add` dep auto-resolution; managed `blockedMarketplaces`/`strictKnownMarketplaces` enforcement on install/update/refresh/autoupdate — plugin subsystem internals.
- Advisor Tool experimental-label + learn-more link + startup notification; Advisor stuck-on-every-prompt fix — Advisor UI + result processor in obfuscated source.
- OTEL `cost.usage`/`token.usage`/`api_request`/`api_error` `effort` attribute — OTEL metric emission sites in obfuscated instrumentation.
- Native macOS/Linux builds replacing Glob/Grep with bfs/ugrep via Bash; Windows `where.exe` cache — distribution/packaging + platform-specific path, N/A for this local source mirror.
- Plain-CLI OAuth reactive token refresh on 401; `/login` when `CLAUDE_CODE_OAUTH_TOKEN` token expires — Anthropic auth client wrapper, obfuscated.
- Proxy HTTP 204 No Content clear-error — already safely handled in `src/bridge/bridgeApi.ts`; no user-facing TypeError path in this mirror.
- `NO_PROXY` respect under Bun, `gcpAuthRefresh` crash fix — proxy/client internals.
- SDK `reload_plugins` serial-reconnect → parallel fix; MCP `elicitation/create` auto-cancel on mid-turn connect; subagent model malware-warning false positive; idle-render loop on Linux — SDK/MCP/render internals in obfuscated source.
- Bedrock application-inference-profile 400 on Opus 4.7 with thinking disabled — Bedrock adapter plumbing not in scope.
- Prompt-input Ctrl+_ undo, Kitty-protocol key coalescing edges, VSCode "Manage Plugins" large-marketplace break — TUI/input and VSCode-panel bugs below our faithful-mirror line.
- Opus 4.7 `/context` percentage computing against 200K window instead of 1M — requires the per-model context-window table we don't mirror in full.

---

## 2.1.116 — April 20, 2026

Applies the user-facing, tractable subset of the upstream 2.1.116 changelog. Upstream skipped `2.1.114` and `2.1.115`.

### Applied in this local source tree

- **Sandbox auto-allow no longer bypasses the dangerous-path safety check for rm/rmdir** — when `autoAllowBashIfSandboxed` is on, `checkSandboxAutoAllow()` now runs `checkDangerousRemovalInCommand()` on every subcommand before returning `allow`. Any `rm`/`rmdir` targeting `/`, `$HOME`, `/etc`, `/usr` etc. produces an `ask` decision with a specific "Dangerous … operation on critical path" message, instead of being silently allowed because no deny rule matched. The new helper in `pathValidation.ts` reuses the existing `checkDangerousRemovalPaths()` internals and `stripSafeWrappers()` so commands like `timeout 10 rm -rf /` are also caught (`src/tools/BashTool/pathValidation.ts`, `src/tools/BashTool/bashPermissions.ts`).
- **Bumped local source version to `2.1.116`** (from `2.1.113`) — `package.json` and `preload.ts` MACRO.

### Not applied (upstream-only or out of scope)

- `/resume` speedup on large sessions and dead-fork-heavy sessions — internal parser/loader optimization in obfuscated session-reading code; no tractable local touchpoint.
- Faster MCP stdio startup + deferred `resources/templates/list` — MCP client startup orchestration lives in obfuscated init code; the deferred-list behavior would require reworking the MCP registration path.
- Smoother fullscreen scrolling in VS Code / Cursor / Windsurf (`/terminal-setup` writes editor scroll sensitivity) — terminal-setup is a hosted configuration command; editor-specific config writing not mirrored.
- Inline thinking-spinner progress ("still thinking", "thinking more", "almost done thinking") — Ink spinner rendering in obfuscated TUI source.
- `/config` search matching option values — obfuscated settings UI.
- `/doctor` opening while Claude is responding — requires reworking the in-flight-turn dialog gate.
- `/reload-plugins` and background plugin auto-update auto-installing missing marketplace deps — plugin-subsystem internals beyond the simplified mirror.
- Bash tool `gh` GitHub API rate-limit hint — adds a specific post-exec hint path in the Bash tool result formatter; cosmetic, not security-critical.
- Settings Usage tab 5-hour/weekly immediate + rate-limit-tolerant — Settings UI in obfuscated source; depends on the rate-limited Usage endpoint client.
- Agent frontmatter hooks firing for `--agent` main-thread agents — agent-frontmatter hook dispatch lives in obfuscated agent-runner code.
- Slash-command menu "No commands match" empty-state — Ink menu rendering in obfuscated TUI source.
- Devanagari/Indic column alignment, Ctrl+- undo under Kitty protocol, Cmd+Left/Right under Kitty protocol, Ctrl+Z hang under wrapper, inline-mode scrollback duplication, modal search overflow at short heights, VS Code integrated terminal scattered blank cells — terminal/TUI input and rendering bugs in obfuscated Ink source.
- API 400 cache-control TTL ordering fix on parallel request setup — lives in the Anthropic API client wrapper, obfuscated.
- `/branch` 50MB transcript reject, `/resume` empty-load silent-success, `/plugin` Installed tab deduplication, `/update` and `/tui` not working after worktree mid-session — command handlers in obfuscated source with no direct local hook.

---

## 2.1.113 — April 17, 2026

Applies the user-facing, tractable subset of the upstream 2.1.113 changelog.

### Applied in this local source tree

- **Added `sandbox.network.deniedDomains` setting** — lets users block specific domains even when a broader `allowedDomains` wildcard would otherwise permit them. Wired into `SandboxNetworkConfigSchema` alongside `allowedDomains`, and merged into the runtime `deniedDomains` list in `convertToSandboxRuntimeConfig()` from both `settings.sandbox.network.deniedDomains` and `policySettings.sandbox.network.deniedDomains`. Always applies regardless of managed-only mode, since deny rules take precedence over allow wildcards (`src/entrypoints/sandboxTypes.ts`, `src/utils/sandbox/sandbox-adapter.ts`).
- **Bumped local source version to `2.1.113`** (from `2.1.111`) — `package.json` and `preload.ts` MACRO. Upstream skipped `2.1.112`.

### Not applied (upstream-only or out of scope)

- Native Claude Code binary distribution via per-platform optional dependencies — distribution/packaging change, N/A for a local source mirror.
- Fullscreen Shift+↑/↓ scroll-when-extending-selection, Ctrl+A/Ctrl+E logical-line navigation, Windows Ctrl+Backspace word-delete, Cmd-backspace/Ctrl+U line-kill restore, prompt cursor visibility under `NO_COLOR`, slash/@ completion menu flush rendering — input/TUI rendering details that live in obfuscated Ink components beyond the faithful-mirror line.
- OSC 8 long-URL clickability across wrapped lines — terminal-specific rendering.
- `/loop` Esc cancel + "resuming /loop wakeup" label, `/extra-usage` from Remote Control, Remote Control @-file autocomplete, Remote Control subagent streaming, Remote Control session archiving, "Refine with Ultraplan" remote URL — Remote Control/cloud bridge features not present in this mirror.
- `/ultrareview` launch polish (parallelized checks, diffstat, animated launching) — cloud multi-agent feature.
- Subagent 10-minute stall timeout, MCP concurrent-call watchdog disarm fix, SDK image content block crash → text-placeholder degrade — subagent/SDK internals in obfuscated source.
- Bash tool multi-line comment UI-spoofing fix, Bash `dangerouslyDisableSandbox` permission-prompt fix, `cd <current-directory> && git …` no-op permission-prompt skip, macOS `/private/{etc,var,tmp,home}` dangerous-removal rules, Bash deny-rule matching under `env/sudo/watch/ionice/setsid` wrappers, `Bash(find:*)` not auto-approving `-exec`/`-delete` — security/permission-prompt fixes that live in Bash tool scaffolding not fully mirrored here.
- Markdown table rendering with pipes in inline code spans, `/copy` "Full response" table column alignment, session recap not auto-firing while composing, "copied N chars" toast overcount under emoji, `/insights` EBUSY on Windows, exit-confirmation one-shot-vs-recurring label fix — Ink/TUI + Windows-platform fixes below our faithful-mirror line.
- `CLAUDE_CODE_EXTRA_BODY` `output_config.effort` 400 error on subagent calls to effort-unsupported models and on Vertex AI — the effort-propagation path in our mirror is simpler; upstream fix modifies the extra-body merge in the CCR/Vertex adapter layer.
- `thinking.type.enabled` Bedrock Application Inference Profile ARN 400 error on Opus 4.7 — Bedrock adapter plumbing not in scope.
- ToolSearch ranking on pasted MCP tool names, compacting resumed long-context session "Extra usage required" fix, plugin install version-range conflict reporting, subagent transcript message misattribution, messages-typed-while-viewing-subagent hidden — internal flows in obfuscated source with no tractable local touchpoint.
- `/effort auto` confirmation wording ("Effort level set to max" to match status bar) — the upstream change requires threading the current model into `unsetEffortLevel()` and computing the displayed level there; mechanically small but speculative without the exact status-bar-label function, and cosmetic.

---

## 2.1.111 — April 16, 2026

Applies the user-facing, tractable subset of the upstream 2.1.111 changelog.

### Applied in this local source tree

- **Added `xhigh` effort level for Opus 4.7** — sits between `high` and `max`. Available via `/effort`, `--effort`, and the model picker cycle; other models downgrade to `high` at resolve time. `modelSupportsXHighEffort()` gates it to Opus 4.7 (`opus-4-7` substring match), mirroring the `modelSupportsMaxEffort()` Opus-4.6 gate. Surfaces updated: `EFFORT_LEVELS`, `EffortLevel` type, `toPersistableEffort`, `resolveAppliedEffort`, numeric→level conversion band (95→xhigh), `getEffortLevelDescription`; settings Zod enum; `--effort` CLI arg validator; `/effort` help text + argument hint + invalid-arg message; SDK `coreSchemas` (`supportedEffortLevels`, agent `effort`) + `controlSchemas` (`applied.effort`); `ModelPicker` cycle adds xhigh when `modelSupportsXHighEffort` is true, downgrade-on-display mirrors the max path (`src/utils/effort.ts`, `src/utils/settings/types.ts`, `src/main.tsx`, `src/commands/effort/{effort.tsx,index.ts}`, `src/entrypoints/sdk/{coreSchemas.ts,controlSchemas.ts}`, `src/components/ModelPicker.tsx`, `src/utils/frontmatterParser.ts`).
- **Added `OTEL_LOG_RAW_API_BODIES` and `CLAUDE_CODE_USE_POWERSHELL_TOOL` to `SAFE_ENV_VARS`** — supports the upstream 2.1.111 "emit full API request/response bodies as OTEL log events for debugging" toggle and the progressively-rolled-out Windows PowerShell tool opt-in/out (`src/utils/managedEnvConstants.ts`).
- **Added near-miss subcommand typo suggestion** — `claude udpate` now prints `Did you mean claude update?` before falling through to the default prompt action. Implemented as a pre-parse check in `run()` since the default command accepts a positional prompt (commander wouldn't flag the typo as an unknown command). Uses Damerau-Levenshtein edit distance with a length-scaled threshold (1 for ≤4 chars, 2 otherwise), and only triggers on a single bare positional — multi-word prompts are left alone (`src/main.tsx`).
- **Plan files named after the user's prompt** — added `buildPromptPlanSlugPrefix()` (kebab-case, strip URLs/slash-commands, ≤4 words / ≤40 chars) and a session-keyed prompt-hint map. `handlePromptSubmit` registers the hint on the first user message; `getPlanSlug()` uses it as a prefix and appends a random word suffix for uniqueness (e.g. `fix-auth-race-snug-otter.md`). Purely-random slugs remain the fallback when no hint is registered (`src/utils/plans.ts`, `src/utils/handlePromptSubmit.ts`).
- **Enabled commander `showSuggestionAfterError(true)`** — explicit opt-in so unknown subcommand and option typos inside command groups (`claude mcp lsit`) get the built-in "(Did you mean …?)" hint (`src/main.tsx`).
- **Bumped local source version to `2.1.111`** (from `2.1.110`) — `package.json` and `preload.ts` MACRO.

### Not applied (upstream-only or out of scope)

- Auto mode no longer requiring `--enable-auto-mode` — the flag is gated behind `feature('TRANSCRIPT_CLASSIFIER')`, which is stubbed to false in this mirror, so the flag is effectively unreachable here already; the upstream change also removes the persistent opt-in dialog gate, which lives in setup screens we don't fully mirror.
- Auto mode availability for Max subscribers on Opus 4.7 — GrowthBook-gated; not a code change in our mirror.
- `/effort` interactive slider (arrow-key selector) when called without arguments — the command-scaffold change is UI-only and would require a new `LocalJSXCommand` picker component.
- `/ultrareview` cloud multi-agent code review command — cloud infra, CCR-side.
- "Auto (match terminal)" theme option — terminal-introspection plumbing (dark/light detection) not present in this mirror.
- `/less-permission-prompts` skill — already surfaced via the skills registry (listed in the skills reminder); no local scaffolding needed.
- `/skills` menu token-count sort (`t` toggle), transcript view shortcuts (`[`, `v`), full-width truncation rule, `/effort` interactive slider, `+N lines` rule change — all Ink/TUI rendering polish below the faithful-mirror line.
- PowerShell tool progressive rollout on Windows — the env var is now safe-env; the tool's Windows-specific rollout code is not mirrored.
- Read-only bash commands with glob patterns / `cd <project-dir> &&` prefix permission skip — requires extending the read-only classifier in `readOnlyCommandValidation.ts`; upstream change is nontrivial and security-sensitive.
- Plugin error propagation on headless init event, plugin dependency error distinction (conflicting/invalid/overly-complex version requirements), plugin update stale-version / interrupted-install recovery — plugin-subsystem internals beyond the simplified mirror.
- Reverted v2.1.110 non-streaming fallback retry cap — the cap was never applied in our mirror, so nothing to revert.
- `/setup-vertex` and `/setup-bedrock` improvements (show actual settings.json path when `CLAUDE_CONFIG_DIR` is set, seed candidates from existing pins, offer "with 1M context") — setup-command internals; local command scaffolds are minimal.
- Ctrl+U / Ctrl+Y / Ctrl+L keybinding semantics, iTerm2+tmux display tearing, `@` file suggestions scanning non-git directories, LSP diagnostic ordering, `/resume` tab-completion bypassing picker, `/context` grid blank lines, `/clear` dropping session_name, `/rename` persistence, feedback survey back-to-back dismissal, bare-URL wrapping clickability, Windows env-file propagation, Windows drive-letter permission path normalization — terminal/TUI/platform-specific patches below our faithful-mirror line.
- OTEL trace for 429 referencing the wrong status page on Bedrock/Vertex/Foundry, `Unknown skill: commit` misroute, plugin install recovery — internal fixes without a direct local touchpoint in this mirror.

---

## 2.1.110 — April 15, 2026

Applies the user-facing, tractable subset of the upstream 2.1.110 changelog.

### Applied in this local source tree

- **Added `/tui` command + `tui` setting** — switches the Ink renderer between `default` and `fullscreen` (alt-screen) rendering without restarting. The `/tui` command persists the choice via `updateSettingsForSource('userSettings', { tui })`, and `isFullscreenEnvEnabled()` now reads the setting after the env var precedence chain (`src/commands/tui/`, `src/utils/fullscreen.ts`, `src/utils/settings/types.ts`).
- **Added `/focus` command** — toggles the new `isFocusOnly` flag on `AppState`, decoupling focus view from the `ctrl+o` verbose-transcript toggle (`src/commands/focus/`, `src/state/AppStateStore.ts`). Transcript filtering wiring is intentionally deferred; this is the upstream command surface.
- **Added `PushNotificationTool` scaffolding** — full tool definition (inputs, prompt, UI render, `isEnabled` gated on `pushNotifications.enabled && pushWhenClaudeDecides` in settings) so the `require('./tools/PushNotificationTool/PushNotificationTool.js')` in `tools.ts` has a real target. Delivery is a logged stub — real delivery requires the Remote Control bridge, which is CCR-side.
- **Added `autoScrollEnabled`, `tui`, `pushNotifications`, and `showLastResponseInExternalEditor` to `SettingsSchema`** — surfacing the new 2.1.110 toggles via `/config` and managed settings (`src/utils/settings/types.ts`).
- **Bash tool now enforces the documented maximum timeout** — `BashTool.tsx` was using `timeout || getDefaultTimeoutMs()` without clamping, so a model-supplied `timeout` above `BASH_MAX_TIMEOUT_MS` slipped through and contradicted the tool's own prompt ("up to ${getMaxTimeoutMs()}ms"). Now `Math.min(...)` with `getMaxTimeoutMs()`, aligning with the PowerShellTool behavior (`src/tools/BashTool/BashTool.tsx`).
- **Added `TRACEPARENT` and `TRACESTATE` to `SAFE_ENV_VARS`** — so SDK/headless sessions launched via managed env propagation can join an existing distributed trace (`src/utils/managedEnvConstants.ts`).
- **Added `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` opt-out env var** — `useAwaySummary` now short-circuits if the env var is falsy, bypasses GrowthBook if truthy (needed for telemetry-disabled users: Bedrock/Vertex/Foundry/`DISABLE_TELEMETRY`), and otherwise falls back to the existing GB gate. Env var is also now in `SAFE_ENV_VARS` so managed settings can set it (`src/hooks/useAwaySummary.ts`, `src/utils/managedEnvConstants.ts`).
- **Bumped local source version to `2.1.110`** (from `2.1.101`) — `package.json` and `preload.ts` MACRO.

### Not applied (upstream-only or out of scope)

- Remote Control message routing for `/context`, `/exit`, `/reload-plugins` (bridge is CCR-side, already stubbed locally).
- `--resume` / `--continue` resurrecting unexpired scheduled tasks — requires the CronCreate/scheduler persistence path we don't mirror.
- Write-tool IDE-diff "user edited content" notification — requires VSCode IDE extension diff-proposal plumbing not faithfully present in this source tree.
- `/doctor` duplicate-MCP-endpoint warning, `/plugin` Installed-tab pin/fold reordering, f-to-favorite, dependency-install listing.
- Ctrl+G external-editor "include last response as comment" option (UI plumbing for Ctrl+G editor round-trip).
- Rendering/focus/flicker/keystroke-drop/`/resume` title/session-cleanup/synchronized-output/ink-wide-line fixes — terminal-level patches below our faithful-mirror line.
- PermissionRequest hook `updatedInput` re-check against `permissions.deny` / `setMode:'bypassPermissions'` respect — upstream hook-engine fix, not surfaced in this mirror's simplified hook layer.
- `PreToolUse` hook `additionalContext` preservation on tool-call failure; `stdio` MCP stray-stdout tolerance; headless auto-title suppression under `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; "Open in editor" untrusted-filename hardening — internal fixes without a direct local touchpoint.
- `--resume`/`--continue` auto-retitle-vs-prompt display precedence; queued-message double-render; Remote Control re-login prompt / rename-persistence; session-subdirectory cleanup — Remote/session-manager internals.

---

## 2.1.101 — April 10, 2026

### Applied
- **Fixed command injection vulnerability in POSIX `which` / Windows `where.exe` fallback** — `whichNodeAsync` and `whichNodeSync` passed the command name through a shell string unsanitized; now uses `execa` array-args (no shell) for async, and quotes/escapes for sync (`src/utils/which.ts`)
- **Fixed `permissions.deny` rules not overriding a PreToolUse hook's `permissionDecision: 'ask'`** — when a hook returned 'ask', the `forceDecision` path bypassed `hasPermissionsToUseTool` entirely, skipping deny-rule checks; now deny rules are checked before the forceDecision passthrough (`src/services/tools/toolHooks.ts`)
- **Added `CLAUDE_CODE_CERT_STORE` to `SAFE_ENV_VARS`** — supports the upstream OS CA certificate store trust feature; set to `bundled` to use only bundled CAs (`src/utils/managedEnvConstants.ts`)
- **Improved settings resilience: unrecognized hook event names no longer cause the entire settings file to be rejected** — `HooksSchema` now accepts any string key and silently strips unknown events during parsing (`src/schemas/hooks.ts`)

### Not applied (upstream-only)
Skipped: `/team-onboarding` command, OS CA cert auto-trust plumbing beyond env var, `/ultraplan` auto-create cloud env, brief mode structured retry, focus mode self-contained summaries, tool-not-available error messages, rate-limit retry messages, refusal error messages, `--resume` session title support, plugin hooks with `allowManagedHooksOnly`, `/plugin update` marketplace warning, plan mode Ultraplan visibility, OTEL tracing opt-in fields, SDK `query()` cleanup, memory leak in virtual scroller, `--resume`/`--continue` recovery fixes, hardcoded 5-minute timeout (already 600s in our source), `--setting-sources` cleanup period, Bedrock SigV4 auth header conflict, worktree stale directory, subagent MCP/worktree access, sandbox `mktemp`, MCP serve `outputSchema`, RemoteTrigger empty body, `/resume` picker fixes, Grep ENOENT fallback, `/btw` disk write, `/context` breakdown, plugin slash-command/cache/context fixes, `/mcp` OAuth menu, keybinding C0 bytes, `/login` OAuth URL, rendering/flicker fixes, in-app settings refresh, `--continue -p`, Remote Control fixes, `/insights` link, VSCode file-attachment clear.

---

## 2.1.96 — April 8, 2026

Version-only bump. The single upstream fix (Bedrock 403 "Authorization header is missing" regression with `AWS_BEARER_TOKEN_BEDROCK` / `CLAUDE_CODE_SKIP_BEDROCK_AUTH`) does not affect this source tree — we did not touch Bedrock auth code in our 2.1.94 sync.

---

## 2.1.94 — April 7, 2026

Applies the user-facing, tractable subset of the upstream 2.1.94 changelog.

### Applied in this local source tree

- Changed default effort level from `medium` to `high` (i.e. `undefined` in the API) for API-key, Bedrock/Vertex/Foundry, Team, and Enterprise users on Opus 4.6. Pro subscribers remain at `medium`.
- Added `sessionTitle` field to `UserPromptSubmit` hook specific output, allowing hooks to set the session title.
- `--resume` now resumes sessions from other worktrees of the same repo directly for all users (previously gated to internal users only).
- Fixed CJK and other multibyte text being corrupted with U+FFFD in `stream-json` stdout guard when chunk boundaries split a UTF-8 sequence — now uses `TextDecoder` with streaming mode.
- Added `FORCE_HYPERLINK` environment variable support in terminal hyperlink detection, so setting it via `settings.json` env is respected.
- Plugin skills declared via `"skills": ["./"]` now use the skill's frontmatter `name` for the invocation name instead of the directory basename, giving a stable name across install methods.

### Not applied (upstream-only internal fixes)

- `CLAUDE_CODE_USE_MANTLE` Bedrock Mantle provider support
- Slack MCP compact `#channel` header with clickable link
- `keep-coding-instructions` frontmatter field for plugin output styles
- 429 rate-limit Retry-After agent stuck fix
- Console login macOS keychain locked/out-of-sync fix
- Plugin hooks YAML frontmatter / `CLAUDE_PLUGIN_ROOT` resolution fixes
- SDK/print mode partial assistant response preservation on interrupt
- Scrollback repeated diff / blank pages in long sessions
- Multiline prompt indentation under `❯` caret
- Shift+Space inserting literal "space" in search inputs
- Hyperlinks opening two browser tabs in tmux + xterm.js terminals
- Alt-screen ghost lines from content height changes mid-scroll
- Native terminal cursor not tracking selected tab in dialogs
- Bedrock Sonnet 3.5 v2 inference profile ID fix
- VSCode cold-open subprocess reduction, dropdown menu fix, settings.json parse warning banner

---

## 2.1.92 — April 4, 2026

Applies the user-facing, tractable subset of the upstream 2.1.92 changelog.

### Applied in this local source tree

- Added `forceRemoteSettingsRefresh` policy setting: when true in managed/policy settings, the CLI blocks startup until remote managed settings are freshly fetched and exits fail-closed if the fetch fails. Useful for managed deployments where stale cached policy is unacceptable.
- Remote Control session names now use the machine hostname as the default prefix (e.g. `myhost-graceful-unicorn`) instead of the hardcoded `remote-control-` prefix. Overridable via the `CLAUDE_CODE_REMOTE_CONTROL_SESSION_NAME_PREFIX` environment variable.
- Removed `/tag` command (sessions are still tagged via session metadata but the interactive slash command is gone).
- Removed `/vim` command (toggle vim mode via `/config` → Editor mode instead).
- Bumped local source version to `2.1.92` (from `2.1.91`).

### Not applied (upstream-only internal fixes)

Skipped items that require forensic access to internals not faithfully present in the deobfuscated source, or are platform-specific infra fixes:

- Interactive Bedrock setup wizard from the login screen
- `/cost` per-model + cache-hit breakdown for subscription users
- `/release-notes` interactive version picker
- Pro-user prompt-cache-expired footer hint
- Subagent spawning tmux pane-count failure after window kills/renumbers
- Prompt-type Stop hooks with `ok:false` from small fast model, `preventContinuation:true` semantics
- Tool input validation for streamed JSON-encoded array/object fields
- API 400 on whitespace-only thinking text blocks
- Accidental feedback-survey submissions from auto-pilot keypresses
- Misleading "esc to interrupt" hint alongside "esc to clear" with selection active
- Homebrew update prompts (stable vs @latest channel)
- `ctrl+e` jumping past end-of-line in multiline prompts
- Duplicate message at two scroll positions (DEC 2026 terminals: iTerm2, Ghostty)
- Idle-return `/clear to save X tokens` showing cumulative instead of current-context tokens
- Plugin MCP servers stuck "connecting" when duplicating an unauthenticated claude.ai connector
- Write tool diff-computation 60% speedup for large files with tabs/`&`/`$`
- Linux sandbox `apply-seccomp` helper in npm + native builds (unix-socket blocking)

---

## 2.1.91 — April 2, 2026

Applies the user-facing, tractable subset of the upstream 2.1.90 and 2.1.91 changelogs in a single bump.

### Applied in this local source tree

From upstream 2.1.90:

- Added `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE`: when set, a failed `git pull` during marketplace refresh keeps the existing cache instead of wiping and re-cloning. Useful for offline/restricted environments.
- Added `.husky` to the protected-directories list for `acceptEdits` mode (same protection as `.git`, `.vscode`, `.idea`, `.claude`).
- Removed `Get-DnsClientCache` cmdlet and `ipconfig /displaydns` flag from the PowerShell tool's auto-allow list (DNS cache privacy). Users who need these can add an explicit allow rule.
- `/resume` picker now filters out sessions created by `claude -p` or SDK transports (`sdk-cli`, `sdk-ts`, `sdk-py`) based on the session's stored `entrypoint`.

From upstream 2.1.91:

- MCP tool-result persistence override via `_meta["anthropic/maxResultSizeChars"]`: servers can annotate individual tools (e.g. DB-schema inspectors) to allow results up to **500K** characters to pass through without being persisted to a preview file.
- Added `disableSkillShellExecution` setting to disable inline shell execution (```! blocks and `!\`…\`` inline) in skills, custom slash commands, and plugin commands.
- `claude-cli://open?q=` deep links now accept URL-encoded newlines (`%0A` / `%0D`) for multi-line prompts. cmd.exe and AppleScript escape boundaries were updated to handle newlines safely (cmd.exe strips LF/CR to a space, AppleScript escapes to `\n`/`\r`).
- `/feedback` (and its alias `/bug`) stays visible in the slash menu when disabled; invoking it now prints an explanation (third-party provider, env var, policy, etc.) instead of silently disappearing.
- Bumped local source version to `2.1.91` (from `2.1.89`).

### Not applied (upstream-only internal fixes)

Skipped items that require forensic access to internals not faithfully present in the deobfuscated source, or are platform-specific infra fixes:

- `/powerup` interactive lessons
- Rate-limit dialog auto-reopen loop
- `--resume` prompt-cache miss regression (v2.1.69+)
- Edit/Write race with PostToolUse format-on-save hooks
- PreToolUse hooks emitting JSON to stdout + exit code 2 not blocking
- Collapsed search/read summary duplicated in scrollback on CLAUDE.md auto-load
- Auto-mode boundary honor-ing ("don't push", "wait for X")
- Click-to-expand hover colors on light terminal themes
- UI crash on malformed tool input, header disappearance on scroll, PowerShell tool hardening (trailing `&`, `-ErrorAction Break`, archive TOCTOU, parse-fail fallback)
- JSON.stringify MCP schema per turn, SSE linear-time streaming, long-session transcript write quadratic, /resume all-projects parallel load
- Transcript chain breaks on `--resume` with silent write failures
- `cmd+delete` on iTerm2/kitty/WezTerm/Ghostty/Windows Terminal
- Plan mode container restart recovery, `permissions.defaultMode: "auto"` JSON-schema validation, Windows version cleanup protecting rollback copy
- Improved `/claude-api` skill guidance content, Bun.stripANSI perf, shorter `old_string` anchors in Edit tool output
- Plugins shipping executables under `bin/` (requires plugin-system changes beyond this pass)

See upstream Anthropic Claude Code 2.1.90 / 2.1.91 release notes for full details.

## 2.1.89 — April 1, 2026

This release applies the **user-facing, tractable subset** of the upstream 2.1.89 changelog. See "Applied" and "Not applied (upstream-only)" sections below.

### Applied in this local source tree

- Added `CLAUDE_CODE_NO_FLICKER=1` environment variable (read at startup; wired through to the renderer as a feature flag).
- Added `MCP_CONNECTION_NONBLOCKING=true` for `-p` mode to skip the MCP connection wait entirely; bounded `--mcp-config` server connections at 5s at bootstrap time.
- Added `"defer"` permission decision to `PermissionBehavior` and a `PermissionDeferDecision` type (for headless `-p --resume` pause/re-evaluate semantics).
- Added `showThinkingSummaries` setting (defaults to `false` — opt-in to restore thinking summaries in interactive sessions).
- Rejected `cleanupPeriodDays: 0` in settings validation with an actionable error message.
- Fixed `Edit`/`Write` tools doubling CRLF on Windows and stripping Markdown hard line breaks (two trailing spaces).
- Improved collapsed tool summary to show "Listed N directories" for `ls`/`tree`/`du` instead of "Read N files".
- Improved `@`-mention typeahead to rank source files above MCP resources and include named subagents.
- Image paste no longer inserts a trailing space.
- Preserved task notifications when backgrounding a running command with Ctrl+B.
- `/usage` now hides the redundant "Current week (Sonnet only)" bar for Pro and Enterprise plans.
- `PreToolUse`/`PostToolUse` hooks now receive `file_path` as an absolute path for `Write`/`Edit`/`Read` tools.
- Bumped local source version to `2.1.89` (from `2.1.88`).

### Not applied (upstream-only internal fixes)

These items from the upstream changelog require forensic access to internals not faithfully present in the deobfuscated source, or are platform-specific infra fixes:

- Prompt-cache byte-level fixes, tool-schema cache bytes mid-session
- LSP server zombie-state restart
- Memory leak from large-JSON LRU cache keys
- Crash removing message from >50MB session files, out-of-memory on Edit of >1GiB files
- `~/.claude/history.jsonl` 4KB CJK/emoji boundary truncation
- Devanagari combining-mark truncation, iTerm2/tmux streaming jitter, main-screen render artifacts
- macOS `claude-cli://` deep-link handling, Apple-Silicon voice mic perms
- Shift+Enter on Windows Terminal Preview 1.25, PowerShell 5.1 stderr-progress misclassification
- Autocompact thrash loop detection, nested CLAUDE.md re-injection, prompt cache misses in long sessions
- Several smaller rendering/notification/prompt-history infra fixes
- `/buddy` April Fool's command (explicitly skipped per user)

See upstream Anthropic Claude Code 2.1.89 release notes for full details.
