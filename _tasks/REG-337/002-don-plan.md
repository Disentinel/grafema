# Don Melton's Analysis: REG-337 - Add Column Location to Physical Nodes

## Executive Summary

This task requires making `column` a required field for physical code nodes (nodes that represent specific code locations), while keeping it optional for abstract/semantic nodes. The architecture already supports this pattern, but enforcement is inconsistent.

## Current Architecture Analysis

### 1. Node Contract System

Nodes are defined in `/Users/vadimr/grafema/packages/core/src/core/nodes/*.ts` with:
- A static `REQUIRED` array listing required fields
- A static `OPTIONAL` array listing optional fields
- A `validate()` method that checks REQUIRED fields

**Current State (column classification):**

| Node Type | REQUIRED Contains | OPTIONAL Contains | Column in Record Type | Column in create() |
|-----------|-------------------|-------------------|----------------------|-------------------|
| FunctionNode | `['name', 'file', 'line', 'column']` | (no column) | Yes, required | Yes, validated |
| VariableDeclarationNode | `['name', 'file', 'line']` | `['column', ...]` | Yes, required in interface | Defaults to `0` |
| CallSiteNode | `['name', 'file', 'line']` | `['column', ...]` | Yes | Defaults to `0` |
| ConstantNode | `['name', 'file', 'line']` | `['column', ...]` | Yes | Defaults to `0` |
| LiteralNode | `['file', 'line']` | `['column', ...]` | Yes | Defaults to `0` |
| ImportNode | `['name', 'file', 'line', 'source']` | `['column', ...]` | Yes | Defaults to `0` |
| ExportNode | `['name', 'file', 'line']` | `['column', ...]` | Yes | Defaults to `0` |
| ClassNode | `['name', 'file', 'line']` | `['column', ...]` | Yes | Defaults to `0` |
| ScopeNode | `['scopeType', 'file', 'line']` | (no column) | No | N/A |
| BranchNode | `['branchType', 'file', 'line']` | (no column) | No | N/A |
| CaseNode | `['file', 'line']` | (no column) | No | N/A |
| EventListenerNode | `['name', 'file', 'line']` | `['column', ...]` | No in record | Via options |
| HttpRequestNode | `['name', 'file', 'line']` | `['column', ...]` | No in record | Via options |
| DatabaseQueryNode | `['name', 'file', 'line']` | (no column) | No | N/A |
| ParameterNode | `['name', 'file', 'line', 'functionId']` | `['column', ...]` | Yes | Defaults to `0` |

### 2. NodeFactory

The `NodeFactory` class (`/Users/vadimr/grafema/packages/core/src/core/NodeFactory.ts`) delegates to individual node contracts. It has a `validate()` method that dispatches to the appropriate node class validator.

**Key insight:** FunctionNode is the ONLY node type that currently enforces column as required:
```typescript
static readonly REQUIRED = ['name', 'file', 'line', 'column'] as const;
```

### 3. Info Types (AST Analysis)

`/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts` defines the info types used during AST analysis. These are collected by visitors and processed by GraphBuilder.

**Current state:**
- `VariableDeclarationInfo.column?: number` - Optional
- `CallSiteInfo.column?: number` - Optional
- `MethodCallInfo.column?: number` - Optional
- `EventListenerInfo` - No column field
- `HttpRequestInfo` - No column field

### 4. Abstract/Semantic Nodes (Should NOT require column)

These nodes don't represent specific code points:
- **ServiceNode**: `line: 0` hardcoded, no physical location
- **ExternalModuleNode**: `line: 0` hardcoded, no physical location
- **ModuleNode**: `line: 0` hardcoded, file-level concept
- **NetworkRequestNode**: Singleton `net:request`, no physical location
- **ExternalStdioNode**: Singleton `net:stdio`, no physical location
- **ScopeNode**: Spans a range, not a point
- **IssueNode**: Points to detected problems, column is optional for reporting flexibility

## Recommended Approach

### Phase 1: Define Physical vs Abstract Node Categories

Create a new abstraction in `/Users/vadimr/grafema/packages/core/src/core/nodes/NodeKind.ts`:

```typescript
// Physical nodes - represent specific code points, MUST have column
export const PHYSICAL_NODE_TYPES = [
  'FUNCTION',
  'VARIABLE_DECLARATION',
  'CONSTANT',
  'LITERAL',
  'CALL_SITE',
  'METHOD_CALL',
  'CONSTRUCTOR_CALL',
  'OBJECT_LITERAL',
  'ARRAY_LITERAL',
  'EXPRESSION',
  'CLASS',
  'INTERFACE',
  'TYPE',
  'ENUM',
  'IMPORT',
  'EXPORT',
  'DECORATOR',
  'EVENT_LISTENER',
  'HTTP_REQUEST',
  'DATABASE_QUERY',
  'PARAMETER',
  'BRANCH',    // Points to start of branch keyword
  'CASE',      // Points to case keyword
] as const;

// Abstract nodes - don't represent specific code points
export const ABSTRACT_NODE_TYPES = [
  'SERVICE',
  'ENTRYPOINT',
  'MODULE',
  'EXTERNAL_MODULE',
  'SCOPE',
  'net:request',
  'net:stdio',
] as const;

// Issue nodes have optional column (for reporting flexibility)
export function isPhysicalNodeType(type: string): boolean;
```

