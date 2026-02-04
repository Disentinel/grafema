# Rob Pike Implementation Report: REG-337

## Summary

Made `column` a REQUIRED field for all physical node types. Build passes, switch-statement test passes.

## Changes Made

### Phase 1: Added column to nodes that didn't have it (3 files)

1. **BranchNode.ts** - Added `column: number` to record, REQUIRED array, validation, create() and createWithContext()
2. **CaseNode.ts** - Added `column: number` to record, REQUIRED array, validation, create() and createWithContext()
3. **DatabaseQueryNode.ts** - Added `column: number` to record, REQUIRED array, validation, create()

### Phase 2: Updated EventListenerNode and HttpRequestNode (2 files)

1. **EventListenerNode.ts** - Added column to record, moved from OPTIONAL to REQUIRED, added column parameter to create()
2. **HttpRequestNode.ts** - Added column to record, moved from OPTIONAL to REQUIRED, added column parameter to create()

### Phase 3: Moved column from OPTIONAL to REQUIRED (15 files)

Updated the following nodes:
- VariableDeclarationNode
- CallSiteNode
- MethodCallNode
- MethodNode
- ConstructorCallNode
- ConstantNode
- LiteralNode
- ImportNode
- ExportNode
- ClassNode
- InterfaceNode
- TypeNode
- EnumNode
- DecoratorNode
- ParameterNode
- ExpressionNode
- ObjectLiteralNode
- ArrayLiteralNode

For each node:
- Moved 'column' from OPTIONAL to REQUIRED array
- Added validation: `if (column === undefined) throw new Error(...)`
- Removed `|| 0` fallback pattern
- For createWithContext(): added column validation, removed `?? 0` fallback

### Phase 4: Updated NodeFactory (1 file)

Updated factory methods:
- `createBranch` - added `column: number` parameter
- `createCase` - added `column: number` parameter
- `createEventListener` - added `column: number` parameter, removed from options
- `createHttpRequest` - added `column: number` parameter, removed from options
- `createDatabaseQuery` - added `column: number` parameter

Updated Options interfaces:
- Removed `column?: number` from EventListenerOptions
- Removed `column?: number` from HttpRequestOptions

## Decisions Made (per reviewer feedback)

1. **ID format unchanged** - Column is added to node metadata only, NOT to node IDs. This preserves backward compatibility with existing graph edges.

2. **SCOPE remains abstract** - SCOPE nodes represent ranges, not points. They don't need column.

3. **ArgumentExpressionNode not changed** - Already had column in REQUIRED.

## Verification

- Build passes: `pnpm build` ✓
- Switch-statement test passes: Tests BranchNode and CaseNode ✓

## Files Modified (22 total)

### Node contracts (20 files):
- packages/core/src/core/nodes/BranchNode.ts
- packages/core/src/core/nodes/CaseNode.ts
- packages/core/src/core/nodes/DatabaseQueryNode.ts
- packages/core/src/core/nodes/EventListenerNode.ts
- packages/core/src/core/nodes/HttpRequestNode.ts
- packages/core/src/core/nodes/VariableDeclarationNode.ts
- packages/core/src/core/nodes/CallSiteNode.ts
- packages/core/src/core/nodes/MethodCallNode.ts
- packages/core/src/core/nodes/MethodNode.ts
- packages/core/src/core/nodes/ConstructorCallNode.ts
- packages/core/src/core/nodes/ConstantNode.ts
- packages/core/src/core/nodes/LiteralNode.ts
- packages/core/src/core/nodes/ImportNode.ts
- packages/core/src/core/nodes/ExportNode.ts
- packages/core/src/core/nodes/ClassNode.ts
- packages/core/src/core/nodes/InterfaceNode.ts
- packages/core/src/core/nodes/TypeNode.ts
- packages/core/src/core/nodes/EnumNode.ts
- packages/core/src/core/nodes/DecoratorNode.ts
- packages/core/src/core/nodes/ParameterNode.ts
- packages/core/src/core/nodes/ExpressionNode.ts
- packages/core/src/core/nodes/ObjectLiteralNode.ts
- packages/core/src/core/nodes/ArrayLiteralNode.ts

### Factory (1 file):
- packages/core/src/core/NodeFactory.ts

## Not Changed (as intended)

- ScopeNode - abstract node (spans range)
- ServiceNode, ModuleNode, ExternalModuleNode, EntrypointNode - abstract nodes (line: 0)
- NetworkRequestNode, ExternalStdioNode - singletons
- IssueNode, GuaranteeNode - semantic nodes
