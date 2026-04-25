# Don Exploration: RFD-28 — Unified Datalog Execution Endpoint

## Current Architecture

### Server-Side (Rust)

**Command handler:** `packages/rfdb-server/src/bin/rfdb_server.rs`

Two separate endpoints:

1. **`DatalogQuery`** (lines 1163-1170)
   - Calls `execute_datalog_query()` (lines 1655-1677)
   - Uses `parse_query()` → returns `Vec<Literal>` (a conjunction)
   - Creates evaluator WITHOUT rules
   - Calls `evaluator.eval_query(&literals)`
   - Returns `Response::DatalogResults`

2. **`CheckGuarantee`** (lines 1141-1148)
   - Calls `execute_check_guarantee()` (lines 1612-1641)
   - Uses `parse_program()` → returns `Program` (collection of `Rule`s)
   - Creates evaluator, loads rules from program
   - Hardcodes query: `parse_atom("violation(X)")`
   - Calls `evaluator.query(&violation_query)`
   - Returns `Response::Violations`

### Parser (Rust)

- `parse_query()` — `packages/rfdb-server/src/datalog/parser.rs:307-310`
- `parse_program()` — `packages/rfdb-server/src/datalog/parser.rs:294-297`

Both return `Vec<Bindings>`, response format is identical.

### Client-Side (TypeScript)

**Backend:** `packages/core/src/storage/backends/RFDBServerBackend.ts:701-736`
- `datalogQuery()` and `checkGuarantee()` return identical format
- Both convert `{X: "value"}` → `[{name: "X", value: "value"}]`

**CLI routing (REG-381 fix):** `packages/cli/src/commands/query.ts:1019-1045`
- Uses `query.includes(':-')` to decide which endpoint to call

## Key Insight

The issue proposes something smarter than just merging endpoints. Instead of hardcoding `violation(X)`:

> 1. Try `parse_program()` first
> 2. If rules found → load them, **query for head predicate of first rule**
> 3. If just a conjunction → evaluate directly

This means:
- `violation(X) :- node(X, "http:route").` → auto-queries `violation(X)`
- `reachable(X, Y) :- edge(X, Y, "CALLS").` → auto-queries `reachable(X, Y)`
- `node(X, "FUNCTION")` → direct query

## Complexity Assessment

- ~70 lines Rust (new handler + unified function)
- ~15 lines TypeScript (new client method + delegation)
- ~20 lines tests
- **Effort: 2-3 hours**

## Recommendation

**Worth implementing.** Despite low priority, the effort is minimal and the API improvement is real:
1. Clients no longer need string-matching to route
2. Auto-detection of head predicate is more powerful than hardcoded `violation(X)`
3. Backward compatible — existing endpoints stay
