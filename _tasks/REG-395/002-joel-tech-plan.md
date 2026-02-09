# REG-395: Add PROPERTY_ACCESS Nodes - Technical Implementation Plan

**Prepared by:** Joel Spolsky, Implementation Planner
**Date:** 2026-02-09

## Executive Summary

This plan implements PROPERTY_ACCESS nodes to make property access patterns (`config.maxBodyLength`, `Global.context.writer.properties`) queryable in the graph. Currently, these are invisible to `grafema query` – this closes that gap.

**Key architectural decision:** Create one PROPERTY_ACCESS node per chain link. For `a.b.c`, create nodes for `b` (on object `a`) and `c` (on object `a.b`).

**Scope boundary:** PROPERTY_ACCESS nodes are for property reads only. Method calls (`a.b.c()`) are already handled by CALL nodes and should NOT create duplicate PROPERTY_ACCESS nodes.

## Architecture Context

### Current State

**What exists:**
- CALL nodes handle method calls like `obj.method()` via `CallExpressionVisitor`
- MemberExpression detection exists in `detectObjectPropertyAssignment` (lines 5344-5448 of JSASTAnalyzer.ts) for property writes
- Semantic ID system via `ScopeTracker` and `computeSemanticId`
- GraphBuilder buffers nodes and edges for batch writes

**What's missing:**
- No PROPERTY_ACCESS node type in graph
- No visitor to detect property reads (non-call MemberExpressions)
- No query command support for "property" or "prop" type aliases

### Design Decisions

**1. One node per chain link**
For `Global.context.writer.properties.typography.fontsize`:
```
PROPERTY_ACCESS node "context" (objectName: "Global")
PROPERTY_ACCESS node "writer" (objectName: "Global.context")
PROPERTY_ACCESS node "properties" (objectName: "Global.context.writer")
PROPERTY_ACCESS node "typography" (objectName: "Global.context.writer.properties")
PROPERTY_ACCESS node "fontsize" (objectName: "Global.context.writer.properties.typography")
```

**2. Avoid duplication with CALL nodes**
- Method calls like `a.b.c()` are handled by CALL nodes
- PROPERTY_ACCESS only for reads: `a.b.c` (no call)
- Detection: If parent node is CallExpression's callee, skip PROPERTY_ACCESS

**3. Scope containment**
- Each PROPERTY_ACCESS node gets CONTAINS edge from enclosing scope (function, class, module)
- Same pattern as CALL nodes

**4. Semantic ID format**
```
file->scope->PROPERTY_ACCESS->propertyName[#discriminator]
```
Example: `src/app.js->fetchData->PROPERTY_ACCESS->maxBodyLength#0`

**5. Edge cases handling**

