import type { LocalCommandCall } from '../../types/command.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

function parseMode(raw: string): 'on' | 'off' | 'toggle' | null {
  const s = raw.trim().toLowerCase()
  if (s === '' || s === 'toggle') return 'toggle'
  if (s === 'on' || s === 'enable' || s === 'true' || s === '1') return 'on'
  if (s === 'off' || s === 'disable' || s === 'false' || s === '0') return 'off'
  return null
}

export const call: LocalCommandCall = async (args, context) => {
  const parsed = parseMode(args ?? '')
  if (parsed === null) {
    return {
      type: 'text',
      value: `Unknown argument "${args?.trim() ?? ''}". Use /focus, /focus on, or /focus off.`,
    }
  }

  // Upstream 2.1.121: focus view depends on the fullscreen renderer for the
  // transcript-filter overlay to actually show. When fullscreen is off,
  // toggling the flag silently does nothing — instead, explain how to
  // enable it. Mirrors the upstream "Fixed /focus showing 'Unknown command'
  // when the fullscreen renderer is off" entry.
  if (!isFullscreenEnvEnabled()) {
    return {
      type: 'text',
      value:
        'Focus view requires fullscreen rendering. Run /tui fullscreen (or set CLAUDE_CODE_NO_FLICKER=1 and restart) to enable it, then try /focus again.',
    }
  }

  let applied: boolean | null = null
  context.setAppState(prev => {
    const next =
      parsed === 'toggle' ? !prev.isFocusOnly : parsed === 'on'
    applied = next
    if (prev.isFocusOnly === next) return prev
    return { ...prev, isFocusOnly: next }
  })

  return {
    type: 'text',
    value: applied
      ? 'Focus view enabled. The transcript will only show assistant text. Tool calls remain in the full transcript (ctrl+o).'
      : 'Focus view disabled.',
  }
}
