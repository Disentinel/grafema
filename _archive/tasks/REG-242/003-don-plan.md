# Don Melton — Plan for REG-242

## Task
Add warning when `--raw` Datalog query returns empty results and uses unknown predicates.

## Architecture Decision

**Approach:** Client-side heuristic detection (TypeScript, in CLI).

The RFDB server doesn't distinguish "no results because predicate unknown" from "no results because nothing matches." Detection must happen in the CLI layer.

**Why not modify RFDB server?** This is a UX improvement for CLI users. The server correctly returns empty for unknown derived predicates (Datalog semantics). Adding server-side detection would require Rust changes and protocol changes — overkill for a warning message.

## Implementation Plan

### 1. Define built-in predicate list

Add `BUILTIN_PREDICATES` constant to `query.ts`:

```typescript
const BUILTIN_PREDICATES = new Set([
  'node', 'type',  // type is documented alias (goes to eval_derived but commonly used)
  'edge', 'incoming', 'path',
  'attr', 'attr_edge',
  'neq', 'starts_with', 'not_starts_with',
]);
```

Source: Rust `eval_atom()` match arms + `type` (documented alias).

### 2. Extract predicates from raw query string

Simple regex extraction — match `word(` patterns:

```typescript
function extractPredicates(query: string): string[] {
  const regex = /\b([a-z_][a-z0-9_]*)\s*\(/g;
  const predicates = new Set<string>();
  let match;
  while ((match = regex.exec(query)) !== null) {
    predicates.add(match[1]);
  }
  return [...predicates];
}
```

Edge cases handled:
- Multiple predicates in one query: `type(X, "F"), attr(X, "name", N)` → `['type', 'attr']`
- Rule heads: `violation(X) :- node(X, "F").` → `['violation', 'node']` — `violation` is the user-defined rule head, not unknown
- Negation: `\+ edge(X, _, "CALLS")` → `['edge']` (still extracted correctly)

### 3. Detect user-defined rule heads

If query contains `:-`, it defines rules. Rule head predicates are NOT unknown — they're being defined:

```typescript
function extractRuleHeads(query: string): Set<string> {
  const regex = /\b([a-z_][a-z0-9_]*)\s*\([^)]*\)\s*:-/g;
  const heads = new Set<string>();
  let match;
  while ((match = regex.exec(query)) !== null) {
    heads.add(match[1]);
  }
  return heads;
}
```

### 4. Modify `executeRawQuery()` — add warning logic

After detecting empty results, check for unknown predicates:

```
unknown = extractPredicates(query) - BUILTIN_PREDICATES - extractRuleHeads(query)
```

If `unknown` is non-empty AND results are empty:
```
No results.
Note: unknown predicate 'foo_bar'. Built-in predicates: node, edge, attr, path, incoming, neq, starts_with, not_starts_with
```

**Key decisions:**
- Warning goes to **stderr** (not stdout) — so JSON output isn't contaminated
- Show full list of built-ins (not fuzzy "did you mean") — simpler, more useful for learning
- Only trigger when results are empty (per acceptance criteria)
- `type` excluded from the "Built-in predicates" suggestion list since it's just an alias for `node`

### 5. JSON mode behavior

In JSON mode, also print warning to stderr. JSON output to stdout remains clean.

## Files to Modify

1. `packages/cli/src/commands/query.ts`
   - Add `BUILTIN_PREDICATES` constant
   - Add `extractPredicates()` function
   - Add `extractRuleHeads()` function
   - Modify `executeRawQuery()` to add warning

## Files to Create

1. `packages/cli/test/query-raw-predicate-warning.test.ts`
   - Unit tests for `extractPredicates()`
   - Unit tests for `extractRuleHeads()`
   - Integration test: unknown predicate shows warning
   - Integration test: built-in predicate no warning
   - Integration test: user-defined rule no warning for head

## Scope

- ~40 lines new code in query.ts
- ~100 lines tests
- Single file modification
- **Risk: LOW** — only affects display when results are empty, no changes to query execution

## Uncle Bob Pre-check

`executeRawQuery()` is 24 lines — clean, no refactoring needed. The functions being added are small utilities. File `query.ts` needs a line count check.
