# DON MELTON'S ANALYSIS: REG-269 - Transitive Closure Captures

## ANALYSIS FINDINGS

### 1. Current Implementation - Where CAPTURES Edges are Created

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (lines 329-339)

The current implementation in `bufferScopeEdges()`:
```typescript
// CAPTURES - замыкания захватывают переменные из родительского scope
if (capturesFrom && scopeData.scopeType === 'closure') {
  const parentVars = variableDeclarations.filter(v => v.parentScopeId === capturesFrom);
  for (const parentVar of parentVars) {
    this._bufferEdge({
      type: 'CAPTURES',
      src: scopeData.id,
      dst: parentVar.id
    });
  }
}
```

**CRITICAL LIMITATION:** Only looks at `capturesFrom` (immediate parent scope), ignores grandparent and ancestor scopes. This is the architectural bottleneck.

### 2. How Scope Chains are Represented

**Scope Hierarchy Structure:**
- Each SCOPE node has: `parentScopeId` (points to enclosing scope)
- Each SCOPE node has: `parentFunctionId` (points to containing function)
- SCOPE nodes form a linked list: `closure_scope -> CONTAINS -> parent_scope -> ... -> global_module`

**Key Files:**
- `packages/core/src/core/nodes/ScopeNode.ts` - SCOPE node definition
- `packages/types/src/edges.ts` (line 87) - EdgeRecord supports `metadata?: Record<string, unknown>`

**Example from JSASTAnalyzer (line 2310):**
```typescript
scopes.push({
  id: nestedScopeId,
  type: 'SCOPE',
  scopeType: 'closure',
  parentFunctionId: functionId,
  capturesFrom: parentScopeId  // <-- ONLY immediate parent!
});
```

### 3. Current CAPTURES Edge Metadata

**EdgeRecord Structure** (`packages/types/src/edges.ts`):
```typescript
export interface EdgeRecord {
  src: string;
  dst: string;
  type: EdgeType;
  index?: number;
  metadata?: Record<string, unknown>;
}
```

Current CAPTURES edges:
- NO metadata stored (no depth tracking)
- Only `type: 'CAPTURES'` + src/dst IDs
- Format: `SCOPE -[CAPTURES]-> VARIABLE`

### 4. Existing Tests for Captures

**File:** `test/scenarios/01-simple-script.test.js` (line 114-134)

