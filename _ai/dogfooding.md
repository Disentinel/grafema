# Grafema Dogfooding Guide

**Use Grafema to work on Grafema.** Hybrid mode: graph for exploration/planning, direct file reads for implementation.

## Setup (per worker)

RFDB server must be running for Grafema queries to work:
```bash
# Start RFDB server (from project root — auto-discovers binary)
grafema server start
# Or using pnpm convenience script (requires pnpm build first):
pnpm rfdb:start

# Rebuild graph after switching branches or pulling changes
grafema analyze
# Or:
node packages/cli/dist/cli.js analyze
```

MCP server configured in `.mcp.json` — provides 25 tools for graph queries. Restart Claude Code after starting RFDB for MCP tools to load.

**RFDB auto-start:** The MCP server auto-starts RFDB when needed. No manual `rfdb-server` command required — `RFDBServerBackend` spawns it on first connection attempt (detached, survives MCP exit). Binary is found via `findRfdbBinary()` (monorepo build, PATH, `~/.local/bin`). For explicit control, use `grafema server start/stop/restart/status`.

## Workflow Integration (Hybrid Mode)

**Don (exploration phase) — MUST try graph first:**

| Instead of... | Try Grafema MCP first |
|---------------|----------------------|
| Glob `**/*.ts` + Read files | `find_nodes` by type/name/file |
| Grep "functionName" + Read context | `find_calls --name functionName` |
| Read file to understand dependencies | `trace_dataflow` or `get_file_overview` |
| Read file to understand structure | `get_file_overview` or `get_function_details` |
| Multiple Reads to understand impact | `query_graph` with Datalog |

If graph doesn't have the answer → fallback to direct file reads. **Note the gap.**

**Kent/Rob (implementation) — direct file reads OK:**
- Implementation needs exact code, not summaries
- Graph useful for: finding call sites, checking impact, understanding dependencies
- But writing code requires reading the actual files

**4-Review — use graph for verification:**
- `get_stats` to check graph health after changes
- `check_guarantees` if guarantees are defined

## Tracking Grafema Usage in Metrics

Every task metrics report (`0XX-metrics.md`) MUST include a **Grafema Dogfooding** section:

```markdown
### Grafema Dogfooding

| Metric | Value |
|--------|-------|
| Graph queries attempted | N |
| Graph queries successful | N (answered the question) |
| Fallbacks to file read | N (graph couldn't answer) |
| Product gaps found | N |

**Gaps found:**
- [what you tried to do] → [why graph couldn't help] → [suggested improvement]

**Verdict:** [useful / partially useful / not useful for this task]
```

## Product Gap Policy

**When Grafema falls short:**
1. Note what you tried and why it failed
2. Record in metrics report (Gaps found section)
3. At STEP 4: present gaps to user → if confirmed → create Linear issue (team: Reginaflow, label: `Improvement`, `v0.2`)
4. Difficulties leading to retries = high-priority gaps

## Known Limitations (2026-02-15)

- **Import resolution**: `.js` → `.ts` redirects not followed, graph is incomplete for TS monorepos
- **Incremental analysis**: not yet available (coming with RFDBv2), full re-analyze after changes
- **Classes**: TypeScript classes not extracted as CLASS nodes
- **Graph coverage**: only entry point files analyzed, transitive imports partially resolved
