# Phase 3 and Phase 4 Status Report

## Phase 3 Completion: Node Contracts Updated

All core node types now have `createWithContext()` methods for semantic IDs:

### Updated Node Contracts (8 total)

**Core nodes (Phase 2):**
1. `FunctionNode.ts` - 29 tests
2. `CallSiteNode.ts` - 19 tests
3. `MethodCallNode.ts` - 14 tests
4. `ScopeNode.ts` - 20 tests

**Additional nodes (Phase 3):**
5. `ClassNode.ts` - 12 tests
6. `MethodNode.ts` - createWithContext added
7. `ExportNode.ts` - createWithContext added
8. `VariableDeclarationNode.ts` - createWithContext added

### New Exports in `/packages/core/src/index.ts`
```typescript
export { ClassNode } from './core/nodes/ClassNode.js';
export { MethodNode } from './core/nodes/MethodNode.js';
export { ExportNode } from './core/nodes/ExportNode.js';
export { VariableDeclarationNode } from './core/nodes/VariableDeclarationNode.js';
```

### Test Summary
- **Total tests passing**: 171+
- **Build**: Successful
- **No regressions**: Legacy `create()` methods unchanged

---

## Phase 4 Analysis: GraphBuilder Integration

### Current Architecture

The GraphBuilder receives node data from AST visitors in `ASTCollections` format:

```typescript
interface ASTCollections {
  functions: FunctionInfo[];
  parameters: ParameterInfo[];
  scopes: ScopeInfo[];
  variableDeclarations: VariableDeclarationInfo[];
  callSites: CallSiteInfo[];
  methodCalls: MethodCallInfo[];
  // ... 15+ more collection types
}
```

Node IDs are currently generated inline in GraphBuilder using line-based format:
```typescript
const importId = `${module.file}:IMPORT:${source}:${spec.local}:${line}`;
```

### Integration Strategy

To fully integrate semantic IDs into the analysis pipeline:

1. **Update ScopeContext propagation**
   - Add `ScopeTracker` to visitor context
   - Pass context through AST traversal

2. **Update AST collectors**
   - Each collector should use `ScopeTracker.getContext()`
   - Generate semantic IDs during collection, not in GraphBuilder

3. **Update visitors**
   - `FunctionVisitor` - use `FunctionNode.createWithContext()`
   - `CallExpressionVisitor` - use `CallSiteNode.createWithContext()` / `MethodCallNode.createWithContext()`
   - `ScopeVisitor` - use `ScopeNode.createWithContext()`
   - etc.

4. **Update GraphBuilder**
   - Remove inline ID generation
   - Use pre-computed IDs from collections
   - Maintain batching optimization

### Complexity Assessment

Phase 4 integration is substantial:
- 15+ visitor files to update
- GraphBuilder refactoring (~1400 lines)
- Risk of breaking existing analysis
- Requires comprehensive integration tests

### Recommendation

**Phase 4 should be a separate task** (new Linear issue) because:
1. Node contracts are ready and tested
2. Current work provides foundation for integration
3. Integration requires careful planning and testing
4. Incremental approach reduces risk

---

## Completed Work Summary

### Files Modified
1. `/packages/core/src/core/nodes/FunctionNode.ts`
2. `/packages/core/src/core/nodes/CallSiteNode.ts`
3. `/packages/core/src/core/nodes/MethodCallNode.ts`
4. `/packages/core/src/core/nodes/ScopeNode.ts`
5. `/packages/core/src/core/nodes/ClassNode.ts`
6. `/packages/core/src/core/nodes/MethodNode.ts`
7. `/packages/core/src/core/nodes/ExportNode.ts`
8. `/packages/core/src/core/nodes/VariableDeclarationNode.ts`
9. `/packages/core/src/index.ts` (exports)

### Files Created
1. `/test/unit/FunctionNodeSemanticId.test.js`
2. `/test/unit/CallSiteNodeSemanticId.test.js`
3. `/test/unit/MethodCallNodeSemanticId.test.js`
4. `/test/unit/ScopeNodeSemanticId.test.js`
5. `/test/unit/ClassNodeSemanticId.test.js`

### API Pattern

All updated node contracts follow the same pattern:

```typescript
class XxxNode {
  // Legacy API - unchanged
  static create(...): XxxNodeRecord { ... }

  // NEW API - semantic IDs
  static createWithContext(
    name: string,
    context: ScopeContext,     // from ScopeTracker.getContext()
    location: Partial<Location>,  // { line, column }
    options?: XxxContextOptions
  ): XxxNodeRecord { ... }

  // Validation - unchanged
  static validate(node: XxxNodeRecord): string[] { ... }
}
```

### Semantic ID Formats

| Node Type | Format |
|-----------|--------|
| FUNCTION | `{file}->{scope_path}->FUNCTION->{name}` |
| CALL | `{file}->{scope_path}->CALL->{callee}#N` |
| METHOD_CALL | `{file}->{scope_path}->CALL->{obj.method}#N` |
| SCOPE | `{file}->{scope_path}->SCOPE->{scopeType}#N` |
| CLASS | `{file}->{scope_path}->CLASS->{name}` |
| METHOD | `{file}->{className}->METHOD->{name}` |
| EXPORT | `{file}->global->EXPORT->{name}` |
| VARIABLE | `{file}->{scope_path}->VARIABLE->{name}` |

### Next Steps

1. Create Linear issue for Phase 4 (GraphBuilder integration)
2. Document dependencies between Phase 4 subtasks
3. Consider incremental rollout by node type
