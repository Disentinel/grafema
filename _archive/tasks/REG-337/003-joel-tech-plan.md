# Joel Spolsky's Technical Implementation Plan: REG-337

## Summary of Findings

After reviewing all 35 node contract files in `/Users/vadimr/grafema/packages/core/src/core/nodes/`, I've categorized nodes into:

**PHYSICAL NODES (21 types)** - represent specific code locations, MUST have column:
1. FunctionNode - ALREADY has column in REQUIRED (reference pattern)
2. VariableDeclarationNode - column in OPTIONAL, defaults to `|| 0`
3. CallSiteNode - column in OPTIONAL, defaults to `|| 0`
4. MethodCallNode - column in OPTIONAL, defaults to `|| 0`
5. MethodNode - column in OPTIONAL, defaults to `|| 0`
6. ConstructorCallNode - column in OPTIONAL, defaults to `|| 0`
7. ConstantNode - column in OPTIONAL, defaults to `|| 0`
8. LiteralNode - column in OPTIONAL, defaults to `|| 0`
9. ImportNode - column in OPTIONAL, defaults to `|| 0`
10. ExportNode - column in OPTIONAL, defaults to `|| 0`
11. ClassNode - column in OPTIONAL, defaults to `|| 0`
12. InterfaceNode - column in OPTIONAL, defaults to `|| 0`
13. TypeNode - column in OPTIONAL, defaults to `|| 0`
14. EnumNode - column in OPTIONAL, defaults to `|| 0`
15. DecoratorNode - column in OPTIONAL, defaults to `|| 0`
16. ParameterNode - column in OPTIONAL, defaults to `|| 0`
17. ExpressionNode - column in OPTIONAL, defaults to `|| 0`
18. ObjectLiteralNode - **ALREADY has column in REQUIRED**
19. ArrayLiteralNode - **ALREADY has column in REQUIRED**
20. EventListenerNode - column in OPTIONAL (options), NOT in record type, defaults to `|| 0`
21. HttpRequestNode - column in OPTIONAL (options), NOT in record type, defaults to `|| 0`

**NODES REQUIRING ADDITIONAL COLUMN FIELD** (4 types) - need column added:
1. BranchNode - NO column field at all
2. CaseNode - NO column field at all
3. DatabaseQueryNode - NO column field at all
4. ArgumentExpressionNode - needs verification

**ABSTRACT/SEMANTIC NODES (keep without column)**:
- ServiceNode - line: 0 hardcoded
- ModuleNode - line: 0 hardcoded
- ExternalModuleNode - line: 0 hardcoded
- EntrypointNode - line: 0 hardcoded
- ScopeNode - spans a range (start location only)
- NetworkRequestNode - singleton
- ExternalStdioNode - singleton
- GuaranteeNode - semantic concept
- IssueNode - column is optional for flexibility

---

## Phase 1: Add Column to Missing Physical Nodes (4 files)

### 1.1 BranchNode.ts
**File:** `/Users/vadimr/grafema/packages/core/src/core/nodes/BranchNode.ts`

Changes:
1. Add `column: number` to `BranchNodeRecord` interface
2. Change REQUIRED from `['branchType', 'file', 'line']` to `['branchType', 'file', 'line', 'column']`
3. Update `create()` signature to add `column: number` parameter
4. Add validation: `if (column === undefined) throw new Error('BranchNode.create: column is required');`
5. Update ID format to include column: `` `${file}:BRANCH:${branchType}:${line}:${column}${counter}` ``
6. Add `column` to return object
7. Update `createWithContext()` signature to require `location.column`
8. Add column validation in createWithContext
9. Add `column: location.column` to return object

### 1.2 CaseNode.ts
**File:** `/Users/vadimr/grafema/packages/core/src/core/nodes/CaseNode.ts`

Changes:
1. Add `column: number` to `CaseNodeRecord` interface
2. Change REQUIRED from `['file', 'line']` to `['file', 'line', 'column']`
3. Update `create()` signature to add `column: number` parameter after `line`
4. Add validation: `if (column === undefined) throw new Error('CaseNode.create: column is required');`
5. Update ID format to include column: `` `${file}:CASE:${valueName}:${line}:${column}${counter}` ``
6. Add `column` to return object
7. Update `createWithContext()` signature and add validation
8. Add `column: location.column` to return object

### 1.3 DatabaseQueryNode.ts
**File:** `/Users/vadimr/grafema/packages/core/src/core/nodes/DatabaseQueryNode.ts`

