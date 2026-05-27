/**
 * Centralized utilities for parsing slash commands
 */

export type ParsedSlashCommand = {
  commandName: string
  args: string
  isMcp: boolean
}

/**
 * Parses a slash command input string into its component parts
 *
 * @param input - The raw input string (should start with '/')
 * @returns Parsed command name, args, and MCP flag, or null if invalid
 *
 * @example
 * parseSlashCommand('/search foo bar')
 * // => { commandName: 'search', args: 'foo bar', isMcp: false }
 *
 * @example
 * parseSlashCommand('/mcp:tool (MCP) arg1 arg2')
 * // => { commandName: 'mcp:tool (MCP)', args: 'arg1 arg2', isMcp: true }
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmedInput = input.trim()

  // Check if input starts with '/'
  if (!trimmedInput.startsWith('/')) {
    return null
  }

  // Remove the leading '/' and split on ANY whitespace.
  // Upstream 2.1.147: previously split on a single ' ' character only, so a
  // command terminated by `\t` or `\n` (common when an autocomplete UI
  // inserts a trailing whitespace, or when a copy-paste includes one) was
  // parsed as the whole `<cmd>\t...` token and matched no registered
  // command. Splitting on `\s+` accepts any whitespace separator. The
  // (MCP) suffix detection still works — that's a literal-token check on
  // words[1], which is invariant under whitespace-class.
  const withoutSlash = trimmedInput.slice(1)
  const words = withoutSlash.split(/\s+/)

  if (!words[0]) {
    return null
  }

  let commandName = words[0]
  let isMcp = false
  let argsStartIndex = 1

  // Check for MCP commands (second word is '(MCP)')
  if (words.length > 1 && words[1] === '(MCP)') {
    commandName = commandName + ' (MCP)'
    isMcp = true
    argsStartIndex = 2
  }

  // Extract arguments (everything after command name). Re-join with a
  // single space — internal whitespace details inside the args body are
  // lost, but they were already lost by the original .split(' ').join(' ')
  // round-trip, so no regression vs. prior behavior for arg content.
  const args = words.slice(argsStartIndex).join(' ')

  return {
    commandName,
    args,
    isMcp,
  }
}
