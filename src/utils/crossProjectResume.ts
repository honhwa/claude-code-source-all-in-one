import { sep } from 'path'
import { getOriginalCwd } from '../bootstrap/state.js'
import type { LogOption } from '../types/logs.js'
import { quote } from './bash/shellQuote.js'
import { getPlatform } from './platform.js'
import { getSessionIdFromLog } from './sessionStorage.js'

export type CrossProjectResumeResult =
  | {
      isCrossProject: false
    }
  | {
      isCrossProject: true
      isSameRepoWorktree: true
      projectPath: string
    }
  | {
      isCrossProject: true
      isSameRepoWorktree: false
      command: string
      projectPath: string
    }

/**
 * Check if a log is from a different project directory and determine
 * whether it's a related worktree or a completely different project.
 *
 * For same-repo worktrees, we can resume directly without requiring cd.
 * For different projects, we generate the cd command.
 */
export function checkCrossProjectResume(
  log: LogOption,
  showAllProjects: boolean,
  worktreePaths: string[],
): CrossProjectResumeResult {
  const currentCwd = getOriginalCwd()

  if (!showAllProjects || !log.projectPath || log.projectPath === currentCwd) {
    return { isCrossProject: false }
  }

  // Check if log.projectPath is under a worktree of the same repo
  const isSameRepo = worktreePaths.some(
    wt => log.projectPath === wt || log.projectPath!.startsWith(wt + sep),
  )

  if (isSameRepo) {
    return {
      isCrossProject: true,
      isSameRepoWorktree: true,
      projectPath: log.projectPath,
    }
  }

  // Different repo - generate cd command.
  // Upstream 2.1.145: default Windows PowerShell 5.1 doesn't recognize `&&`
  // as a command separator (only PowerShell 7+ does, and only since 7.0).
  // Using `&&` on Windows makes the hint fail with a parse error. `;`
  // works in both PowerShell 5.1+ and cmd.exe; on POSIX shells `;` would
  // run the second command unconditionally even if cd fails — which is the
  // wrong semantic, so we keep `&&` there.
  const sessionId = getSessionIdFromLog(log)
  const separator = getPlatform() === 'windows' ? ';' : '&&'
  const command = `cd ${quote([log.projectPath])} ${separator} claude --resume ${sessionId}`
  return {
    isCrossProject: true,
    isSameRepoWorktree: false,
    command,
    projectPath: log.projectPath,
  }
}