Changes:
1. Add `column: number` to `DatabaseQueryNodeRecord` interface
2. Change REQUIRED from `['name', 'file', 'line']` to `['name', 'file', 'line', 'column']`
3. Update `create()` signature to add `column: number` parameter
4. Add validation for column
5. Update ID format: `` `${file}:DATABASE_QUERY:${name}:${line}:${column}` ``
6. Add `column` to return object

---

## Phase 2: Move Column from OPTIONAL to REQUIRED (17 files)

For each file, the pattern is:
1. Move `'column'` from OPTIONAL array to REQUIRED array
2. Add validation in `create()`: `if (column === undefined) throw new Error('...column is required');`
3. Remove `|| 0` fallback in ID generation and return object
4. For `createWithContext()`: add validation `if (location.column === undefined) throw new Error(...)`
5. Change `location.column ?? 0` to `location.column` in return

**Files to update (in order):**

| # | File | REQUIRED change | Validation to add |
|---|------|-----------------|-------------------|
| 1 | VariableDeclarationNode.ts | `['name', 'file', 'line', 'column']` | `if (column === undefined) throw...` |
| 2 | CallSiteNode.ts | `['name', 'file', 'line', 'column']` | `if (column === undefined) throw...` |
| 3 | MethodCallNode.ts | `['name', 'file', 'line', 'args', 'column']` | `if (column === undefined) throw...` |
| 4 | MethodNode.ts | `['name', 'file', 'line', 'className', 'column']` | `if (column === undefined) throw...` |
| 5 | ConstructorCallNode.ts | Move from OPTIONAL to REQUIRED | Already validates via generateId |
| 6 | ConstantNode.ts | `['name', 'file', 'line', 'column']` | `if (column === undefined) throw...` |
| 7 | LiteralNode.ts | `['file', 'line', 'column']` | `if (column === undefined) throw...` |
| 8 | ImportNode.ts | `['name', 'file', 'line', 'source', 'column']` | `if (column === undefined) throw...` |
| 9 | ExportNode.ts | `['name', 'file', 'line', 'column']` | `if (column === undefined) throw...` |
| 10 | ClassNode.ts | `['name', 'file', 'line', 'column']` | `if (column === undefined) throw...` |
| 11 | InterfaceNode.ts | `['name', 'file', 'line', 'column']` | `if (column === undefined) throw...` |
| 12 | TypeNode.ts | `['name', 'file', 'line', 'column']` | `if (column === undefined) throw...` |
| 13 | EnumNode.ts | `['name', 'file', 'line', 'column']` | `if (column === undefined) throw...` |
| 14 | DecoratorNode.ts | `['name', 'file', 'line', 'targetId', 'targetType', 'column']` | `if (column === undefined) throw...` |
| 15 | ParameterNode.ts | `['name', 'file', 'line', 'functionId', 'column']` | `if (column === undefined) throw...` |
| 16 | ExpressionNode.ts | `['expressionType', 'file', 'line', 'column']` | Already validates line, add column |
| 17 | ArgumentExpressionNode.ts | Verify and update if needed | Add column validation |

---

## Phase 3: Update EventListenerNode and HttpRequestNode (2 files)

These are special cases where column is passed via options, not as a direct parameter.

### 3.1 EventListenerNode.ts
**File:** `/Users/vadimr/grafema/packages/core/src/core/nodes/EventListenerNode.ts`

Changes:
1. Add `column: number` to `EventListenerNodeRecord` interface
2. Change REQUIRED to include `'column'`: `['name', 'file', 'line', 'column']`
3. Remove `'column'` from OPTIONAL
4. Change signature: add `column: number` as required parameter (not in options)
5. Add validation for column
6. Remove `options.column || 0`, use `column` directly
7. Add `column` to return object

### 3.2 HttpRequestNode.ts
**File:** `/Users/vadimr/grafema/packages/core/src/core/nodes/HttpRequestNode.ts`

Same pattern as EventListenerNode:
1. Add `column: number` to record interface
2. Move column to REQUIRED array
3. Add column as required parameter in create()
4. Add validation
5. Update ID and return object

---

