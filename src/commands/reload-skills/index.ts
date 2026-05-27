/**
 * Reload-skills command — minimal metadata only.
 * Implementation is lazy-loaded from reload-skills.ts to reduce startup time.
 *
 * Upstream 2.1.152: re-scan skill directories without restarting the session.
 * Useful when a SessionStart hook (or the user) just dropped a new SKILL.md
 * into ~/.claude/skills/, a plugin's `skills/` folder, or a project's
 * `.claude/skills/`. After the cache is cleared the next slash-command
 * completion / autocomplete pass discovers the new entries.
 */
import type { Command } from '../../commands.js'

const reloadSkills = {
  type: 'local',
  name: 'reload-skills',
  description: 'Re-scan skill directories to pick up newly installed skills',
  aliases: ['reload-commands'],
  supportsNonInteractive: true,
  load: () => import('./reload-skills.js'),
} satisfies Command

export default reloadSkills
