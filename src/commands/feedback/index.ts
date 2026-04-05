import type { Command } from '../../commands.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'

/**
 * Returns a human-readable reason if /feedback is unavailable, or null if
 * the command can run. Previously `isEnabled()` returned false for any of
 * these conditions, which made the command vanish from the slash-menu
 * with no explanation. Now the command is always enabled and the call
 * site shows this reason when the user invokes it. (v2.1.91)
 */
export function getFeedbackUnavailableReason(): string | null {
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  ) {
    return '/feedback is not available for third-party providers (Bedrock/Vertex/Foundry). Please submit feedback through your provider.'
  }
  if (isEnvTruthy(process.env.DISABLE_FEEDBACK_COMMAND) || isEnvTruthy(process.env.DISABLE_BUG_COMMAND)) {
    return '/feedback is disabled by environment variable (DISABLE_FEEDBACK_COMMAND / DISABLE_BUG_COMMAND).'
  }
  if (isEssentialTrafficOnly()) {
    return '/feedback is disabled because CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set.'
  }
  if (process.env.USER_TYPE === 'ant') {
    return '/feedback is not available for internal Anthropic builds. Use the internal bug tracker instead.'
  }
  if (!isPolicyAllowed('allow_product_feedback')) {
    return '/feedback is disabled by your organization policy (allow_product_feedback=false).'
  }
  return null
}

const feedback = {
  aliases: ['bug'],
  type: 'local-jsx',
  name: 'feedback',
  description: `Submit feedback about Claude Code`,
  argumentHint: '[report]',
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback
