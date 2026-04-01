# 12 - Deep Analysis of MCP Integration: The Core of Extensibility

---

## 1. What Is MCP

Model Context Protocol (MCP) is an open protocol proposed by Anthropic that allows AI applications to connect to external tool servers. Claude Code uses MCP to support unlimited tool extensions — database queries, GitHub operations, Slack messages, custom enterprise tools, and more.

MCP's role in Claude Code: **it is the only tool source that is not subject to agent tool-filtering restrictions.** Regardless of whether it is the Explore agent (read-only) or the Plan agent (read-only), MCP tools are always available.

---

## 2. Architecture Overview

```
Claude Code
  │
  ├─ MCP Client (services/mcp/client.ts, 3348 lines)
  │   ├─ connectToServer()        // Connection management (memoized)
  │   ├─ fetchToolsForClient()    // Tool discovery (LRU cache)
  │   └─ callMCPTool()            // Tool invocation
  │
  ├─ Transport Layer
  │   ├─ StdioClientTransport     // Subprocess MCP server
  │   ├─ SSEClientTransport       // Server-Sent Events
  │   ├─ StreamableHTTPTransport  // HTTP streaming
  │   ├─ WebSocketTransport       // WebSocket
  │   ├─ InProcessTransport       // In-process (Bun SDK)
  │   └─ SdkControlTransport      // CLI ↔ SDK bridge
  │
  ├─ Auth Layer
  │   ├─ OAuth (services/oauth/)  // Standard OAuth flow
  │   └─ XAA/IDP                  // Enterprise identity federation
  │
  └─ Permission Layer
      ├─ channelAllowlist.ts      // Server allowlist
      └─ channelPermissions.ts    // Structured permission requests
```

---

## 3. Connection Management: connectToServer()

### 3.1 Memoized Connection Factory

```typescript
// services/mcp/client.ts:595
export const connectToServer = memoize(
  async (name: string, serverRef: McpServerRef) => {
    // 1. Select transport
    const transport = selectTransport(serverRef)
    
    // 2. Configure authentication
    const authProvider = createAuthProvider(serverRef)
    
    // 3. Establish connection
    const client = new Client({ transport, auth: authProvider })
    await client.connect()
    
    return client
  },
  (name, ref) => `${name}:${JSON.stringify(ref)}`  // Cache key
)
```

`memoize` ensures that only one connection is established per server. The cache key is a combination of `name:serverRef` — if the configuration changes (e.g., the port changes), a new connection is created.

### 3.2 Transport Selection

The transport is selected based on the type of `serverRef`:

| Configuration Type | Transport | Use Case |
|-------------------|-----------|----------|
| `command` + `args` | StdioClientTransport | Local subprocess (e.g., `npx @mcp/server-postgres`) |
| `url` (http/https) | SSEClientTransport or StreamableHTTP | Remote HTTP server |
| `url` (ws/wss) | WebSocketTransport | WebSocket server |
| Internal flag | InProcessTransport | Bun SDK embedded server |
| SDK bridge | SdkControlTransport | MCP in VS Code extension |

### 3.3 InProcessTransport: Zero Network Overhead

```typescript
// services/mcp/InProcessTransport.ts (64 lines)
// Create a pair of linked transports
const [clientTransport, serverTransport] = createLinkedPair()

// Messages are passed via microtask to avoid deep call stacks
queueMicrotask(() => {
  otherTransport.onmessage?.(message)
})
```

`InProcessTransport` is used for MCP servers embedded within Claude Code itself. Messages are passed directly in memory, using `queueMicrotask` rather than synchronous calls — to prevent deep recursion (MCP messages may trigger further MCP calls).

---

## 4. Tool Discovery and Registration

### 4.1 Tool Enumeration

```typescript
// services/mcp/client.ts:1743
export const fetchToolsForClient = lruCache(
  async (client: McpClient) => {
    const response = await client.request('tools/list')
    return response.tools.map(tool => createMcpToolAdapter(tool))
  },
  { maxSize: 12 }  // LRU cache for tool lists of up to 12 servers
)
```

### 4.2 Tool Name Mapping

MCP tools use fully qualified names within Claude Code:

```
MCP server: "postgres"
MCP tool:   "query"
Fully qualified name: "mcp__postgres__query"
```

This prefix ensures MCP tools and built-in tools do not have naming conflicts.

### 4.3 Tool Metadata

MCP tools can carry metadata hints:

```typescript
{
  destructiveHint: true,    // Destructive operation (e.g., DELETE statement)
  readOnlyHint: true,       // Read-only operation
  openWorldHint: true,      // May access external resources
  searchHint: "database queries",  // ToolSearch match text
  alwaysLoad: true,         // Not lazy-loaded; always present in prompt
}
```

These hints affect permission checks and tool orchestration — tools with `readOnlyHint: true` can participate in concurrent batches.

---

