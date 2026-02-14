# Don Melton — Plan for REG-381

## Problem

`grafema query --raw 'violation(X) :- node(X, "http:route").'` returns no results despite `grafema ls --type http:route` showing 322 nodes.

## Root Cause

Two different Datalog endpoints on the RFDB server:
- `datalogQuery` → uses `parse_query()` — parses **literal conjunctions** only (e.g., `node(X, "http:route")`)
- `checkGuarantee` → uses `parse_program()` — parses **full Datalog rules** with `:-` syntax

`executeRawQuery` in `query.ts` always calls `backend.datalogQuery()`. When a rule like `violation(X) :- node(X, "http:route").` is sent, `parse_query()` only parses `violation(X)` and **silently ignores** the rule body. Since no `violation` rules exist, result is empty.

The MCP handler (`handleQueryGraph`) already correctly uses `checkGuarantee()`.

## Fix

In `executeRawQuery` (`packages/cli/src/commands/query.ts`), detect whether the query contains rule syntax (`:-`) and route accordingly:
- Contains `:-` → use `backend.checkGuarantee(query)`
- Otherwise → use `backend.datalogQuery(query)` (for direct queries like `node(X, "http:route")`)

Also update the `--raw` help text to include examples with rule syntax.

## Scope

- **1 file changed**: `packages/cli/src/commands/query.ts` — `executeRawQuery` function
- **Test**: Integration test confirming both paths work
- **Complexity**: Low — single if/else routing change
- **Risk**: Low — `checkGuarantee` is already proven via MCP path

## Not in scope

- Fixing `parse_query()` on the Rust side to error on unconsumed input (good improvement but separate issue)
- Unifying the two endpoints server-side
