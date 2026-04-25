# Joel Spolsky - Detailed Technical Implementation Plan: REG-123 Semantic IDs Integration

## Executive Summary

Based on Don's analysis and user decisions, this plan details the exact implementation steps for integrating semantic IDs into VariableVisitor, CallExpressionVisitor, and the analysis pipeline.

**User Decisions:**
1. **Replace `id`**: Semantic ID becomes the primary `id` field (breaking change)
2. **Full scope path**: Variables include control flow scope in path
3. **Array mutations**: Track with semantic IDs

---

## Pre-Implementation Checklist (TDD)

Before ANY code changes, write these tests:

### Test File: `test/unit/VariableVisitorSemanticIds.test.js`

```javascript
/**
 * Tests for VariableVisitor semantic ID integration
 */
describe('VariableVisitor semantic ID integration', () => {
  describe('module-level variables', () => {
    it('should generate semantic ID for const at module level');
    it('should generate semantic ID for let at module level');
    it('should generate semantic ID for var at module level');
    it('should use global scope for module-level variables');
  });

  describe('function-scoped variables', () => {
    it('should include function name in scope path');
    it('should include control flow in scope path (if)');
    it('should include control flow in scope path (for/while/try)');
    it('should handle nested control flow scopes');
  });

  describe('stability', () => {
    it('same code should produce same IDs');
    it('adding unrelated code should not change existing variable IDs');
    it('line number changes should not affect IDs');
  });

  describe('discriminators', () => {
    it('should use discriminator for same-named variables in same scope');
    it('should NOT use discriminator when names are unique');
  });
});
```

### Test File: `test/unit/CallExpressionVisitorSemanticIds.test.js`

```javascript
/**
 * Tests for CallExpressionVisitor semantic ID integration
 */
describe('CallExpressionVisitor semantic ID integration', () => {
  describe('direct calls', () => {
    it('should generate semantic ID for function call');
    it('should use discriminator for multiple calls to same function');
    it('should track calls across control flow branches');
  });

  describe('method calls', () => {
    it('should generate semantic ID with object.method name');
    it('should use discriminator for same method calls');
    it('should include scope path for nested method calls');
  });

  describe('constructor calls (new)', () => {
    it('should generate semantic ID for new expression');
  });

  describe('array mutations', () => {
    it('should generate semantic ID for array.push()');
    it('should generate semantic ID for array.unshift()');
    it('should generate semantic ID for array.splice()');
    it('should generate semantic ID for indexed assignment');
  });

  describe('stability', () => {
    it('same code should produce same call IDs');
    it('call order in same scope determines discriminator');
  });
});
```

### Test File: `test/unit/SemanticIdPipelineIntegration.test.js`

```javascript
/**
 * Integration tests for full semantic ID pipeline
 */
describe('Semantic ID Pipeline Integration', () => {
  it('should pass ScopeTracker through entire analysis');
  it('should preserve semantic IDs through GraphBuilder');
  it('should use semantic ID as primary id field');
  it('should generate correct IDs for complex nested code');
});
```

---

## Phase 1: VariableVisitor Integration

### 1.1 Add ScopeTracker Parameter to Constructor

**File:** `/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`

**Location:** Lines 100-119 (constructor)

**Current:**
```typescript
export class VariableVisitor extends ASTVisitor {
  private extractVariableNamesFromPattern: ExtractVariableNamesCallback;
  private trackVariableAssignment: TrackVariableAssignmentCallback;

  constructor(
    module: VisitorModule,
    collections: VisitorCollections,
    extractVariableNamesFromPattern: ExtractVariableNamesCallback,
    trackVariableAssignment: TrackVariableAssignmentCallback
  ) {
    super(module, collections);
    this.extractVariableNamesFromPattern = extractVariableNamesFromPattern;
    this.trackVariableAssignment = trackVariableAssignment;
  }
```

**Change to:**
```typescript
import { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';

export class VariableVisitor extends ASTVisitor {
  private extractVariableNamesFromPattern: ExtractVariableNamesCallback;
  private trackVariableAssignment: TrackVariableAssignmentCallback;
  private scopeTracker?: ScopeTracker;

  constructor(
    module: VisitorModule,
    collections: VisitorCollections,
    extractVariableNamesFromPattern: ExtractVariableNamesCallback,
    trackVariableAssignment: TrackVariableAssignmentCallback,
    scopeTracker?: ScopeTracker
  ) {
    super(module, collections);
    this.extractVariableNamesFromPattern = extractVariableNamesFromPattern;
    this.trackVariableAssignment = trackVariableAssignment;
    this.scopeTracker = scopeTracker;
  }
```