## 5. Tool Invocation Flow

### 5.1 Standard Invocation

```
Model outputs tool_use: mcp__postgres__query
  │
  ├─ findToolByName() → identified as MCP tool
  ├─ canUseTool() → permission check
  │   ├─ channelAllowlist check
  │   └─ user confirmation (if required)
  ├─ client.request('tools/call', { name: 'query', arguments: {...} })
  │   └─ sent to MCP server via transport
  ├─ receive result
  │   ├─ content truncation check (mcpContentNeedsTruncation)
  │   └─ format as tool_result
  └─ yield result to main loop
```

### 5.2 URL Elicitation

Some MCP tools require the user to provide a URL (e.g., OAuth callback):

```typescript
// services/mcp/client.ts:2813+
async function callMCPToolWithUrlElicitationRetry(client, tool, args) {
  const result = await client.request('tools/call', { name: tool, arguments: args })
  
  if (result.requiresUrl) {
    // Prompt the user to provide a URL
    const url = await askUserForUrl(result.urlPrompt)
    // Retry with the URL
    return client.request('tools/call', { name: tool, arguments: { ...args, url } })
  }
  
  return result
}
```

### 5.3 Structured Permission Requests

MCP servers can request structured approvals via channel permissions:

```
MCP server → sends permission request (with 5-character ID)
  → Claude Code UI displays the request
    → user replies "yes abc12" or "no abc12"
      → matches ID, returns decision to MCP server
```

There is an interesting detail about ID generation — it **filters out profanity**, to avoid randomly generated IDs that happen to be offensive words.

---

## 6. Authentication System

### 6.1 OAuth Flow

```
User connects to an MCP server that requires authentication
  │
  ├─ OIDC Discovery → retrieve authorization_endpoint
  ├─ PKCE generation → code_verifier + code_challenge
  ├─ Open browser → user logs in
  ├─ Local listener for callback → receive authorization_code
  ├─ Exchange for access_token
  └─ Store in Keychain (secure storage)
```

### 6.2 XAA Enterprise Authentication

Cross-App Access (XAA) supports enterprise identity federation:

```
User's enterprise IDP
  → OIDC login to obtain IDP token
    → exchange for MCP server access_token
      → store in Keychain
```

This allows enterprise users to log in to MCP servers using their company SSO, without needing to manage credentials separately for each server.

---

## 7. Agent Integration

### 7.1 Agent-Specific MCP Servers

Agent definitions can declare dedicated MCP servers:

```typescript
// runAgent.ts:95-218
async function initializeAgentMcpServers(agentDef, parentClients) {
  const mergedClients = { ...parentClients }  // Inherit parent agent's connections
  
  for (const server of agentDef.mcpServers) {
    mergedClients[server.name] = await connectToServer(server)  // Create new connection
  }
  
  return {
    clients: mergedClients,
    cleanup: async () => {
      // Only clean up newly created connections, do not close inherited ones
      for (const server of agentDef.mcpServers) {
        await mergedClients[server.name].close()
      }
    }
  }
}
```

### 7.2 Enterprise Policy Restrictions

```typescript
if (isRestrictedToPluginOnly('mcp')) {
  // Only MCP servers approved by enterprise administrators are allowed
  // User-defined ones are rejected
}

if (isSourceAdminTrusted(source)) {
  // Built-in / policy-defined agents bypass restrictions
}
```

---

## 8. Connection Lifecycle Management

### 8.1 React Hook Management

`useManageMCPConnections` (1141 lines) is the React lifecycle manager for MCP connections:

```
Start → connect to all configured MCP servers
  │
  ├─ Watch authVersion changes → re-authenticate
  ├─ Watch refreshActivePlugins → reconnect
  ├─ Connection failure → exponential backoff retry (up to 5 times)
  ├─ Deduplicate Claude.ai MCP servers
  └─ Policy filtering → filterMcpServersByPolicy()
```

### 8.2 Instruction Injection

MCP servers can provide `instructions` — contextual information the model sees on every invocation:

```typescript
function getMcpInstructions(mcpClients) {
  return mcpClients
    .filter(c => c.connected && c.instructions)
    .map(c => `## ${c.name}\n${c.instructions}`)
    .join('\n\n')
}
```

These instructions are injected into the system prompt, allowing the model to understand each MCP server's capabilities and how to use them.

---

## 9. Summary

MCP integration is the **extensibility cornerstone** of Claude Code. Its design reflects several key principles:

1. **Protocol standardization** — MCP is an open protocol; anyone can implement a server
2. **Transport abstraction** — six transport types cover all scenarios from in-process to cross-network
3. **Security layering** — OAuth + XAA + channelAllowlist + permission dialogs, multiple layers of protection
4. **Cache optimization** — connections are memoized, tool lists use LRU cache, reducing repeated overhead
5. **Agent transparency** — MCP tools are available to all agent types, unaffected by tool filtering
