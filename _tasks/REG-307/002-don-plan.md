# Don's Analysis: REG-307 - Natural Language Query Support

## Executive Summary

This feature is **RIGHT**. It aligns perfectly with Grafema's vision: "AI should query the graph, not read code."

The current query UX forces users through a discovery-copy-paste workflow that makes the graph feel opaque rather than accessible. Natural language queries flip this: the graph becomes the intuitive first stop.

## Current State Analysis

### Query Command (`packages/cli/src/commands/query.ts`)

The current query command supports:

1. **Pattern parsing** - `"function authenticate"` becomes `{ type: 'FUNCTION', name: 'authenticate' }`
2. **Type aliases** - `function`, `class`, `variable`, `route`, `request`, etc.
3. **Explicit type flag** - `--type http:request "/api"` for exact type match
4. **Raw Datalog** - `--raw 'type(X, "FUNCTION")'` for power users

**Key function: `parsePattern()`** (lines 196-233)
```typescript
function parsePattern(pattern: string): { type: string | null; name: string } {
  const words = pattern.trim().split(/\s+/);
  if (words.length >= 2) {
    const typeWord = words[0].toLowerCase();
    const name = words.slice(1).join(' ');
    // Maps "function" -> "FUNCTION", etc.
    if (typeMap[typeWord]) return { type: typeMap[typeWord], name };
  }
  return { type: null, name: pattern.trim() };
}
```

**What's missing:** Scope parsing. The pattern `"variable response in fetchData"` is not understood.

### Available Metadata on Nodes

From `BaseNodeRecord` (`packages/types/src/nodes.ts`):
```typescript
interface BaseNodeRecord {
  id: string;      // Semantic ID: "file->scope->TYPE->name"
  type: NodeType;  // FUNCTION, CLASS, VARIABLE, etc.
  name: string;    // Node name
  file: string;    // Full file path
  line?: number;   // Line number
  // Plus type-specific fields (async, kind, etc.)
}
```

### Semantic ID Format (`packages/core/src/core/SemanticId.ts`)

Format: `{file}->{scope_path}->{type}->{name}[#discriminator]`

Examples:
- `src/app.js->global->FUNCTION->processData`
- `src/app.js->UserService->METHOD->login`
- `src/app.js->getUser->if#0->CALL->console.log#0`

**Critical insight:** The scope path is embedded in the semantic ID. We can extract:
- File: first segment
- Scope chain: middle segments
- Type: second-to-last segment
- Name: last segment

### RFDB Query Capabilities

From `RFDBServerBackend`:
1. `queryNodes({ nodeType, name, file })` - Basic attribute matching
2. `findByAttr(query)` - Generic attribute query
3. `datalogQuery(query)` - Full Datalog for complex queries

**The `queryNodes` method iterates all nodes of a type and filters client-side.** This is fine for now but won't scale to massive graphs. (Note: future optimization opportunity, not a blocker.)

## Proposed Architecture

### 1. Query Parser Extension

Extend `parsePattern()` to recognize scope modifiers:

```typescript
interface ParsedQuery {
  type: string | null;      // "FUNCTION", "VARIABLE", etc.
  name: string;             // The node name to search
  file: string | null;      // File scope (if "in <file>")
  functionScope: string | null;  // Function/class scope (if "in <name>")
}

// Examples:
// "response" -> { name: "response" }
// "variable response" -> { type: "VARIABLE", name: "response" }
// "response in fetchData" -> { name: "response", functionScope: "fetchData" }
// "response in src/app.ts" -> { name: "response", file: "src/app.ts" }
// "variable response in fetchData in src/app.ts" -> all fields set
```

**Grammar:**
```
query := [type] name ["in" scope]*
type  := "function" | "class" | "variable" | ...
scope := <filename> | <functionName>
```

Detection heuristic for scope type:
- Contains `/` or `.ts`/`.js` extension -> file scope
- Otherwise -> function/class scope

### 2. Two-Phase Search Strategy

**Phase 1: File filter (fast)**
- If file specified, use `queryNodes({ file })` to get candidates
- If no file, iterate by type (or all types if no type)

**Phase 2: Scope filter (via semantic ID parsing)**
- Parse each candidate's semantic ID
- Check if scope path contains the function/class name
- This is O(n) but n is bounded by file/type

Why not use RFDB `findByAttr`? Because scope is encoded in the semantic ID, not as a separate attribute. We'd need Datalog's string matching, which adds complexity for modest benefit.

### 3. Results with Context

