# Joel Spolsky - Technical Plan v2: PROPERTY_ACCESS Nodes

## Architecture

1. **One node per chain link** — `a.b.c` creates nodes for `b` and `c`
2. **No duplication with CALL** — `obj.method()` stays as CALL only
3. **CONTAINS edges** from enclosing scope (like CALL nodes)
4. **Semantic IDs** via ScopeTracker

## Edge Cases

- `obj.prop` → PROPERTY_ACCESS name="prop", objectName="obj"
- `this.prop` → objectName="this"
- `obj[computed]` → name="<computed>", objectName="obj"
- `obj['literal']` → name="literal", objectName="obj"
- `obj[0]` → name="0", objectName="obj"
- `obj?.prop` → metadata.optional=true
- `a.b.c()` → CALL handles `c`, PROPERTY_ACCESS for `b` only (object of callee chain)
- `a.b.c` → PROPERTY_ACCESS for both `b` and `c`

## Implementation Steps

### Step 1: Types
- Add PROPERTY_ACCESS to `packages/types/src/nodes.ts`

### Step 2: PropertyAccessVisitor + Tests (TDD)
- Create `packages/core/src/plugins/analysis/ast/visitors/PropertyAccessVisitor.ts`
- Follows CallExpressionVisitor pattern
- Handles MemberExpression AST nodes
- Extracts chain, skips method call targets (callee of CallExpression)
- Tests first: `test/unit/plugins/analysis/ast/property-access.test.ts`

### Step 3: Wire into JSASTAnalyzer + GraphBuilder
- JSASTAnalyzer collects PropertyAccessInfo from visitor
- GraphBuilder buffers PROPERTY_ACCESS nodes + CONTAINS edges
- Flush with other nodes

### Step 4: Query command support
- Add "property"/"prop" type aliases in query.ts
- `grafema query "property maxBodyLength"` works

## Complexity
- Time: O(N) — single AST pass (same as CALL detection)
- Space: O(P) — P = property accesses per file
- Graph: 2-5x more nodes than CALL nodes (RFDB handles this)

## Key Decision: Skip method call targets
`a.b.c()` → CALL node for `a.b.c`, PROPERTY_ACCESS for `b` on `a` only.
The `c` is the method being called — CALL already tracks it.
