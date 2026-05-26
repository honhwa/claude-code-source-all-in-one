import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getAPIProvider } from '../model/providers.js'
import { getPlatform } from '../platform.js'

export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

/**
 * Runtime gate for PowerShellTool. Windows-only (the permission engine uses
 * Win32-specific path normalizations). Defaults:
 *   - Ant users: on (opt-out via env=0)
 *   - Bedrock / Vertex / Foundry users on Windows: on (opt-out via env=0).
 *     Upstream 2.1.143 — the 3P/enterprise audience runs on Windows hosts
 *     where Bash is unavailable or significantly slower; they were the
 *     primary "why is there no Windows shell tool" complaint cohort.
 *   - Everyone else (1P consumer): off (opt-in via env=1)
 *
 * Used by tools.ts (tool-list visibility), processBashCommand (! routing),
 * and promptShellExecution (skill frontmatter routing) so the gate is
 * consistent across all paths that invoke PowerShellTool.call().
 */
export function isPowerShellToolEnabled(): boolean {
  if (getPlatform() !== 'windows') return false
  const isAnt = process.env.USER_TYPE === 'ant'
  const isThirdPartyProvider = getAPIProvider() !== 'firstParty'
  return isAnt || isThirdPartyProvider
    ? !isEnvDefinedFalsy(process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL)
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL)
}