Enhance output to show WHERE the node was found:
```
[VARIABLE] response
  ID: src/app.ts->fetchData->try#0->VARIABLE->response
  Location: src/app.ts:15
  Scope: inside fetchData, inside try block

Found 1 result.
```

The `FileExplainer` already has `detectScopeContext()` that parses `try#0`, `catch#0`, etc. Reuse that.

## High-Level Design

### Option A: Extend `parsePattern()` (Recommended)

```
packages/cli/src/commands/query.ts
  - Extend parsePattern() to return ParsedQuery
  - Add scopeFilter() to check semantic ID against scope
  - Modify findNodes() to apply scope filter post-query
  - Enhance displayNode() to show scope context
```

**Pros:**
- Single file change
- Builds on existing infrastructure
- Maintains backwards compatibility

**Cons:**
- Client-side filtering (acceptable for now)

### Option B: Add RFDB attribute for scope

Store the scope path as a separate queryable attribute in RFDB.

**Pros:**
- Server-side filtering
- Better performance at scale

**Cons:**
- Schema change
- Migration needed for existing graphs
- Overkill for current scale

**Recommendation: Option A.** We're not at the scale where server-side filtering matters. Keep it simple. If performance becomes an issue, that's a separate ticket (and we'd have profiling data to guide the solution).

## Implementation Plan

### Files to Modify

1. **`packages/cli/src/commands/query.ts`**
   - Extend `parsePattern()` to return `ParsedQuery`
   - Add `matchesScope()` function
   - Modify `findNodes()` to filter by scope
   - Enhance output format

### New Functions

```typescript
interface ParsedQuery {
  type: string | null;
  name: string;
  file: string | null;
  scope: string | null;  // Function or class name
}

function parseQuery(pattern: string): ParsedQuery;
function matchesScope(semanticId: string, scope: string): boolean;
function extractScopeContext(semanticId: string): string | null;
```

### Test Cases

```bash
# Name only
grafema query "response"

# Type + name
grafema query "variable response"

# Name + file scope
grafema query "response in src/app.ts"

# Name + function scope
grafema query "response in fetchData"

# Full specification
grafema query "variable response in fetchData in src/app.ts"

# Edge case: name contains "in"
grafema query "signin"  # Should not parse as scope

# Multiple scope levels
grafema query "error in catch in fetchData"  # Nested scopes
```

## Concerns and Decisions Needed

### 1. Ambiguity: "in" in Names

What if a function is named `signin`?

**Decision:** Only split on ` in ` (space-padded). `signin` stays as a name.

### 2. Multiple Scopes

Should we support `"x in foo in bar"`?

**Decision:** Yes. Parse all `in` clauses, apply them in order (outer to inner). This naturally handles `"response in catch in fetchData"`.

### 3. Partial vs Exact Match

Should `"fetch"` match `"fetchData"` and `"fetchUsers"`?

**Current behavior:** Yes (substring match). Keep it.

### 4. Case Sensitivity

**Decision:** Case-insensitive for type aliases, case-insensitive for name matching (as currently implemented).

### 5. Scope Match: Substring or Exact?

Should `"in fetch"` match nodes inside `"fetchData"`?

**Decision:** Exact match for scope names. Users can use `"in fetchData"` explicitly. Substring would be too surprising.

## Vision Alignment Check

Does this move us toward "AI should query the graph, not read code"?

**Yes.** An AI agent can now:
1. Ask: "What happens to the response variable in fetchData?"
2. Run: `grafema query "response in fetchData"`
3. Get: Semantic ID, location, scope context
4. Query further or trace data flow

No need to run `explain` first. No need to construct Datalog. The graph becomes the intuitive interface.

## What This Does NOT Do

1. **Fuzzy search** - We don't rank results by relevance. That's a future feature.
2. **Type inference** - If user says `"response"` without type, we search all types. We don't guess they meant VARIABLE.
3. **Cross-file scope** - `"response in fetchData"` searches all files. Could add `"response in fetchData in src/*"` later.

These are deliberate scope limits for v1. Get the basics right first.

## Summary

This is the right feature at the right time. It directly addresses the UX gap exposed by REG-177 and moves the product toward its vision.

**Recommended approach:** Option A (extend `parsePattern()`), single-file change, client-side filtering.

**Risk:** Low. This is additive functionality with clear backwards compatibility.

**Effort estimate:** Medium (1-2 days for implementation + tests).

---

*Don Melton, Tech Lead*
*"I don't care if it works, is it RIGHT?"*
