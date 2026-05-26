import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { isOverageProvisioningAllowed } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

function isExtraUsageAllowed(): boolean {
  if (isEnvTruthy(process.env.DISABLE_EXTRA_USAGE_COMMAND)) {
    return false
  }
  return isOverageProvisioningAllowed()
}

// Upstream 2.1.144: the user-facing surface is "usage credits" now; the
// previous "extra-usage" name stays as an alias so existing aliases, hooks,
// and muscle memory keep working. Aliases are accepted by the slash-command
// parser (commands.ts:695) and surfaced in /help (commands.ts:710), so
// `/extra-usage` continues to be discoverable as a recognized form.
export const extraUsage = {
  type: 'local-jsx',
  name: 'usage-credits',
  aliases: ['extra-usage'],
  description: 'Configure usage credits to keep working when limits are hit',
  isEnabled: () => isExtraUsageAllowed() && !getIsNonInteractiveSession(),
  load: () => import('./extra-usage.js'),
} satisfies Command

export const extraUsageNonInteractive = {
  type: 'local',
  name: 'usage-credits',
  aliases: ['extra-usage'],
  supportsNonInteractive: true,
  description: 'Configure usage credits to keep working when limits are hit',
  isEnabled: () => isExtraUsageAllowed() && getIsNonInteractiveSession(),
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('./extra-usage-noninteractive.js'),
} satisfies Command
