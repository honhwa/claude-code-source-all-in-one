import { clearCommandsCache } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

export const call: LocalCommandCall = async () => {
  // clearCommandsCache clears the memoize chain for commands AND skills
  // (it composes clearSkillCaches + clearPluginSkillsCache +
  // clearPluginCommandCache + clearCommandMemoizationCaches). The next
  // completion / slash-command lookup re-walks every skill directory
  // (~/.claude/skills/, project .claude/skills/, plugin skills/, bundled).
  clearCommandsCache()
  return {
    type: 'text',
    value: 'Reloaded skills — re-scanned skill directories.',
  }
}
