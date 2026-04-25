# Joel Spolsky - Technical Implementation Plan: REG-205

## Executive Summary

Fix INSTANCE_OF edges to use semantic IDs by replacing hardcoded legacy format in `GraphBuilder.bufferClassNodes()` with proper semantic ID computation. This is a surgical fix to one location with low risk.

## Test Plan (TDD - Tests First!)

### Current Test Status

The test file `/Users/vadimr/grafema-worker-6/test/unit/GraphBuilderClassEdges.test.js` already exists with comprehensive coverage. However, all tests are written for the **LEGACY ID format**, expecting patterns like:

```
/path/index.js:CLASS:ClassName:0
```

These tests are currently PASSING with the buggy implementation.

### Test Strategy: Incremental Migration

**DO NOT rewrite all tests at once.** Instead:

1. **Add NEW regression test** that explicitly tests semantic ID format
2. This test will FAIL initially (expected)
3. Fix the implementation
4. New test will PASS
5. **Keep existing tests UNCHANGED** - they validate backward compatibility path

### New Test to Add

**File**: `/Users/vadimr/grafema-worker-6/test/unit/GraphBuilderClassEdges.test.js`

**Location**: Add after existing `INSTANCE_OF edges` describe block (around line 358)

**Test Case**:
```javascript
describe('INSTANCE_OF semantic IDs', () => {
  it('should create INSTANCE_OF edge with semantic ID for external class', async () => {
    await setupTest(backend, {
      'index.js': `
const service = new ExternalService();
      `
    });

    const allEdges = await backend.getAllEdges();
    const instanceOfEdge = allEdges.find(e => e.type === 'INSTANCE_OF');

    assert.ok(instanceOfEdge, 'INSTANCE_OF edge should exist');

    // SEMANTIC ID format: {file}->global->CLASS->{name}
    // NOT legacy format: {file}:CLASS:{name}:0
    assert.ok(
      instanceOfEdge.dst.includes('->global->CLASS->'),
      `dst should use semantic ID format with ->global->CLASS->. Got: ${instanceOfEdge.dst}`
    );
    assert.ok(
      instanceOfEdge.dst.includes('ExternalService'),
      'dst should reference ExternalService'
    );
    assert.ok(
      !instanceOfEdge.dst.includes(':CLASS:'),
      'dst should NOT use legacy :CLASS: separator'
    );
  });

  it('should match actual CLASS node ID when class is defined', async () => {
    await setupTest(backend, {
      'index.js': `
class SocketService {
  connect() {}
}
const service = new SocketService();
      `
    });

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    const classNode = allNodes.find(n => n.type === 'CLASS' && n.name === 'SocketService');
    const instanceOfEdge = allEdges.find(e => e.type === 'INSTANCE_OF');

    assert.ok(classNode, 'SocketService CLASS node should exist');
    assert.ok(instanceOfEdge, 'INSTANCE_OF edge should exist');

    // CRITICAL: Edge destination must match actual CLASS node ID
    assert.strictEqual(
      instanceOfEdge.dst,
      classNode.id,
      'INSTANCE_OF edge dst should match CLASS node id exactly'
    );
  });
});
```

**What this tests**:
- External class instantiation uses semantic ID format
- When class is defined in same file, edge dst matches actual CLASS node ID
- No legacy `:CLASS:` separator in semantic IDs

### Test Execution Plan

