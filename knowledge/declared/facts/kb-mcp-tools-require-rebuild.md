---
id: kb:fact:kb-mcp-tools-require-rebuild
type: FACT
confidence: high
projections:
  - epistemic
relates_to:
  - packages/mcp/src/definitions/knowledge-tools.ts
created: 2026-03-06
---

The KB MCP tools (`add_knowledge`, `query_knowledge`, `query_decisions`, `supersede_fact`, `get_knowledge_stats`) are defined in `packages/mcp/src/definitions/knowledge-tools.ts` but are only available after rebuilding and restarting the MCP server. In worker branches, the running MCP server may not include the latest tool definitions — an MCP reconnect (`/mcp`) is needed after any build that adds new tools.