Tests verify:
- Closure captures immediate parent scope variables
- SCOPE:increment:body -[CAPTURES]-> VARIABLE:count (parent)
- No tests for multi-level captures (the gap we're filling)

### 5. Architectural Insights - Where to Implement

**ANALYSIS PHASE (JSASTAnalyzer):**
- Detects immediate captures via `parentScopeVariables` tracking
- Cannot walk full scope chain (not available during AST traversal)
- `parentScopeVariables` is local to function analysis

**ENRICHMENT PHASE (recommended location):**
- All nodes + edges already in graph
- Can query scope chain via `parentScopeId` edges
- Plugin pattern established: `AliasTracker`, `MethodCallResolver`, etc.
- **Perfect place for transitive capture resolution**

### 6. What Data is Available

**At enrichment time:**
- All SCOPE nodes with `parentScopeId` pointers
- All VARIABLE nodes with `parentScopeId`
- All existing CAPTURES edges (immediate parent only)
- GraphBackend queryNodes() API for lookups

**Missing:**
- No "PARENT_SCOPE" edges (only implicit via node.parentScopeId)
- No way to query "all scopes up the chain" directly

---

## WHAT NEEDS TO CHANGE

### Required Changes by Component

**1. ANALYSIS PHASE (JSASTAnalyzer.ts) - MINIMAL**
- NO CHANGES needed to capture detection
- Current `capturesFrom` field remains as-is (immediate parent)
- This is correct behavior for ANALYSIS phase

**2. ENRICHMENT PHASE - NEW PLUGIN**
- Create new `ClosureCaptureEnricher` plugin
- Run after all initial edges created
- Query existing CAPTURES edges
- Walk scope chains to find transitive captures
- Add new CAPTURES edges with `depth` metadata

**3. SCOPE CHAIN WALKING - NEW ALGORITHM**
```
For each SCOPE node with scopeType='closure':
  1. Get its capturesFrom scope ID
  2. Walk parentScopeId chain upward:
     - depth=1: immediate parent (already has edges)
     - depth=2: grandparent
     - depth=3+: great-grandparent, etc.
  3. For each ancestor scope:
     - Find all VARIABLE nodes with parentScopeId=ancestor
     - Create CAPTURES edge with metadata: { depth: N }
  4. Stop at module level (no parent)
```

**4. EDGE METADATA UPDATE**
```typescript
// packages/types/src/edges.ts - update or add semantic edge type
export interface CapturesEdge extends EdgeRecord {
  type: 'CAPTURES';
  depth?: number;  // 1=immediate parent, 2=grandparent, etc
}
```

---

## KEY ARCHITECTURAL DECISIONS

### Decision 1: When to Calculate Multi-level Captures
**CHOSEN: Enrichment Phase (separate plugin)**

**Why not Analysis Phase?**
- Scope chain not fully built during AST traversal
- Would require second pass over functions
- Violates separation of concerns

**Why Enrichment Phase?**
- All nodes/edges stable in graph
- Can use graph queries for lookups
- Idiomatic Grafema pattern (like AliasTracker, MethodCallResolver)
- Can handle cross-file captures when files analyzed

### Decision 2: Depth Calculation
**CHOSEN: Numeric `depth` metadata on edges**

**Rationale:**
- Clear semantics: depth=1 is parent, depth=2 is grandparent
- Enables queries: "show me all captures at depth > 2"
- Memory leak queries: detect which variables held transitively
- Supports future features: "transitively reachable" analysis

### Decision 3: Handling Cycles/Unusual Cases
**CHOSEN: Max depth limit (10 recommended, configurable)**

**Edge cases to handle:**
- Same variable shadowed at multiple levels → create edge to closest
- Circular references → limit walk depth
- Very deep nesting → performance protection

### Decision 4: Backwards Compatibility
**CHOSEN: Add edges, don't modify existing ones**

- Keep existing immediate CAPTURES edges (depth=1 implicit or explicit)
- Add new transitive edges alongside
- Existing queries still work
- Incremental improvement (safe)

---

## RISKS & CONCERNS

### Risk 1: Performance on Deep Closures
**Impact:** O(depth²) for N closures with max depth D
- Example: 100 closures × depth 10 = 1000 scope walks

**Mitigation:**
- Max depth limit (10)
- Cache scope chain lookups
- Query optimized for parentScopeId lookups
- Can be async/batched in enrichment

### Risk 2: Scope Chain Complexity
**Impact:** Scopes can nest deeply:
```
module -> function1 -> closure1 -> if#0 -> for#0 -> inner_closure
```
Missing a scope in chain = missing captures

**Mitigation:**
- Query graph for ALL ancestors (no hardcoded assumptions)
- Test with 4+ level deep nesting
- Validate scope chain is complete

### Risk 3: Cross-File Captures
**Current behavior:** Each file analyzed independently
**Future concern:** What about closures capturing from different files?

**Decision:** Out of scope for REG-269
- Each file analyzed produces its own CAPTURES edges
- Cross-file captures handled by future enrichment

### Risk 4: Shadowing Variables
**Problem:**
```javascript
const x = 1;
function outer() {
  const x = 2;
  function inner() {
    return x;  // Captures which x? The inner one (depth=1)
  }
}
```

**Decision:** Walk UP from closure's declared scope
- Stop at first scope that declares the variable
- Don't skip intermediate scopes with same-named vars
- This matches JavaScript semantics correctly

---

## IMPLEMENTATION STRATEGY

### Phase 1: Plugin Skeleton
1. Create `packages/core/src/plugins/enrichment/ClosureCaptureEnricher.ts`
2. Implement Plugin interface
3. Register in enrichment pipeline
4. Return empty result (no-op)

### Phase 2: Scope Chain Walker
1. Implement `walkScopeChain(scopeId: string, graph)` helper
2. Fetch scope node, iterate parentScopeId upward
3. Collect all ancestor scope IDs
4. Return with depth markers

### Phase 3: Edge Creation
1. Query all SCOPE nodes with scopeType containing 'closure'
2. For each closure, walk scope chain
3. Query VARIABLE nodes in each ancestor scope
4. Create CAPTURES edges with `metadata: { depth: N }`

### Phase 4: Testing
1. Unit test: scope chain walking (depth calculation)
2. Integration test: 3+ level deep closures
3. Performance test: many closures scenario
4. Regression test: existing single-level captures still work

---

## ALIGNMENT WITH PROJECT VISION

**Thesis:** "AI should query the graph, not read code"

**How REG-269 advances this:**
- BEFORE: "I need to understand what closure captures" → Must trace code
- AFTER: Query graph → "show all variables captured at depth > 1" ✓
- Memory leak detection: Query "what large objects are captured 3+ levels deep?"
- Refactoring: "Remove this variable, check all transitive captures"

This makes the graph the superior way to understand closure behavior - exactly what the project aims for.

---

## ACCEPTANCE CRITERIA MAPPING

- [x] Identified where CAPTURES edges currently created (GraphBuilder)
- [x] Understood scope chain representation (parentScopeId linked list)
- [x] Found edge metadata support (EdgeRecord.metadata)
- [x] Located existing capture tests (01-simple-script.test.js)
- [x] Determined implementation location (ClosureCaptureEnricher plugin)
- [x] Defined scope walking algorithm (upward parentScopeId walk)
- [x] Specified depth metadata structure (number on edge)
- [x] Identified risks and mitigations
- [x] Confirmed backwards compatibility approach

---

**NEXT STEP:** Proceed to Joel's technical implementation plan.