| Case | Behavior |
|------|----------|
| `this.property` | Create node, objectName: "this" |
| `obj[computed]` | Create node, propertyName: "\<computed\>", save variable name in metadata |
| `obj['literal']` | Create node, propertyName: "literal" (known at analysis time) |
| `obj[0]` | Create node, propertyName: "0" |
| `obj?.prop` | Create node, mark as optional chain in metadata |
| Property in assignment RHS | Create node (it's a read) |
| Property in function args | Create node (it's a read) |
| Property in return/if | Create node (it's a read) |

## Implementation Plan

### Commit 1: Add PROPERTY_ACCESS node type and edge types

**Goal:** Define graph schema for property access tracking.

**Files to modify:**

1. `/Users/vadimr/grafema-worker-4/packages/types/src/nodes.ts`
   - Add `PROPERTY_ACCESS: 'PROPERTY_ACCESS'` to `NODE_TYPE` constant (after CALL, around line 23)
   - Add interface after `CallNodeRecord` (around line 186):
     ```typescript
     // Property access node (unified property read)
     export interface PropertyAccessNodeRecord extends BaseNodeRecord {
       type: 'PROPERTY_ACCESS';
       propertyName: string;        // Property being accessed
       objectName: string;           // Object it's accessed on
       computed?: boolean;           // true for obj[x]
       computedPropertyVar?: string; // Variable name for obj[x]
       optional?: boolean;           // true for obj?.prop
     }
     ```
   - Add `PropertyAccessNodeRecord` to `NodeRecord` union type (around line 310)

2. `/Users/vadimr/grafema-worker-4/packages/types/src/edges.ts`
   - Add `ACCESSES_PROPERTY: 'ACCESSES_PROPERTY'` to `EDGE_TYPE` constant (after CALLS, around line 33)
   - Add interface after `CallsEdge` (around line 126):
     ```typescript
     export interface AccessesPropertyEdge extends EdgeRecord {
       type: 'ACCESSES_PROPERTY';
       propertyName?: string;
     }
     ```

**Tests:** None yet (schema changes only, no behavior).

**Complexity:** O(1) - constant time additions.

---

### Commit 2: Add PropertyAccessVisitor skeleton

**Goal:** Create visitor file structure matching existing patterns.

**Files to create:**

1. `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/visitors/PropertyAccessVisitor.ts`
   - Copy structure from `CallExpressionVisitor.ts` as template
   - Class: `PropertyAccessVisitor extends ASTVisitor`
   - Constructor: Accept `module`, `collections`, `scopeTracker?`
   - Method: `getHandlers(): VisitorHandlers` returning `{ MemberExpression: handler }`
   - Handler: Empty for now (just `path => {}`)
   - Export: `export class PropertyAccessVisitor`

**Interfaces to add at top of file:**
```typescript
interface PropertyAccessInfo {
  id: string;
  type: 'PROPERTY_ACCESS';
  propertyName: string;
  objectName: string;
  computed?: boolean;
  computedPropertyVar?: string | null;
  optional?: boolean;
  file: string;
  line: number;
  column: number;
  parentScopeId: string;
}
```

**Tests:** None yet (skeleton only).

**Complexity:** O(1) - file creation.

---

### Commit 3: Implement MemberExpression detection logic (TDD)

**Goal:** Detect property reads and collect PropertyAccessInfo records.

**Test file:** `/Users/vadimr/grafema-worker-4/test/unit/PropertyAccessVisitor.test.js`

**Test cases:**
```javascript
describe('PropertyAccessVisitor', () => {
  it('detects simple property access obj.prop', async () => {
    // Code: const x = config.maxBodyLength;
    // Expect: PROPERTY_ACCESS node with propertyName="maxBodyLength", objectName="config"
  });

  it('detects chained property access a.b.c', async () => {
    // Code: const x = a.b.c;
    // Expect: 3 PROPERTY_ACCESS nodes (b on a, c on a.b)
  });

  it('detects this.property', async () => {
    // Code: this.value
    // Expect: PROPERTY_ACCESS with objectName="this"
  });

  it('detects computed property obj[x]', async () => {
    // Code: obj[key]
    // Expect: PROPERTY_ACCESS with propertyName="<computed>", computedPropertyVar="key"
  });

  it('detects bracket literal obj["prop"]', async () => {
    // Code: obj["name"]
    // Expect: PROPERTY_ACCESS with propertyName="name"
  });

  it('detects numeric index obj[0]', async () => {
    // Code: arr[0]
    // Expect: PROPERTY_ACCESS with propertyName="0"
  });

  it('detects optional chaining obj?.prop', async () => {
    // Code: obj?.prop
    // Expect: PROPERTY_ACCESS with optional=true
  });

  it('skips method calls obj.method()', async () => {
    // Code: obj.method()
    // Expect: NO PROPERTY_ACCESS (handled by CALL node)
  });

  it('detects property access in assignments', async () => {
    // Code: const x = obj.value;
    // Expect: PROPERTY_ACCESS node
  });

  it('detects property access in function args', async () => {
    // Code: fn(obj.prop)
    // Expect: PROPERTY_ACCESS node
  });

  it('assigns unique semantic IDs with discriminators', async () => {
    // Code: const x = obj.a; const y = obj.a;
    // Expect: IDs ending with #0 and #1
  });

  it('scopes property access to enclosing function', async () => {
    // Code: function foo() { return obj.prop; }
    // Expect: ID contains "foo" in scope path
  });
});
```

**Implementation in PropertyAccessVisitor.ts:**

Add `MemberExpression` handler:
```typescript
MemberExpression: (path: NodePath) => {
  const memberNode = path.node as MemberExpression;

  // CRITICAL: Skip if parent is CallExpression's callee
  // This avoids duplicating method calls that CALL nodes already handle
  const parent = path.parent;
  if (parent.type === 'CallExpression' && parent.callee === memberNode) {
    return; // Skip - handled by CallExpressionVisitor
  }

  // Skip if inside function - will be handled by analyzeFunctionBody
  const functionParent = path.getFunctionParent();
  if (functionParent) {
    return;
  }

  // Determine parent scope
  const parentScopeId = module.id;

  // Extract chain: a.b.c -> [a, b, c] with full paths
  const chain = this.extractPropertyChain(memberNode);

  // Create PROPERTY_ACCESS node for each link in chain (except first, which is the base object)
  for (let i = 1; i < chain.length; i++) {
    const link = chain[i];
    const objectName = chain.slice(0, i).join('.');

    const line = link.loc?.start.line || 0;
    const column = link.loc?.start.column || 0;

    // Generate ID using IdGenerator
    const idGenerator = new IdGenerator(this.scopeTracker);
    const propertyId = idGenerator.generate(
      'PROPERTY_ACCESS',
      link.propertyName,
      module.file,
      line,
      column,
      propertyAccessCounterRef,
      { useDiscriminator: true, discriminatorKey: `PROPERTY_ACCESS:${link.propertyName}` }
    );

    propertyAccesses.push({
      id: propertyId,
      type: 'PROPERTY_ACCESS',
      propertyName: link.propertyName,
      objectName,
      computed: link.computed,
      computedPropertyVar: link.computedPropertyVar,
      optional: link.optional,
      file: module.file,
      line,
      column,
      parentScopeId,
    });
  }
}
```

**Helper method:** `extractPropertyChain(memberExpr: MemberExpression): ChainLink[]`
- Recursively walk MemberExpression to extract full chain
- Handle nested members: `a.b.c` -> recursively process `a.b`, then add `.c`
- Return array with full object paths for each link
- Complexity: O(n) where n = chain depth

**Edge case handling in helper:**
- `this.prop`: base is "this"
- `obj[computed]`: propertyName = "\<computed\>", save variable name
- `obj['literal']`: propertyName = literal value
- `obj[0]`: propertyName = "0"
- `obj?.prop`: optional = true

**Collections setup:**
- Initialize `propertyAccesses` array in collections
- Initialize `propertyAccessCounterRef` counter
- Add to `ASTCollections` type in types.ts

**Complexity:** O(n * m) where n = number of MemberExpressions, m = average chain depth.

---

### Commit 4: Wire visitor into JSASTAnalyzer

**Goal:** Run PropertyAccessVisitor during module-level traversal.

**Files to modify:**

1. `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
   - Import: `import { PropertyAccessVisitor } from './ast/visitors/PropertyAccessVisitor.js';`
   - Line ~1594 (after CallExpressionVisitor setup): Instantiate visitor
     ```typescript
     const propertyAccessVisitor = new PropertyAccessVisitor(module, allCollections, scopeTracker);
     ```
   - Line ~1620 (in traverse call with CallExpression, NewExpression): Add MemberExpression to handlers
     ```typescript
     traverse(ast, {
       CallExpression: callVisitor.getHandlers().CallExpression,
       NewExpression: callVisitor.getHandlers().NewExpression,
       MemberExpression: propertyAccessVisitor.getHandlers().MemberExpression,
     });
     ```

2. `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/types.ts`
   - Add to `ASTCollections` interface:
     ```typescript
     propertyAccesses?: PropertyAccessInfo[];
     propertyAccessCounterRef?: CounterRef;
     ```

**Tests:** Existing tests should pass (no behavior change for non-property-access code).

**Complexity:** O(1) - wiring only.

---

### Commit 5: Add GraphBuilder support for PROPERTY_ACCESS nodes

**Goal:** Create nodes and edges in graph from collected PropertyAccessInfo.

**Files to modify:**

1. `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
   - Import: Add `PropertyAccessInfo` to imports from types.ts (around line 60)
   - Destructure: Add `propertyAccesses = []` to destructuring in `build()` method (around line 150)
   - Add after method calls processing (around line 800):
     ```typescript
     // === PROPERTY ACCESS NODES ===
     for (const propAccess of propertyAccesses) {
       this._bufferNode({
         id: propAccess.id,
         type: 'PROPERTY_ACCESS',
         name: propAccess.propertyName,
         propertyName: propAccess.propertyName,
         objectName: propAccess.objectName,
         computed: propAccess.computed,
         computedPropertyVar: propAccess.computedPropertyVar,
         optional: propAccess.optional,
         file: propAccess.file,
         line: propAccess.line,
         column: propAccess.column,
       });

       // CONTAINS edge from parent scope
       this._bufferEdge({
         src: propAccess.parentScopeId,
         dst: propAccess.id,
         type: 'CONTAINS',
       });
     }
     ```

**Edge creation:**
- CONTAINS: scope -> PROPERTY_ACCESS (same pattern as CALL nodes)
- Optional: ACCESSES_PROPERTY: PROPERTY_ACCESS -> VARIABLE (if objectName resolves to variable)
  - This can be deferred to enrichers phase (similar to CALLS edge resolution)

**Tests:** Integration test verifying nodes appear in graph.

**Complexity:** O(n) where n = number of property accesses.

---

### Commit 6: Add query command support for "property" type

**Goal:** Enable `grafema query property maxBodyLength` and `grafema query prop maxBodyLength`.

**Files to modify:**

1. `/Users/vadimr/grafema-worker-4/packages/cli/src/commands/query.ts`
   - Add to `typeMap` in `parsePattern()` function (around line 243):
     ```typescript
     property: 'PROPERTY_ACCESS',
     prop: 'PROPERTY_ACCESS',
     ```
   - Add `'PROPERTY_ACCESS'` to `searchTypes` array in `findNodes()` function (around line 552):
     ```typescript
     : [
         'FUNCTION',
         'CLASS',
         'MODULE',
         'VARIABLE',
         'CONSTANT',
         'PROPERTY_ACCESS',  // <-- Add here
         'http:route',
         // ... rest
       ];
     ```

**Tests:** Manual smoke test:
```bash
grafema analyze
grafema query "property maxBodyLength"
grafema query "prop config"
```

**Complexity:** O(1) - constant additions.

---

### Commit 7: Handle property access inside functions (analyzeFunctionBody)

**Goal:** Detect property access inside function bodies, not just module-level.

**Files to modify:**

1. `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
   - In `analyzeFunctionBody()` method (around line 3600): Add MemberExpression handler
   - Pattern: Same as module-level, but use function's scope context
   - Instantiate PropertyAccessVisitor with function-scoped collections
   - Add handler to traverse() call alongside CallExpression, AssignmentExpression, etc.

**Implementation sketch:**
```typescript
// Inside analyzeFunctionBody, after CallExpression setup
const propertyAccessVisitor = new PropertyAccessVisitor(module, collections, scopeTracker);

// In traverse() call
traverse(funcNode.body, {
  CallExpression: ...,
  MemberExpression: propertyAccessVisitor.getHandlers().MemberExpression,
  // ... other handlers
});
```

**Important:** Function-level property access uses function's scope in semantic ID, not module's global scope.

**Tests:** Test property access inside function bodies.

**Complexity:** O(n * m) where n = functions, m = property accesses per function.

---

### Commit 8: Add comprehensive edge case tests

**Goal:** Verify all edge cases are handled correctly.

**Test file:** `/Users/vadimr/grafema-worker-4/test/unit/PropertyAccessEdgeCases.test.js`

**Test cases:**
1. Deeply nested chains: `a.b.c.d.e.f`
2. Mixed chains: `obj.prop[0].field`
3. Optional chaining: `obj?.a?.b?.c`
4. Computed in middle of chain: `a[key].b`
5. Dynamic property access: `obj[getKey()]` (property access on call result)
6. Property on `this`: `this.state.value`
7. Property on array element: `arr[0].name`
8. Property in complex expressions: `(a || b).prop`
9. Property in ternary: `(cond ? a : b).prop`
10. Property access triggering in all statement contexts (assignment, return, if, for, etc.)

**Tests should verify:**
- Correct number of PROPERTY_ACCESS nodes created
- Correct objectName for each link
- Correct semantic IDs with scope paths
- CONTAINS edges exist
- Method calls still handled by CALL nodes (no duplication)

**Complexity:** O(1) per test case.

---

### Commit 9: Integration test with query command

**Goal:** End-to-end test: analyze -> query -> verify results.

**Test file:** `/Users/vadimr/grafema-worker-4/test/unit/commands/PropertyAccessQuery.test.js`

**Test cases:**
```javascript
describe('grafema query for property access', () => {
  it('finds property by name', async () => {
    // Code: config.maxBodyLength
    // Query: grafema query "property maxBodyLength"
    // Expect: Result with objectName="config"
  });

  it('finds property with scope filter', async () => {
    // Code: function foo() { return obj.value; }
    // Query: grafema query "property value in foo"
    // Expect: Result scoped to foo
  });

  it('distinguishes property access from method calls', async () => {
    // Code: obj.method() and obj.property
    // Query: grafema query "property method"
    // Expect: NO results (method is a CALL, not PROPERTY_ACCESS)
    // Query: grafema query "property property"
    // Expect: Result found
  });

  it('supports prop alias', async () => {
    // Query: grafema query "prop maxBodyLength"
    // Expect: Same results as "property maxBodyLength"
  });
});
```

**Complexity:** O(1) per test case.

---

### Commit 10: Documentation and examples

**Goal:** Document the feature for users and future maintainers.

**Files to create/modify:**

1. `/Users/vadimr/grafema-worker-4/_readme/property-access-tracking.md`
   - What: PROPERTY_ACCESS nodes track property reads
   - Why: Makes `config.maxBodyLength` patterns queryable
   - How: One node per chain link
   - Query examples: `grafema query "property maxBodyLength"`
   - Limitations: Only reads, not writes (use mutation tracking for writes)

2. Update CLI help text in `/Users/vadimr/grafema-worker-4/packages/cli/src/commands/query.ts`
   - Add examples using "property" and "prop" types

**Complexity:** O(1) - documentation only.

---

## Edge Cases Summary

| Edge Case | Detection Logic | Result |
|-----------|----------------|--------|
| `obj.method()` | Parent is CallExpression.callee | Skip (handled by CALL) |
| `this.prop` | object.type === 'ThisExpression' | objectName = "this" |
| `obj[x]` | memberExpr.computed && property is Identifier | propertyName = "\<computed\>", save x in computedPropertyVar |
| `obj['lit']` | memberExpr.computed && property is StringLiteral | propertyName = "lit" |
| `obj[0]` | memberExpr.computed && property is NumericLiteral | propertyName = "0" |
| `obj?.prop` | memberExpr.optional === true | optional = true |
| `a.b.c` | Nested MemberExpression | Create 2 nodes: b (on a), c (on a.b) |
| `(expr).prop` | object.type !== 'Identifier' && !== 'ThisExpression' | Skip or track as "\<expression\>.prop" |

## Performance Analysis

**Complexity per commit:**
- Commits 1-2, 4, 6, 10: O(1) - constant time
- Commit 3: O(n * m) - n MemberExpressions, m average chain depth
- Commit 5: O(n) - n property accesses
- Commit 7: O(f * p) - f functions, p property accesses per function
- Commits 8-9: O(1) per test

**Overall complexity:** O(N) where N = total AST nodes (same as existing CALL node detection).

**Memory:** O(P) where P = number of property accesses (same pattern as CALL nodes).

**Graph size impact:** For typical codebase with property access patterns, expect 2-5x more property access nodes than CALL nodes. This is acceptable as nodes are lightweight and queries remain fast with RFDB indexing.

## Testing Strategy

**TDD approach:**
1. Write failing test
2. Implement minimum code to pass
3. Refactor
4. Repeat

**Test pyramid:**
- **Unit tests** (Commits 3, 8): Test visitor logic, edge cases
- **Integration tests** (Commits 5, 9): Test graph creation, query results
- **Smoke tests** (Commit 6): Manual CLI testing

**Test coverage targets:**
- PropertyAccessVisitor: 100% (all branches)
- Edge cases: 100% (all scenarios from table)
- GraphBuilder integration: 100% (node/edge creation)
- Query command: 90% (aliases and type matching)

## Rollout Plan

**Phase 1:** Commits 1-6 (module-level property access)
- Provides basic functionality
- Can be released incrementally

**Phase 2:** Commit 7 (function-level property access)
- Completes the feature
- Requires Phase 1 to be stable

**Phase 3:** Commits 8-10 (edge cases, docs)
- Polish and documentation
- Can overlap with Phase 2

**Risk mitigation:**
- Feature flag: Add `GRAFEMA_ENABLE_PROPERTY_ACCESS` env var to gate the feature
- If performance issues arise, can disable and investigate
- Fallback: Keep existing code paths unchanged, new code is additive only

## Open Questions for User

1. **ACCESSES_PROPERTY edge:** Should we create `PROPERTY_ACCESS -> VARIABLE` edges immediately, or defer to enrichers?
   - Recommendation: Defer to enrichers (similar to CALLS edge resolution). Keeps this change focused.

2. **Nested object expressions:** How to handle `(getConfig()).maxBodyLength`?
   - Recommendation: Track as "\<expression\>.maxBodyLength" for now. Full call result tracking is a future feature.

3. **Write tracking:** Should property writes (`obj.prop = value`) also create PROPERTY_ACCESS nodes?
   - Recommendation: No. Writes are already tracked via ObjectMutationInfo. Keep read/write separation clean.

## Summary

This plan implements PROPERTY_ACCESS nodes in 10 atomic commits, following TDD principles. Each commit is working and tested. The feature integrates cleanly with existing patterns (CALL nodes, semantic IDs, GraphBuilder batching). Query command gets "property"/"prop" aliases for easy discovery.

**Estimated complexity:** O(N) analysis time, O(P) memory where P = property accesses.

**Next step:** Review plan with Don Melone and Linus Torvalds, then hand off to Kent Beck for test implementation.
