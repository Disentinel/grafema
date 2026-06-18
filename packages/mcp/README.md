# @grafema/mcp

> Model Context Protocol server exposing the Grafema code graph to AI
> agents (Claude, Cursor, Copilot, Continue, …).

Once wired up, your agent can ask **structural** questions about your
codebase that grep can't answer: "where is the CLASS named UserService",
"who calls this function", "where does this value flow next". The agent
gets back semantic IDs and graph neighborhoods, not text matches.

---

## Installation

```bash
npm install --save-dev @grafema/mcp
```

`@grafema/cli` is required as a peer (it builds the graph the MCP server
queries).

---

## Quick start

### Claude Code

```jsonc
// ~/.claude.json or project .claude.json
{
  "mcpServers": {
    "grafema": {
      "command": "npx",
      "args": ["-y", "@grafema/mcp"]
    }
  }
}
```

### Claude Desktop

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "grafema": {
      "command": "npx",
      "args": ["-y", "@grafema/mcp"]
    }
  }
}
```

After restart, the agent gains 27 focused tools grouped into:

- **Graph queries** — query_graph (datalog/cypher/graphql), find_nodes, find_calls, get_stats
- **Navigation** — get_node (the unified node inspector), find_guards, read_project_structure
- **Traversal & flow** — trace (along data/calls/effects/alias/edges)
- **Provenance** — explain_datalog (why / why-not / what-if)
- **Analysis** — analyze_project, get_analysis_status, get_coverage, discover_services
- **Knowledge graph** — assert, retract, recall, crawl_entity, save_document
- **Guarantees** — check_guarantees, create_guarantee, list_guarantees, delete_guarantee
- **Cross-modality** — find_shared_behaviors
- **Utilities** — get_docs, report_issue, write_config, query_registry

> **One engine, two namespaces.** Grafema's code graph and the project
> knowledge graph are the same engine. Most query/navigation tools
> (`query_graph`, `find_nodes`, `get_node`, `trace`, `get_stats`) take an
> optional `graph: "code" | "knowledge"` param — default `"code"`. The
> knowledge-graph write tools (`assert`, `retract`, …) are the verb-named
> surface of the **Enox assertion protocol** Grafema supports; there is no
> `enox_` tool prefix.

---

## Common agent workflows

### "Where is this defined?"
```
find_nodes(name="UserService", type="CLASS")
  → returns semantic ID
get_node(target="…")            # detail="context" (default): source + neighborhood
```

### "Who calls this function?"
```
find_calls(name="handleRequest")
  → file:line for every resolved caller
```

### "Where does data come from / go?"
```
trace(source="userInput", along="data", direction="forward")
trace(source="response",  along="data", direction="backward")
```

### "What's in this file?"
```
get_node(target="packages/cli/src/cli.ts")
  → a file path / MODULE defaults to a file overview (exports / classes / functions / constants)
```

### "What architectural rules apply here?"
```
list_guarantees()
check_guarantees(category="dataflow")
```

---

## All tools

The full per-tool catalogue with input schemas, descriptions, examples,
and "when to use" guidance lives in **[docs/mcp-reference.md](../../docs/mcp-reference.md)**.

Regenerated from the live graph on each release:

```bash
grafema export --feature 'mcp:tool' --as docs-md   --output docs/mcp-reference.md
grafema export --feature 'mcp:tool' --as mcp-schema --output docs/mcp-schema.json
```

`mcp-schema` is the canonical JSON-RPC tools array — directly servable
by any MCP runtime.

---

## Configuration

### GitHub token (for `report_issue`)

Set `GITHUB_TOKEN` to a PAT with `issues:write` on the target repo for
`report_issue` to file bugs from inside the agent.

```bash
export GITHUB_TOKEN=ghp_…
```

### Project root

The MCP server reads from `.grafema/rfdb.sock` in the current working
directory. Run `grafema analyze` first to populate the graph.

---

## Notes

- Tool count stays in sync with code — no hand-maintained lists.
  Add a new MCP tool definition under `packages/mcp/src/definitions/`
  and it appears in the next reference regen.
- 4 setRequestHandler entry points (`CallToolRequestSchema`, etc.) are
  protocol plumbing, not user-facing tools — they don't appear in the
  reference.
- For CLI usage, see [@grafema/cli](../cli/README.md).
