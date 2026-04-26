# REG-428: MCP server should auto-start RFDB when needed

## Problem

The Grafema MCP server (configured in `.mcp.json`) requires the RFDB server to be already running. If RFDB is not started manually, all graph queries fail silently or with connection errors.

Current manual workflow:

```bash
# Must run this BEFORE starting Claude Code
/Users/vadim/.local/bin/rfdb-server .grafema/graph.rfdb --socket .grafema/rfdb.sock --data-dir .grafema &
```

## Impact

* Extra manual step every time a developer starts a session
* Easy to forget → confusing errors when queries fail
* Breaks the "just works" expectation for MCP integrations

## Expected Behavior

When MCP server receives a query and RFDB is not running, it should:

1. Auto-start RFDB server (similar to `--auto-start` flag in CLI `analyze` command)
2. Connect and serve the query
3. Optionally: keep RFDB running for the session duration

The CLI already has `--auto-start` logic in `RFDBServerBackend`. MCP server should reuse it.

## Found During

Grafema dogfooding setup (2026-02-15).
