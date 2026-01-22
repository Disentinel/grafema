# Don Melton - Tech Lead Analysis: REG-123 Semantic IDs Integration

## Current State Analysis

### Infrastructure Already Built (Working)

1. **SemanticId.ts** (`/packages/core/src/core/SemanticId.ts`)
   - `computeSemanticId()` function with format: `{file}->{scope_path}->{type}->{name}[#discriminator]`
   - `parseSemanticId()` for reverse parsing
   - `computeDiscriminator()` for handling same-named items
   - `ScopeContext` interface: `{ file: string; scopePath: string[] }`
   - Proper handling of singletons and external modules

2. **ScopeTracker.ts** (`/packages/core/src/core/ScopeTracker.ts`)
   - Maintains scope stack during AST traversal
   - `enterScope()` / `exitScope()` for named scopes
   - `enterCountedScope()` for control flow (if#0, try#1)
   - `getContext()` returns `ScopeContext` for semantic ID generation
   - `getItemCounter()` for discriminators (CALL#0, CALL#1)
   - `getSiblingIndex()` for anonymous functions

3. **Node Contracts with `createWithContext()`**
   - `FunctionNode.createWithContext()` - FULLY IMPLEMENTED
   - `VariableDeclarationNode.createWithContext()` - FULLY IMPLEMENTED
   - `CallSiteNode.createWithContext()` - FULLY IMPLEMENTED
   - All contracts support both legacy `create()` and new `createWithContext()`

### Visitors with Semantic ID Integration (Partial)

1. **FunctionVisitor** - INTEGRATED
   - Uses `ScopeTracker` (passed in constructor)
   - Generates `stableId` via `computeSemanticId()`
   - Enters/exits scopes properly
   - Creates SCOPE nodes with semantic IDs

2. **ClassVisitor** - INTEGRATED
   - Accepts optional `ScopeTracker` in constructor
   - Generates `semanticId` for classes and methods
   - Enters class scope, then method scopes
   - Creates SCOPE nodes with semantic IDs

3. **TypeScriptVisitor** - INTEGRATED
   - Accepts optional `ScopeTracker` in constructor
   - Generates `semanticId` for interfaces, types, enums

### Visitors WITHOUT Semantic ID Integration (GAP)

1. **VariableVisitor** - NOT INTEGRATED
   - Does NOT accept `ScopeTracker` in constructor
   - Generates OLD format IDs: `VARIABLE#name#file#line:col:counter`
   - No semantic ID field on output
   - Does NOT track scope context

2. **CallExpressionVisitor** - NOT INTEGRATED
   - Does NOT accept `ScopeTracker` in constructor
   - Generates OLD format IDs: `CALL#name#file#line:col:counter`
   - No semantic ID field on output
   - `getFunctionScopeId()` uses line-based IDs

3. **ImportExportVisitor** - PARTIALLY INTEGRATED (special case)
   - ImportNode uses semantic ID format: `{file}:IMPORT:{source}:{name}` (no line)
   - This is CORRECT - imports are file-level, unique by source+name
   - No `ScopeTracker` needed (imports are always at module scope)

### GraphBuilder Analysis

The `GraphBuilder` class (`/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`):
- Currently receives raw data from visitors via `ASTCollections`
- Creates nodes using inline object creation, NOT using `NodeFactory.createWithContext()`
- Does NOT pass `ScopeTracker` through - it only receives collected data
- Node creation happens in `buffer*` methods with legacy ID format
- The `NodeFactory` is used only for specific nodes (ImportNode, ExportNode, ExternalModule)

## Gap Analysis

### Critical Gaps

1. **VariableVisitor lacks ScopeTracker integration**
   - Needs constructor parameter for ScopeTracker
   - Needs to call `getContext()` for each variable
   - Needs to use `VariableDeclarationNode.createWithContext()` or compute semantic IDs inline

2. **CallExpressionVisitor lacks ScopeTracker integration**
   - Needs constructor parameter for ScopeTracker
   - Needs to call `getItemCounter('CALL')` for discriminators
   - Same-function calls in same scope need `#0`, `#1`, etc.
   - Needs to use `CallSiteNode.createWithContext()` or compute semantic IDs inline

3. **GraphBuilder creates nodes with legacy IDs**
   - Currently just buffers what visitors provide
   - Visitors need to provide semantic IDs in their output
   - GraphBuilder should preserve semantic IDs when creating nodes

4. **ScopeTracker not passed through analysis pipeline**
   - Need to ensure ScopeTracker is created at module level
   - Need to pass it to ALL visitors that need it
   - Currently only FunctionVisitor, ClassVisitor, TypeScriptVisitor receive it

### Non-Issues (Correctly Handled)

1. **ImportExportVisitor** - Import IDs are already semantic (file-scoped, no line numbers)
2. **Node contracts** - All have `createWithContext()` methods ready
3. **SemanticId infrastructure** - Fully implemented and tested

## Architectural Considerations

### The RIGHT Approach

The semantic ID system is designed to provide **stable, line-independent identifiers** that don't change when unrelated code is added. This aligns perfectly with Grafema's vision: AI agents query the graph, not read code.

**Key insight**: Semantic IDs must be computed DURING AST traversal, not after. The `ScopeTracker` maintains state that's only valid during the traversal.

### Pattern to Follow

Looking at `FunctionVisitor` as the model:
```typescript
// 1. Accept ScopeTracker in constructor
constructor(module, collections, analyzeFunctionBody, scopeTracker?: ScopeTracker)

// 2. Get context when creating node
const stableId = scopeTracker
  ? computeSemanticId('FUNCTION', name, scopeTracker.getContext())
  : functionId;  // fallback to legacy

// 3. Include stableId in output
functions.push({ id: functionId, stableId, ... });
```

### What NOT to Do

- Do NOT refactor GraphBuilder to compute semantic IDs - it's too late at that point
- Do NOT create a separate semantic ID computation pass - defeats the purpose
- Do NOT break backward compatibility - keep legacy `id` field, add `stableId`/`semanticId`

## High-Level Plan

### Phase 1: VariableVisitor Integration

1. Add optional `ScopeTracker` parameter to constructor
2. In handler, call `scopeTracker.getContext()` for each variable
3. Compute `semanticId` using `computeSemanticId('VARIABLE', name, context)`
4. Add `semanticId` field to output (keep existing `id` for backward compat)

### Phase 2: CallExpressionVisitor Integration

1. Add optional `ScopeTracker` parameter to constructor
2. For each call site:
   - Get counter via `scopeTracker.getItemCounter('CALL')` for discriminator
   - Compute `semanticId` using `computeSemanticId('CALL', name, context, { discriminator })`
3. Add `semanticId` field to output
4. Handle method calls with `object.method` as name

### Phase 3: Analysis Pipeline Integration

1. Ensure `JSASTAnalyzer` (or equivalent) creates `ScopeTracker` at start
2. Pass `ScopeTracker` to VariableVisitor and CallExpressionVisitor
3. Verify all visitors receive and use the same tracker instance

### Phase 4: GraphBuilder Updates

1. Ensure semantic IDs from visitors are preserved in node creation
2. Update `ASTCollections` types to include optional `semanticId` fields
3. GraphBuilder should use `semanticId` as primary `id` when available

### Phase 5: Storage Layer Verification

1. Verify RFDB stores and retrieves semantic IDs correctly
2. Ensure queries can use semantic IDs
3. Test re-analysis produces identical IDs for unchanged code

### Phase 6: Testing

1. Write tests verifying semantic ID stability:
   - Same code = same IDs
   - Adding unrelated code doesn't change existing IDs
   - Line number changes don't affect IDs
2. Run full test suite to ensure no regressions

## Risks and Concerns

### Risk 1: Scope Tracking Accuracy
- **Risk**: ScopeTracker may not be in correct state when visitor runs
- **Mitigation**: Follow FunctionVisitor pattern exactly, use same traversal order

### Risk 2: Backward Compatibility
- **Risk**: Changing node IDs could break existing graphs
- **Mitigation**: Keep legacy `id` field, add separate `stableId`/`semanticId` field

### Risk 3: Discriminator Stability
- **Risk**: Call discriminators depend on encounter order, which may vary
- **Mitigation**: `computeDiscriminator()` uses line/column for stable ordering

### Risk 4: Performance
- **Risk**: Additional computation for semantic IDs
- **Mitigation**: Minimal overhead - just string concatenation, no heavy operations

## Questions for User

1. **Migration strategy**: Should existing graphs be re-analyzed to get semantic IDs, or support both ID formats during transition?

2. **Primary ID**: Should `id` field contain semantic ID (breaking change) or should we add `stableId` field (additive)?

3. **Scope granularity for variables**: Should variables inside control flow (if/for/try) get the control flow scope in their ID, or the nearest function scope?
   - Example: `src/app.js->handler->if#0->VARIABLE->temp` vs `src/app.js->handler->VARIABLE->temp`
   - FunctionVisitor currently puts control flow scopes in the path

4. **Array mutation tracking**: `CallExpressionVisitor.detectArrayMutation()` tracks mutations - should these also have semantic IDs?

## Conclusion

The infrastructure is solid. The remaining work is:
1. **Mechanical**: Add ScopeTracker to VariableVisitor and CallExpressionVisitor
2. **Integration**: Wire ScopeTracker through the analysis pipeline
3. **Preservation**: Ensure GraphBuilder preserves semantic IDs

This is the RIGHT way to do it. The semantic ID system was designed correctly - we just need to finish integrating it into all visitors.

**Estimated complexity**: Medium. Pattern is established, just needs consistent application.

**Risk level**: Low with proper testing. No architectural changes needed.