### 1.2 Update Variable ID Generation

**File:** `/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`

**Location:** Lines 145-156 (inside VariableDeclaration handler)

**Current ID generation:**
```typescript
const varId = shouldBeConstant
  ? `CONSTANT#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${(varDeclCounterRef as CounterRef).value++}`
  : `VARIABLE#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${(varDeclCounterRef as CounterRef).value++}`;
```

**Change to:**
```typescript
const scopeTracker = this.scopeTracker;
const nodeType = shouldBeConstant ? 'CONSTANT' : 'VARIABLE';

// Generate semantic ID (primary) and legacy ID (fallback)
const legacyId = `${nodeType}#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${(varDeclCounterRef as CounterRef).value++}`;

const varId = scopeTracker
  ? computeSemanticId(nodeType, varInfo.name, scopeTracker.getContext())
  : legacyId;
```

### 1.3 Update VariableDeclarationInfo Interface

**File:** `/packages/core/src/plugins/analysis/ast/types.ts`

**Location:** Lines 67-78 (VariableDeclarationInfo interface)

The interface already has `semanticId?: string` - we now use `id` as the semantic ID directly (per user decision).

**No change needed** - the `id` field will now contain the semantic ID.

---

## Phase 2: CallExpressionVisitor Integration

### 2.1 Add ScopeTracker Parameter to Constructor

**File:** `/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Location:** Lines 180-183 (constructor)

**Current:**
```typescript
export class CallExpressionVisitor extends ASTVisitor {
  constructor(module: VisitorModule, collections: VisitorCollections) {
    super(module, collections);
  }
```

**Change to:**
```typescript
import { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';

export class CallExpressionVisitor extends ASTVisitor {
  private scopeTracker?: ScopeTracker;

  constructor(module: VisitorModule, collections: VisitorCollections, scopeTracker?: ScopeTracker) {
    super(module, collections);
    this.scopeTracker = scopeTracker;
  }
```

### 2.2 Update Direct Call ID Generation