### Phase 2: Update Node Contracts (19+ Files)

For each physical node type, update the contract:

1. Move `'column'` from `OPTIONAL` to `REQUIRED` array
2. Add validation in `create()`: `if (column === undefined) throw new Error(...)`
3. Remove `|| 0` fallback pattern
4. Update TypeScript interface to mark `column: number` (not optional)

**Files to modify:**
1. `VariableDeclarationNode.ts` - Move column to REQUIRED
2. `ConstantNode.ts` - Move column to REQUIRED
3. `LiteralNode.ts` - Move column to REQUIRED
4. `CallSiteNode.ts` - Move column to REQUIRED
5. `MethodCallNode.ts` - Move column to REQUIRED
6. `ConstructorCallNode.ts` - Already has column, verify REQUIRED
7. `ObjectLiteralNode.ts` - Move column to REQUIRED
8. `ArrayLiteralNode.ts` - Move column to REQUIRED
9. `ExpressionNode.ts` - Move column to REQUIRED
10. `ClassNode.ts` - Move column to REQUIRED
11. `InterfaceNode.ts` - Move column to REQUIRED
12. `TypeNode.ts` - Move column to REQUIRED
13. `EnumNode.ts` - Move column to REQUIRED
14. `ImportNode.ts` - Move column to REQUIRED
15. `ExportNode.ts` - Move column to REQUIRED
16. `DecoratorNode.ts` - Move column to REQUIRED
17. `EventListenerNode.ts` - Add column to record, move to REQUIRED
18. `HttpRequestNode.ts` - Add column to record, move to REQUIRED
19. `DatabaseQueryNode.ts` - Add column field, move to REQUIRED
20. `ParameterNode.ts` - Move column to REQUIRED
21. `BranchNode.ts` - Add column field, move to REQUIRED
22. `CaseNode.ts` - Add column field, move to REQUIRED

### Phase 3: Update Info Types

Update `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts`:

1. `VariableDeclarationInfo.column` - Make required (remove `?`)
2. `CallSiteInfo.column` - Make required
3. `MethodCallInfo.column` - Make required
4. `EventListenerInfo` - Add `column: number`
5. `HttpRequestInfo` - Add `column: number`
6. `BranchInfo` - Add `column: number`
7. `CaseInfo` - Add `column: number`
8. `DatabaseQueryInfo` - Doesn't exist; uses HttpRequestInfo pattern

### Phase 4: Update Analyzers to Pass Column

Check and update any analyzers that create nodes:
1. JSASTAnalyzer (via visitors) - Most already pass column from AST `loc.start.column`
2. ExpressAnalyzer - Check http request/event listener creation
3. SocketIOAnalyzer - Check event listener creation
4. FetchAnalyzer - Check http request creation
5. DatabaseAnalyzer - Check db query creation
6. SQLiteAnalyzer - Check db query creation

### Phase 5: Update NodeFactory Signatures

Update `/Users/vadimr/grafema/packages/core/src/core/NodeFactory.ts`:
- `createScope()` - Keep without column (abstract node)
- `createBranch()` - Add column parameter
- `createCase()` - Add column parameter
- `createEventListener()` - Move column from options to required parameter
- `createHttpRequest()` - Move column from options to required parameter
- `createDatabaseQuery()` - Add column parameter

### Phase 6: Add Centralized Validation

Add to `NodeFactory.validate()`:
```typescript
static validate(node: BaseNodeRecord): string[] {
  // Existing per-type validation...

  // Physical node column check
  if (isPhysicalNodeType(node.type)) {
    if (node.column === undefined || node.column === null) {
      errors.push(`Physical node ${node.type} requires column field`);
    }
  }
}
```

## Risks and Mitigations

### Risk 1: Breaking Existing Graph Data
**Mitigation:** This is a forward-only change. Existing graphs will still work for reading. New analysis runs will generate proper column values.

### Risk 2: AST Missing Location Info
**Mitigation:** Babel AST always provides `loc.start.column`. If undefined, we should fail analysis early rather than silently defaulting to 0.

### Risk 3: Performance Impact
**Mitigation:** None - column is already captured in AST, just not always stored.

## Testing Strategy

1. Run existing test suite after each file change
2. Add specific tests for column validation:
   - Test that physical nodes throw on missing column
   - Test that abstract nodes accept missing column
3. Run full analysis on test projects to verify no regressions

## Order of Implementation

1. **NodeKind.ts** - Add `PHYSICAL_NODE_TYPES` and `isPhysicalNodeType()` helper
2. **Node contracts** - Update REQUIRED arrays and validate() methods (one by one)
3. **types.ts** - Update Info types
4. **NodeFactory.ts** - Update signatures and add centralized validation
5. **Analyzers** - Update to pass column values
6. **Tests** - Add validation tests

## Critical Files for Implementation

- `/Users/vadimr/grafema/packages/core/src/core/nodes/NodeKind.ts` - Add physical node type classification (NEW)
- `/Users/vadimr/grafema/packages/core/src/core/nodes/VariableDeclarationNode.ts` - Example pattern for updating contracts
- `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts` - Update Info type definitions
- `/Users/vadimr/grafema/packages/core/src/core/NodeFactory.ts` - Update factory signatures and add centralized validation
- `/Users/vadimr/grafema/packages/core/src/core/nodes/FunctionNode.ts` - Reference pattern (already enforces column)
