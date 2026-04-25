# Don Melton — Revised Plan for REG-381

## Problem

`grafema query --raw 'violation(X) :- node(X, "http:route").'` returns 0 results despite 322 nodes.

## Root Cause

Two distinct server-side Datalog operations:

| Operation | Server function | Parser | Query |
|-----------|----------------|--------|-------|
| `datalogQuery` | `execute_datalog_query` | `parse_query()` — literal conjunctions | Evaluates the conjunction directly |
| `checkGuarantee` | `execute_check_guarantee` | `parse_program()` — full rules | **Hardcodes** `violation(X)` query |

CLI `--raw` always uses `datalogQuery`. When rule syntax `violation(X) :- node(X, "http:route").` is sent, `parse_query()` only parses `violation(X)`, **silently ignoring** the rule body `:-...`. Result: 0 violations found.

MCP `query_graph` correctly uses `checkGuarantee` and documents "Must define violation/1 predicate."

## Why a Unified Server Endpoint is Wrong

Steve's review suggested a single server endpoint. This doesn't work because:

1. **`checkGuarantee` hardcodes `violation(X)` as the query** (rfdb_server.rs:1269). It's specifically for guarantee checking.
2. **Direct queries need `datalogQuery`** — queries like `node(X, "http:route")` are not valid programs (no `.` terminator, no rule head).
3. **These ARE different operations** — like `SELECT` vs `CREATE VIEW` in SQL. The client must know which operation to invoke.
4. Server unification would require a new Rust endpoint, rebuild, and publish — a separate task with its own scope.

## Why `:-` Detection is Reliable (Not a Hack)

`:-` is Datalog's **implication operator** — the fundamental syntax that separates rules from queries. It:
- Cannot appear in string literals (Datalog strings use `"..."`)
- Cannot appear in predicate names or variables
- Has a single, unambiguous meaning in Datalog syntax

This is equivalent to checking if SQL starts with `SELECT` — it's recognizing a syntax construct, not pattern-matching heuristics.

## Fix

In `executeRawQuery` (`packages/cli/src/commands/query.ts`):

```typescript
async function executeRawQuery(backend, query, options) {
  // Rules (head :- body.) use checkGuarantee; direct queries use datalogQuery
  const isRule = query.includes(':-');
  const results = isRule
    ? await backend.checkGuarantee(query)
    : await backend.datalogQuery(query);
  // ... format and display results
}
```

Also update `--raw` help text to include rule examples matching MCP documentation.

## Scope

- **1 file changed**: `packages/cli/src/commands/query.ts`
- **Help text updated**: add rule syntax examples to `--raw` documentation
- **Tests**: unit test for routing logic, integration test for both query types
- **Complexity**: Low
- **Risk**: Low — uses the same backend methods, proven via MCP

## Follow-up Issues (Not in This PR)

1. Server: `parse_query()` should error on unconsumed input (silent failure is a bug)
2. Server: consider a unified `executeDatalog` endpoint for future clients