## Phase 4: Update Info Types (1 file)

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts`

Changes to Info interfaces:

| Interface | Current | Change |
|-----------|---------|--------|
| VariableDeclarationInfo | `column?: number` | `column: number` |
| CallSiteInfo | `column?: number` | `column: number` |
| MethodCallInfo | `column?: number` | `column: number` |
| EventListenerInfo | No column field | Add `column: number` |
| HttpRequestInfo | No column field | Add `column: number` |
| BranchInfo | No column field | Add `column: number` |
| CaseInfo | No column field | Add `column: number` |
| ClassDeclarationInfo | `column?: number` | `column: number` |
| InterfaceDeclarationInfo | `column?: number` | `column: number` |
| TypeAliasInfo | `column?: number` | `column: number` |
| EnumDeclarationInfo | `column?: number` | `column: number` |
| DecoratorInfo | `column?: number` | `column: number` |
| LiteralInfo | `column?: number` | `column: number` |
| LoopInfo | `column?: number` | `column: number` |
| TryBlockInfo | `column?: number` | `column: number` |
| CatchBlockInfo | `column?: number` | `column: number` |
| FinallyBlockInfo | `column?: number` | `column: number` |

---

## Phase 5: Update NodeFactory Signatures (1 file)

**File:** `/Users/vadimr/grafema/packages/core/src/core/NodeFactory.ts`

Changes to factory methods:

| Method | Current Signature | New Signature |
|--------|-------------------|---------------|
| `createBranch` | `(branchType, file, line, options)` | `(branchType, file, line, column, options)` |
| `createCase` | `(..., file, line, options)` | `(..., file, line, column, options)` |
| `createEventListener` | `(..., line, options)` with column in options | `(..., line, column, options)` |
| `createHttpRequest` | `(..., line, options)` with column in options | `(..., line, column, options)` |
| `createDatabaseQuery` | `(..., line, options)` | `(..., line, column, options)` |

Also update the corresponding Options interfaces to remove column from options where it becomes a required parameter.

---

## Phase 6: Update Analyzers to Pass Column

Search for callers and update to pass column values from AST locations.

**Key files to check:**
1. GraphBuilder - processes Info types, creates nodes
2. JSASTAnalyzer visitors - collect column from AST
3. ExpressRouteAnalyzer - creates HTTP_REQUEST nodes
4. SocketIOAnalyzer - creates EVENT_LISTENER nodes
5. FetchAnalyzer - creates HTTP_REQUEST nodes
6. Database analyzers - create DATABASE_QUERY nodes

The column value comes from Babel AST: `node.loc.start.column`

---

## Implementation Order (to avoid breaking tests)

1. **Phase 1** - Add column to BranchNode, CaseNode, DatabaseQueryNode (new fields, backward compatible)
2. **Phase 4** - Update Info types to require column (TypeScript will catch missing values)
3. **Phase 6** - Update all analyzers to pass column values
4. **Phase 3** - Update EventListenerNode, HttpRequestNode signatures
5. **Phase 2** - Move column from OPTIONAL to REQUIRED (17 files)
6. **Phase 5** - Update NodeFactory signatures

This order ensures:
- TypeScript catches missing values early (Phase 4)
- Analyzers provide values before validation enforces them (Phase 6)
- Tests keep passing throughout the process

---

## Big-O Complexity Analysis

**O(1)** for all changes:
- Adding validation check: constant time
- Moving field between arrays: constant time
- No iteration over nodes/edges
- No graph traversal
- Pure contract/signature changes

---

## Test Strategy

1. **Unit tests for each node contract:**
   - Test that create() throws when column is undefined
   - Test that valid column is included in node record
   - Test that column appears in node ID where applicable

2. **Integration tests:**
   - Run full analysis on test fixtures
   - Verify all physical nodes have column > 0 (not defaulted to 0)

3. **Test pattern (example for VariableDeclarationNode):**
```typescript
it('should throw when column is missing', () => {
  assert.throws(
    () => VariableDeclarationNode.create('x', 'test.js', 1, undefined as any),
    /column is required/
  );
});

it('should include column in node record', () => {
  const node = VariableDeclarationNode.create('x', 'test.js', 1, 5);
  assert.strictEqual(node.column, 5);
});
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Breaking existing tests | High | Medium | Run tests after each file change |
| Missing column values in analyzers | Medium | High | TypeScript will catch at compile time |
| Existing graph data becomes invalid | Low | Low | Forward-only change, read path unaffected |
| Performance regression | Very Low | Very Low | O(1) validation, negligible overhead |

---

## Critical Files for Implementation

1. `/Users/vadimr/grafema/packages/core/src/core/nodes/FunctionNode.ts` - Reference pattern (already enforces column)
2. `/Users/vadimr/grafema/packages/core/src/core/nodes/VariableDeclarationNode.ts` - Most common pattern to update
3. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts` - Info type definitions
4. `/Users/vadimr/grafema/packages/core/src/core/NodeFactory.ts` - Factory signatures
5. `/Users/vadimr/grafema/packages/core/src/core/nodes/BranchNode.ts` - Needs column field added
