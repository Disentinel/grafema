# Don Melton's Analysis: REG-253 Query by Arbitrary Node Type

## Executive Summary

This feature is **well-aligned with Grafema's vision**: "AI should query the graph, not read code."

Currently, the `query` command has a hardcoded list of searchable types. When a developer adds a new node type (like `jsx:component` or `redis:cache`), they can't query it without modifying the CLI code. This breaks the fundamental promise that the graph is the source of truth.

The fix is straightforward architecturally but requires careful UX design.

---

## Current Architecture Analysis

### Query Command (`packages/cli/src/commands/query.ts`)

**Current flow:**
1. Pattern is parsed via `parsePattern()` which has a hardcoded `typeMap`:
   ```typescript
   const typeMap: Record<string, string> = {
     function: 'FUNCTION',
     class: 'CLASS',
     route: 'http:route',
     request: 'http:request',
     // ... hardcoded list
   };
   ```

2. If no type is specified, `findNodes()` searches a hardcoded list:
   ```typescript
   const searchTypes = type
     ? [type]
     : ['FUNCTION', 'CLASS', 'MODULE', 'VARIABLE', 'CONSTANT', 'http:route', 'http:request', ...];
   ```

3. Matching is type-aware via `matchesSearchPattern()` - different fields for different types.

**Problem:** New node types (from plugins, enrichers, or future analyzers) are invisible to the query system.

### Stats Command (`packages/cli/src/commands/stats.ts`)

Already has the capability to list all node types:
```typescript
const stats = await backend.getStats();
// stats.nodesByType = { FUNCTION: 123, CLASS: 45, 'http:route': 10, ... }
```

### RFDB Backend (`packages/core/src/storage/backends/RFDBServerBackend.ts`)

Already supports:
- `queryNodes({ nodeType: 'any-type' })` - query by arbitrary type
- `countNodesByType()` - get counts per type
- `findByType(nodeType)` - get all node IDs of a type

**The infrastructure is already there.** This is a CLI/UX feature, not a backend feature.

---

## Design Decisions

### 1. `--type` Flag for Query Command

**Decision:** Add `--type <nodeType>` option that accepts the exact node type string.

```bash
grafema query --type http:request "pattern"    # Search within type
grafema query --type jsx:component "Button"    # Any namespaced type
grafema query --type VARIABLE "config"         # Standard types too
```

**Rationale:**
- Explicit is better than implicit
- No ambiguity about what type is being searched
- Works with any type, including future ones
- Natural language aliases (`function`, `class`) continue to work as before

**Key insight:** The `--type` flag should bypass the pattern parsing entirely. If `--type` is provided, the first word of the pattern is NOT a type alias.

### 2. `grafema ls --type` Command

**Decision:** Extend or create `ls` command to list nodes by type.

```bash
grafema ls --type http:request        # List all HTTP requests
grafema ls --type FUNCTION -l 50      # List functions (limit 50)
grafema ls --type jsx:component       # List JSX components
```

**Current state:** There is no `ls` command. The closest is `stats --types` which shows counts.

**Options:**
1. Create new `ls` command (preferred)
2. Add `--list` mode to `query`
3. Add `--list` mode to `stats`

Option 1 is cleanest - `ls` is a natural Unix idiom for listing things.

### 3. `grafema types` Command

**Decision:** New subcommand to list all node types with counts.

```bash
grafema types
# Output:
# Node Types in Graph:
#   FUNCTION         1,234
#   CLASS              456
#   MODULE             123
#   http:route          45
#   http:request        32
#   ...
```

**Alternative considered:** `grafema stats --types` already does this, but:
- Discovery problem: users don't know to look at `stats`
- UX: "I want to see what types exist" -> `grafema types` is natural

**Decision:** Keep `stats --types` for backward compat, add `types` as alias/dedicated command.

### 4. Tab Completion (Low Priority)

**Feasibility:** Commander.js doesn't have built-in shell completion. Options:
1. Use `tabtab` package
2. Generate completion scripts via `grafema completions bash/zsh`
3. Defer to future

**Decision:** Mark as "if feasible" in acceptance criteria. Don't block the feature on this.

---

## Implementation Plan (High-Level)

### Phase 1: Core Feature

1. **Add `--type` flag to query command**
   - Option: `--type, -t <nodeType>`
   - If provided, search only that type
   - Bypass pattern parsing for type detection
   - Keep existing natural language aliases working

2. **Create `ls` command**
   - `grafema ls --type <nodeType>` - list nodes of type
   - `--limit, -l` - limit results (default 50)
   - `--json` - JSON output
   - Display: ID, name, file:line

3. **Create `types` command**
   - List all node types with counts
   - Sort by count (descending) or alphabetically
   - `--json` for machine consumption

### Phase 2: Polish

4. **Improve matching for unknown types**
   - Generic fallback: search `name` field
   - Log warning if type not found in graph

5. **Tab completion (optional)**
   - Generate shell completion scripts
   - Complete `--type` argument from available types

---

## Key Files to Modify

| File | Change |
|------|--------|
| `packages/cli/src/commands/query.ts` | Add `--type` option, modify `findNodes` |
| `packages/cli/src/commands/ls.ts` | **New file** - list nodes by type |
| `packages/cli/src/commands/types.ts` | **New file** - list all types |
| `packages/cli/src/cli.ts` | Register new commands |
| `packages/cli/test/` | Tests for new functionality |

---

## Risks and Concerns

### 1. Type String Case Sensitivity
Node types can be `FUNCTION` (uppercase), `http:route` (lowercase namespaced), or mixed.

**Mitigation:** Accept types as-is, but also try uppercase if not found.

### 2. Unknown Type Behavior
What if user queries `--type foo:bar` that doesn't exist?

**Mitigation:** Check if type exists in graph, show helpful message:
```
No nodes of type "foo:bar" found.
Available types: FUNCTION, CLASS, http:route, ...
```

### 3. Performance
Listing all nodes of a type could be slow.

**Mitigation:** Already handled - `--limit` default 50.

### 4. Matching Logic Complexity
`matchesSearchPattern()` has type-specific logic. New types won't have custom matching.

**Mitigation:** Use generic name matching for unknown types. Document that custom matching requires code changes.

---

## Vision Alignment Check

| Criterion | Status |
|-----------|--------|
| AI can query graph, not read code | Yes - any node type becomes queryable |
| Works on untyped/loosely-typed codebases | Yes - node types are Grafema's, not language's |
| Documentation for LLM agents | Need to add help text for AI consumption |
| No hardcoded assumptions | Yes - types come from graph, not code |

**This feature directly addresses a product gap.** Currently an AI agent cannot discover and query custom node types without reading Grafema source code.

---

## Acceptance Criteria (Refined)

1. `grafema query --type <nodeType> "pattern"` - search within specific node type
2. `grafema ls --type <nodeType>` - list all nodes of a type
3. `grafema types` - list all node types present in graph with counts
4. Tab completion for `--type` argument - **nice to have**, not blocking
5. Helpful error messages when type doesn't exist
6. JSON output support for all new functionality
7. Tests covering new commands and options

---

## Recommendation

**Proceed with implementation.** This is a clean, well-scoped feature that:
- Fills a real product gap
- Aligns with project vision
- Has minimal risk
- Leverages existing backend capabilities

Estimated effort: Medium (2-3 days for a careful implementation with tests).
