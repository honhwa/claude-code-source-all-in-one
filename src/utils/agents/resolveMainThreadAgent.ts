/**
 * Resolve the `--agent <name>` (or settings.agent) string against the loaded
 * agent set, with plugin-prefix fallback.
 *
 * Plugin agents are loaded with `agentType = "<plugin>:<namespace?>:<base>"`
 * (see loadPluginAgents.ts). Before 2.1.143 the CLI matched on agentType
 * exactly, so `--agent code-reviewer` missed `myplugin:code-reviewer` and
 * the user had to type the prefixed form. This helper:
 *
 *   1. Tries an exact `agentType === name` match (works for built-in,
 *      custom, and explicit plugin-qualified names).
 *   2. Falls back to a suffix match on the part after the last `:`.
 *      Only returns a match if it's unambiguous — if two plugins both
 *      contribute the same base name, the user must qualify with the
 *      `plugin:` prefix to disambiguate.
 *
 * Generic over the agent shape so it works for `AgentDefinition` and the
 * narrowed shapes used in main.tsx / print.ts.
 */
export function resolveMainThreadAgent<T extends { agentType: string }>(
  agents: readonly T[],
  name: string,
): T | undefined {
  const exact = agents.find(a => a.agentType === name)
  if (exact) return exact

  // Only fall through to suffix matching for bare names. If the caller
  // already typed a `:` (e.g. `plugin:agent`), the exact-match miss means
  // that specific plugin/agent pairing doesn't exist — don't paper over
  // it by matching some other plugin's same-named agent.
  if (name.includes(':')) return undefined

  const suffixMatches = agents.filter(a => {
    const idx = a.agentType.lastIndexOf(':')
    return idx >= 0 && a.agentType.slice(idx + 1) === name
  })
  return suffixMatches.length === 1 ? suffixMatches[0] : undefined
}