**File:** `/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Location:** Lines 893-906 (CallExpression handler for Identifier callee)

**Current:**
```typescript
if (callNode.callee.type === 'Identifier') {
  const callee = callNode.callee as Identifier;
  const callId = `CALL#${callee.name}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`;

  (callSites as CallSiteInfo[]).push({
    id: callId,
    type: 'CALL',
    ...
  });
```

**Change to:**
```typescript
if (callNode.callee.type === 'Identifier') {
  const callee = callNode.callee as Identifier;
  const scopeTracker = this.scopeTracker;

  // Generate semantic ID with discriminator for same-named calls
  const legacyId = `CALL#${callee.name}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`;

  let callId = legacyId;
  if (scopeTracker) {
    const discriminator = scopeTracker.getItemCounter(`CALL:${callee.name}`);
    callId = computeSemanticId('CALL', callee.name, scopeTracker.getContext(), { discriminator });
  }

  (callSites as CallSiteInfo[]).push({
    id: callId,
    type: 'CALL',
    ...
  });
```

### 2.3 Update Method Call ID Generation

**File:** `/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Location:** Lines 959-982 (MemberExpression method calls)

**Current:**
```typescript
const fullName = `${objectName}.${methodName}`;
const methodCallId = `CALL#${fullName}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`;
```

**Change to:**
```typescript
const fullName = `${objectName}.${methodName}`;
const scopeTracker = this.scopeTracker;

const legacyId = `CALL#${fullName}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`;

let methodCallId = legacyId;
if (scopeTracker) {
  const discriminator = scopeTracker.getItemCounter(`CALL:${fullName}`);
  methodCallId = computeSemanticId('CALL', fullName, scopeTracker.getContext(), { discriminator });
}
```

### 2.4 Update Constructor Call (NewExpression) ID Generation

**File:** `/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Location:** Lines 1036-1077 (NewExpression handler)

Apply same pattern:
```typescript
const scopeTracker = this.scopeTracker;
let callId = legacyId;
if (scopeTracker) {
  const discriminator = scopeTracker.getItemCounter(`CALL:new:${constructorName}`);
  callId = computeSemanticId('CALL', `new:${constructorName}`, scopeTracker.getContext(), { discriminator });
}
```

### 2.5 Update Array Mutation Detection

**File:** `/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Location:** Lines 774-840 (detectArrayMutation method)

Add semantic ID to ArrayMutationInfo:
```typescript
private detectArrayMutation(
  callNode: CallExpression,
  arrayName: string,
  method: 'push' | 'unshift' | 'splice',
  module: VisitorModule
): void {
  // ... existing code ...

  const scopeTracker = this.scopeTracker;
  let mutationId: string | undefined;
  if (scopeTracker) {
    const discriminator = scopeTracker.getItemCounter(`ARRAY_MUTATION:${arrayName}.${method}`);
    mutationId = computeSemanticId('ARRAY_MUTATION', `${arrayName}.${method}`, scopeTracker.getContext(), { discriminator });
  }

  arrayMutations.push({
    id: mutationId,  // Add to interface
    arrayName,
    mutationMethod: method,
    // ... rest
  });
}
```

---

## Phase 3: Analysis Pipeline Integration

### 3.1 Update JSASTAnalyzer Variable Visitor Instantiation

**File:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** Lines 805-811 (VariableVisitor creation)

**Current:**
```typescript
const variableVisitor = new VariableVisitor(
  module,
  { variableDeclarations, classInstantiations, literals, variableAssignments, varDeclCounterRef, literalCounterRef },
  this.extractVariableNamesFromPattern.bind(this),
  this.trackVariableAssignment.bind(this) as TrackVariableAssignmentCallback
);
```

**Change to:**
```typescript
const variableVisitor = new VariableVisitor(
  module,
  { variableDeclarations, classInstantiations, literals, variableAssignments, varDeclCounterRef, literalCounterRef },
  this.extractVariableNamesFromPattern.bind(this),
  this.trackVariableAssignment.bind(this) as TrackVariableAssignmentCallback,
  scopeTracker  // Pass ScopeTracker
);
```

### 3.2 Update JSASTAnalyzer CallExpressionVisitor Instantiation

**File:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** Lines 990-992 (CallExpressionVisitor creation)

**Current:**
```typescript
const callExpressionVisitor = new CallExpressionVisitor(module, allCollections);
```

**Change to:**
```typescript
const callExpressionVisitor = new CallExpressionVisitor(module, allCollections, scopeTracker);
```

### 3.3 Pass ScopeTracker to analyzeFunctionBody

The `analyzeFunctionBody` method (lines 1128-1733) needs access to ScopeTracker for variables/calls inside functions.

**Current signature:**
```typescript
analyzeFunctionBody(
  funcPath: NodePath<t.Function>,
  parentScopeId: string,
  module: VisitorModule,
  collections: VisitorCollections,
  scopeCtx?: ScopeContext
): void
```

**Add ScopeTracker to collections or pass separately:**

Option A (recommended): Pass through collections
```typescript
const allCollections: Collections = {
  // ... existing
  scopeTracker,  // Add to collections interface
};
```

Option B: Add as parameter
```typescript
analyzeFunctionBody(
  funcPath: NodePath<t.Function>,
  parentScopeId: string,
  module: VisitorModule,
  collections: VisitorCollections,
  scopeCtx?: ScopeContext,
  scopeTracker?: ScopeTracker
): void
```

### 3.4 Update Variable ID Generation in analyzeFunctionBody

**File:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** Lines 1175-1242 (VariableDeclaration handler inside analyzeFunctionBody)

**Current:**
```typescript
const varId = shouldBeConstant
  ? `CONSTANT#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${varDeclCounterRef.value++}`
  : `VARIABLE#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${varDeclCounterRef.value++}`;
```

**Change to:**
```typescript
const scopeTracker = collections.scopeTracker as ScopeTracker | undefined;
const nodeType = shouldBeConstant ? 'CONSTANT' : 'VARIABLE';
const legacyId = `${nodeType}#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${varDeclCounterRef.value++}`;

const varId = scopeTracker
  ? computeSemanticId(nodeType, varInfo.name, scopeTracker.getContext())
  : legacyId;
```

### 3.5 Update Call ID Generation in analyzeFunctionBody

Similar updates needed for all CallExpression handlers inside analyzeFunctionBody (lines 1564-1705).

---

## Phase 4: GraphBuilder Updates

### 4.1 Node Buffering - Use Semantic ID as Primary ID

**File:** `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

The GraphBuilder already receives data from visitors. Since we're now generating semantic IDs as the primary `id` field in visitors, **no changes needed in GraphBuilder** - it will naturally use the new IDs.

### 4.2 Verify Edge References

**Important:** All edge references use `id` field. Since we're replacing `id` with semantic ID, edges will automatically reference the new IDs.

**Verify these methods work correctly:**
- `bufferFunctionEdges` (line 238)
- `bufferScopeEdges` (line 260)
- `bufferVariableEdges` (line 307)
- `bufferCallSiteEdges` (line 320)

---

## Phase 5: Type Updates

### 5.1 Update ASTCollections Interface

**File:** `/packages/core/src/plugins/analysis/ast/types.ts`

**Add scopeTracker to collections:**
```typescript
export interface ASTCollections {
  // ... existing fields
  scopeTracker?: import('../../../../core/ScopeTracker.js').ScopeTracker;
}
```

### 5.2 Update ArrayMutationInfo Interface

**File:** `/packages/core/src/plugins/analysis/ast/types.ts`

**Location:** Lines 360-375

**Add id field:**
```typescript
export interface ArrayMutationInfo {
  id?: string;  // Add semantic ID
  arrayName: string;
  arrayLine?: number;
  mutationMethod: 'push' | 'unshift' | 'splice' | 'indexed';
  // ... rest unchanged
}
```

---

## Implementation Order (Dependencies)

```
1. Test Files (TDD - write first!)
   ├── test/unit/VariableVisitorSemanticIds.test.js
   ├── test/unit/CallExpressionVisitorSemanticIds.test.js
   └── test/unit/SemanticIdPipelineIntegration.test.js

2. Type Updates (no dependencies)
   └── /packages/core/src/plugins/analysis/ast/types.ts

3. VariableVisitor Integration
   └── /packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts

4. CallExpressionVisitor Integration
   └── /packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts

5. JSASTAnalyzer Pipeline Integration
   └── /packages/core/src/plugins/analysis/JSASTAnalyzer.ts

6. GraphBuilder Verification (no changes expected)
   └── /packages/core/src/plugins/analysis/ast/GraphBuilder.ts

7. Run Full Test Suite
```

---

## Breaking Change Handling

### What Changes

1. **Node IDs**: All VARIABLE, CONSTANT, CALL IDs change format from:
   - `VARIABLE#name#file#line:col:counter`
   - to `file->scope->VARIABLE->name`

2. **Edge References**: All edges reference these IDs - they will update automatically.

3. **Queries**: Any code querying by ID pattern needs updating.

### Migration Path

1. Run `grafema analyze --clear` to regenerate all nodes with new IDs
2. Existing stored graphs are invalidated - must re-analyze
3. No backward compatibility maintained (per user decision)

---

## Post-Implementation Verification

1. **Run Unit Tests:**
   ```bash
   node --test test/unit/VariableVisitorSemanticIds.test.js
   node --test test/unit/CallExpressionVisitorSemanticIds.test.js
   node --test test/unit/SemanticIdPipelineIntegration.test.js
   node --test test/unit/SemanticId.test.js
   ```

2. **Run Full Test Suite:**
   ```bash
   npm test
   ```

3. **Verify ID Stability:**
   - Analyze same file twice
   - Compare node IDs - should be identical
   - Add empty line to file
   - Re-analyze - IDs should NOT change

4. **Manual Verification:**
   ```bash
   grafema analyze --clear test/fixtures/simple-module.js
   grafema query "MATCH (v:VARIABLE) RETURN v.id LIMIT 5"
   ```

   IDs should follow format: `file->scope->VARIABLE->name`

---

## Files Modified Summary

| File | Changes |
|------|---------|
| `packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts` | Add ScopeTracker, update ID generation |
| `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts` | Add ScopeTracker, update ID generation |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Pass ScopeTracker to visitors, update analyzeFunctionBody |
| `packages/core/src/plugins/analysis/ast/types.ts` | Add scopeTracker to ASTCollections, id to ArrayMutationInfo |
| `test/unit/VariableVisitorSemanticIds.test.js` | NEW - tests |
| `test/unit/CallExpressionVisitorSemanticIds.test.js` | NEW - tests |
| `test/unit/SemanticIdPipelineIntegration.test.js` | NEW - tests |

---

## Risk Mitigation

1. **Test First**: All tests written before implementation
2. **Incremental Changes**: One visitor at a time
3. **Backward Compatibility in Tests**: Keep some tests for legacy ID format to detect regressions
4. **CI Pipeline**: Full test suite must pass before merge

---

## Estimated Effort

- **Test Writing**: 2-3 hours
- **VariableVisitor**: 1 hour
- **CallExpressionVisitor**: 1.5 hours
- **JSASTAnalyzer Integration**: 1.5 hours
- **Verification & Debugging**: 1 hour

**Total**: ~7-8 hours
