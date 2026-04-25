# Don Melton — Exploration Report for REG-242

## Key Findings

### 1. CLI Handler: `executeRawQuery()`
**File:** `packages/cli/src/commands/query.ts` lines 1015-1042

"No results." printed at line 1032. This is where warning logic should be added.

### 2. Query Execution Chain
`executeRawQuery()` → `backend.executeDatalog(query)` → RFDB server (Rust)

The RFDB server does NOT return info about which predicates failed — just returns empty results. Detection must be heuristic in TypeScript.

### 3. Built-in Predicates
Documented in help text (query.ts lines 76-98):
- `type(Id, Type)`, `node(Id, Type)`, `edge(Src, Dst, Type)`, `attr(Id, Name, Value)`, `path(Src, Dst)`, `incoming(Dst, Src, T)`, `neq`, `starts_with`, `not_starts_with`

No central registry in TypeScript — hardcoded list needed.

### 4. No Datalog Parser in TypeScript
Query string sent as-is to Rust server. Need simple regex-based predicate extraction.

### 5. No Existing Tests for --raw Queries
Tests exist for natural language, http routes, etc. but not raw Datalog.

### 6. User-defined Rules
Server auto-detects rules (has `:-`). No TS-side registry of user-defined predicates.

## Files to Modify
1. `packages/cli/src/commands/query.ts` — add predicate extraction, warning logic

## Files to Create
1. Test file for raw query predicate warning

## Scope
- ~50 lines new code, ~100 lines tests
- Single file modification
- Low risk (only affects --raw error messages)
