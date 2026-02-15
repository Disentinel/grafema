# RFD-28: Consider unified Datalog execution endpoint in RFDB server

## Goal

Evaluate adding a unified `executeDatalog` command to RFDB server that handles both direct queries and rule-based programs, so clients don't need to route between `datalogQuery` and `checkGuarantee`.

## Context

Discovered in REG-381. Currently:

* `datalogQuery` — parses literal conjunctions via `parse_query()`, evaluates directly
* `checkGuarantee` — parses full programs via `parse_program()`, hardcodes `violation(X)` query

Clients (CLI, MCP) must know which endpoint to call. A unified endpoint would:

1. Try `parse_program()` first
2. If rules found → load them, query for head predicate of first rule
3. If just a conjunction → evaluate directly

## Acceptance Criteria

* Research whether this is worth implementing
* If yes: single endpoint handles both `node(X, "http:route")` and `violation(X) :- node(X, "http:route").`
* Backward compatible — existing `datalogQuery` and `checkGuarantee` still work

## Notes

This is an improvement, not a bug. The current CLI fix (REG-381) routes correctly at the client level. This would move routing to the server for cleaner API.