1. Add new test to file
2. Run test: `node --test test/unit/GraphBuilderClassEdges.test.js`
3. Verify it FAILS with expected error (dst doesn't match semantic format)
4. Proceed to implementation
5. After fix, run test again - should PASS
6. Run full test suite to ensure no regressions

## Implementation Steps

### Step 1: Import `computeSemanticId` in GraphBuilder

**File**: `/Users/vadimr/grafema-worker-6/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Change**: Add import at top of file (around line 1-10)

**What**:
```typescript
import { computeSemanticId } from '../../core/SemanticId.js';
```

**Why**: We need access to the semantic ID computation function to generate proper IDs for external classes.

**How to verify**: TypeScript compilation succeeds, import resolves correctly.

---

### Step 2: Replace hardcoded legacy ID with semantic ID computation

**File**: `/Users/vadimr/grafema-worker-6/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Function**: `bufferClassNodes()`

**Line**: 467 (currently reads: `classId = \`${module.file}:CLASS:${className}:0\`;`)

**Change**: Replace legacy ID string with semantic ID computation

**Before**:
```typescript
if (!classId) {
  // External class - compute ID using ClassNode format (line 0 = unknown location)
  // Assume class is in same file (most common case)
  // When class is in different file, edge will be dangling until that file analyzed
  classId = `${module.file}:CLASS:${className}:0`;

  // NO node creation - node will exist when class file analyzed
}
```

**After**:
```typescript
if (!classId) {
  // External class - compute semantic ID
  // Assume class is in same file (most common case)
  // When class is in different file, edge will be dangling until that file analyzed
  const globalContext = { file: module.file, scopePath: [] };
  classId = computeSemanticId('CLASS', className, globalContext);

  // NO node creation - node will exist when class file analyzed
}
```

**Why**:
- CLASS nodes are created by `ClassVisitor` using semantic IDs via `ClassNode.createWithContext()`
- INSTANCE_OF edges must point to the same ID format
- `computeSemanticId('CLASS', name, { file, scopePath: [] })` generates format: `{file}->global->CLASS->{name}`
- This matches the format used by `ClassNode.createWithContext()` for top-level classes

**Key insights**:
- We assume `scopePath: []` because external classes are typically top-level (global scope)
- When class is actually in a nested scope, this creates a temporary dangling edge
- `InstanceOfResolver` enrichment plugin (runs later) will resolve cross-file references properly

**How to verify**:
- Run the new test case
- Edge dst should match pattern `{file}->global->CLASS->{name}`
- No legacy `:CLASS:` separator

---

### Step 3: Review `InstanceOfResolver` for similar issues

**File**: `/Users/vadimr/grafema-worker-6/packages/core/src/plugins/enrichment/InstanceOfResolver.ts`

**What to check**: Does this plugin make assumptions about ID format?

**Analysis**:
- Line 69-76: Plugin looks for CLASS nodes with `isInstantiationRef: true` flag
- Line 123: Uses `graph.getIncomingEdges(stubId, ['INSTANCE_OF'])` to find edges
- Line 143-147: Creates new INSTANCE_OF edge with `newDst: realClassId`

**Key observation**: Plugin uses `realClassId` from `classDeclarations.get(declarationKey)` which comes from actual CLASS nodes (line 74). This means it already uses the correct ID from the actual node.

**Potential issue**: Lines 73-74 build lookup map as:
```typescript
const key = `${node.file}:${node.name}`;
classDeclarations.set(key, node.id);
```

Then line 117 does:
```typescript
const declarationKey = `${resolvedPath}:${importedClassName}`;
```

This lookup key format uses legacy-style separator `:` but only as internal map key, not as node ID. **This is fine** - it's just a lookup key, not an ID.

**Conclusion**: No changes needed to `InstanceOfResolver`. It already uses correct IDs from actual CLASS nodes.

---

## Verification Checklist

After implementation complete:

### Unit Tests
- [ ] New semantic ID test passes: `node --test test/unit/GraphBuilderClassEdges.test.js`
- [ ] All existing tests still pass (backward compatibility)
- [ ] Full test suite passes: `npm test`

### Manual Verification
- [ ] Create test file with `const x = new ExternalClass()`
- [ ] Run `grafema analyze` on test file
- [ ] Query INSTANCE_OF edges, verify dst has format: `{file}->global->CLASS->ExternalClass`
- [ ] Create test file with class definition and instantiation in same file
- [ ] Verify INSTANCE_OF edge dst exactly matches CLASS node id

### Acceptance Criteria (from Linear issue)
- [ ] INSTANCE_OF edges use semantic ID format - **FIXED by Step 2**
- [ ] Edge destination matches actual CLASS node ID - **VERIFIED by new test**
- [ ] Query "instances of class X" works - **VERIFY with manual test**
- [ ] Tests pass - **VERIFY with Step 3 of checklist**

## Edge Cases to Consider

### 1. Same-file class instantiation
**Scenario**: Class defined and instantiated in same file
```javascript
class Service {}
const s = new Service();
```

**Behavior**: `declarationMap.get(className)` will find the class (line 461), so the fixed code path (line 467) is **not executed**. Edge will use the actual CLASS node ID from the declaration map. **No impact.**

### 2. Cross-file class instantiation
**Scenario**: Class defined in one file, instantiated in another
```javascript
// socket.js
export class SocketService {}

// index.js
import { SocketService } from './socket.js';
const s = new SocketService();
```

**Behavior**: During analysis of `index.js`, the fix creates edge with semantic ID assuming global scope. Later, `InstanceOfResolver` will:
1. Find the IMPORT node
2. Resolve path to `socket.js`
3. Find actual CLASS node in `socket.js`
4. Re-create INSTANCE_OF edge with correct dst

**Impact**: Fix creates better temporary edge (semantic format), final resolution still works.

### 3. Nested scope classes
**Scenario**: Class defined inside function/closure
```javascript
function createService() {
  class LocalService {}
  return new LocalService();
}
```

**Behavior**: Our fix assumes `scopePath: []` (global). Actual class has semantic ID with scope path like `createService->CLASS->LocalService`. Edge will be dangling initially.

**Impact**: This is existing behavior (was already dangling with legacy format). `InstanceOfResolver` doesn't handle nested scopes anyway - out of scope for this fix.

### 4. Unknown line number
**Why we don't include line in semantic ID**: Semantic IDs use scope path, not line numbers. Line 0 was a legacy format artifact. Semantic IDs are stable across line changes.

## Risks & Mitigation

| Risk | Severity | Mitigation |
|------|----------|------------|
| Breaking existing queries | LOW | Tests validate edge format, no query syntax changes |
| InstanceOfResolver incompatibility | LOW | Reviewed - no changes needed, uses actual node IDs |
| Performance regression | MINIMAL | Same computation cost, just different function |
| Migration needed for existing graphs | MEDIUM | This is a bug fix - old edges were broken anyway |

## Migration Considerations

**Do existing graphs need migration?**

NO. This is a bug fix, not a format change:
- Old INSTANCE_OF edges with legacy IDs were **already broken** (pointed to non-existent nodes)
- After fix, new analysis runs will create correct edges
- No migration script needed - just re-analyze

**Timeline**: Fix can ship immediately, no migration required.

## Dependencies

**Implementation order**:
1. Step 1 (import) must complete before Step 2 (usage)
2. Step 2 must complete before Step 3 (verification)
3. Step 3 (InstanceOfResolver review) is independent validation, can happen in parallel with test writing

**No external dependencies** - all changes are internal to GraphBuilder.

## Success Metrics

After implementation:
- ✅ INSTANCE_OF edges use format: `{file}->global->CLASS->{name}`
- ✅ Same-file instantiation: edge dst matches CLASS node id exactly
- ✅ Cross-file instantiation: edge uses semantic format (InstanceOfResolver resolves later)
- ✅ All tests pass
- ✅ Zero regressions in existing functionality

## Estimated Effort

- **Test writing**: 10 minutes
- **Implementation**: 5 minutes (literally one import + one line change)
- **InstanceOfResolver review**: 10 minutes (read + document findings)
- **Verification**: 15 minutes (run tests, manual check)

**Total**: 40 minutes

## Notes for Implementation Team (Kent & Rob)

**Kent (Tests)**:
- Add new test case to `GraphBuilderClassEdges.test.js`
- Run test, verify it FAILS as expected
- DO NOT modify existing tests - they validate backward compatibility
- Report back when test is ready

**Rob (Implementation)**:
- Wait for Kent's test to be ready
- Make exactly two changes: add import, replace one line
- DO NOT refactor surrounding code (tempting but out of scope)
- DO NOT add "improvements" - this is a surgical fix
- Keep existing comments, update only the implementation

**Code style**:
- Match existing GraphBuilder patterns
- Use `const` for context object
- Keep comment about "NO node creation"
- Maintain same indent level

**What NOT to do**:
- Don't use `ClassNode.createWithContext()` - we only need the ID, not a full node record
- Don't add line numbers to semantic ID - semantic IDs don't use lines
- Don't try to handle nested scopes - out of scope for this fix
- Don't modify `InstanceOfResolver` - analysis shows it's already correct
