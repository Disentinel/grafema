# Don Melton - High-Level Plan for `grafema doctor`

## Executive Summary

The `doctor` command is a diagnostic tool for answering "why isn't Grafema working as expected?" It should be the first command users run when something seems wrong.

**Core Principle:** Doctor diagnoses the SETUP, not the code. It answers:
- Is Grafema configured correctly?
- Is the database in a healthy state?
- What should I do to fix problems?

## Design Philosophy

### What Doctor IS
- A diagnostic tool for setup/configuration issues
- A pre-flight check before analysis
- A troubleshooting guide with actionable recommendations

### What Doctor is NOT
- A code quality tool (that's `grafema check`)
- A replacement for validation plugins
- A performance profiler

### Separation of Concerns

| Command | Purpose | Example |
|---------|---------|---------|
| `doctor` | Is Grafema set up correctly? | "Config valid, DB connected, 3 entrypoints" |
| `check` | Does my code meet guarantees? | "No eval() calls, all functions typed" |
| `stats` | What's in the graph? | "9674 nodes, 21846 edges" |

## Proposed Check Hierarchy

### Level 1: Prerequisites (fail-fast)

1. **Grafema Initialized**
   - `.grafema/` directory exists
   - `config.yaml` exists and parseable
   - FAIL: "Run `grafema init`"

2. **RFDB Server Accessible**
   - Can connect to socket
   - Server responds to ping
   - FAIL: "Run `grafema analyze` or `grafema server start`"

### Level 2: Configuration Validity

3. **Config Schema Valid**
   - All required fields present
   - Plugin names recognized
   - Service paths exist and are directories
   - WARN: "Unknown plugin: FooBar" (typo?)

4. **Entrypoints Resolvable**
   - package.json main/exports point to existing files
   - Configured service entrypoints exist
   - WARN: "No entrypoint found for service X"

### Level 3: Graph Health

5. **Database Has Data**
   - Node count > 0
   - Edge count > 0
   - FAIL: "Database is empty. Run `grafema analyze`"

6. **Graph Connectivity**
   - Query disconnected node count
   - Show percentage of unreachable nodes
   - WARN if > 5%: "172 disconnected nodes (1.8%)"
   - CRITICAL if > 20%: Major analysis issue

7. **Graph Freshness** (optional, if we track timestamps)
   - Are any modules stale?
   - When was last analysis?
   - INFO: "Last analyzed: 2 hours ago, 3 files modified since"

### Level 4: Informational (always pass)

8. **Version Info**
   - CLI version
   - RFDB server version
   - Core library version
   - Useful for bug reports

9. **Analysis Summary**
   - Node/edge counts by type
   - Unresolved call count (informational, not error)
   - Plugin load status

## Exit Code Strategy

```
0 = All checks passed (green)
1 = Critical issues found (red) - Grafema won't work correctly
2 = Warnings found (yellow) - Works but may have issues
```

Critical issues (exit 1):
- Config file missing or unparseable
- Database doesn't exist
- Can't connect to server
- Zero nodes in graph

Warnings (exit 2):
- Unknown plugins in config
- Disconnected nodes > 5%
- Service entrypoints not found
- Stale modules detected

## Command Options

```bash
grafema doctor [options]

Options:
  -p, --project <path>   Project path (default: ".")
  -j, --json            Output as JSON (for scripting/CI)
  -q, --quiet           Only show failures
  --fix                 Auto-fix what can be fixed (future)
  --verbose             Show detailed diagnostics
```

### JSON Output Structure (for CI)

```json
{
  "status": "warning",
  "checks": [
    {
      "name": "config",
      "status": "pass",
      "message": "Config file: .grafema/config.yaml"
    },
    {
      "name": "database",
      "status": "pass",
      "message": "Database: .grafema/graph.rfdb (9674 nodes, 21846 edges)"
    },
    {
      "name": "connectivity",
      "status": "warning",
      "message": "172 disconnected nodes",
      "recommendation": "Run `grafema analyze --clear` to rebuild"
    }
  ],
  "recommendations": [
    "Fix disconnected nodes (REG-202)"
  ]
}
```

## Output Format

Follow existing CLI patterns (see `check.ts`, `server.ts`):

```
Checking Grafema setup...

✓ Config file: .grafema/config.yaml
✓ Server: connected (RFDB v0.1.0)
✓ Database: .grafema/graph.rfdb (9674 nodes, 21846 edges)
✗ Graph connectivity: 172 disconnected nodes (1.8%)
  → Run `grafema analyze --clear` to rebuild

✓ Entrypoints: 3 found
  ├─ apps/backend/src/index.ts
  ├─ apps/frontend/src/main.tsx
  └─ apps/telegram-bot/src/index.ts

⚠ Unresolved calls: 987 (expected for external libs)
  → See documentation on external module handling

Recommendations:
  1. Rebuild graph to fix connectivity issues
  2. Consider adding type stubs for frequently called external modules

Status: 1 issue found
```

## Architectural Concerns

### 1. Reuse Existing Infrastructure

DO NOT duplicate logic. Reuse:
- `loadConfig()` from ConfigLoader - already validates config
- `GraphConnectivityValidator` logic - already computes disconnected nodes
- `RFDBServerBackend.getStats()` - already provides counts
- `isServerRunning()` from server.ts - already checks server status

### 2. Graph Queries for Health Checks

For connectivity check, we have two options:

**Option A: Query from manifest** (if stored by GraphConnectivityValidator)
- Fast - just read metadata
- Requires running analyze first with validation enabled

**Option B: Run lightweight validation**
- Self-contained - doesn't depend on prior analysis
- Slower for large graphs

Recommendation: **Option A with fallback to B**. If manifest has validation results, use them. Otherwise compute.

### 3. Future: `--fix` Option

NOT in initial scope, but design should allow for:
- `--fix` could auto-run `grafema analyze --clear`
- `--fix` could auto-start server
- `--fix` could update config schema

### 4. No Network Calls

Doctor should work offline. No:
- Version checks against npm
- Telemetry
- External services

## Open Questions for Joel

1. **Freshness Check**: Do we track last analysis timestamp? If not, skip this check.

2. **Manifest Access**: Can we read validation results from manifest without full graph traversal?

3. **Plugin Validation**: Should we verify plugin classes exist, or just warn on unknown names?

4. **Service Entrypoints**: For config-defined services, should we validate entrypoint files exist on disk?

## Implementation Order

1. Create `doctor.ts` command skeleton with options
2. Implement Level 1 checks (prerequisites)
3. Implement Level 2 checks (config validity)
4. Implement Level 3 checks (graph health)
5. Add Level 4 informational output
6. Add JSON output mode
7. Add tests for each check
8. Integration test with real project

## What We're NOT Doing

- Not adding `--watch` mode (overkill for diagnostics)
- Not validating every edge type (that's analysis, not setup)
- Not suggesting code changes (that's `check` command)
- Not auto-fixing config (deferred to future `--fix`)

## Alignment with Vision

This command supports the project vision by:
1. **Reducing friction** - Users can quickly diagnose why queries aren't working
2. **Actionable output** - Every failure has a clear next step
3. **AI-friendly** - JSON output enables agent-driven troubleshooting
4. **Self-documenting** - Doctor explains what it checks and why

When an AI agent sees "0 modules found", doctor tells it "Run `grafema analyze`" instead of having it guess.
