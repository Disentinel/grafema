# Joel Spolsky - Technical Implementation Plan: REG-192 Type Safety for RFDB Query Results

## Executive Summary

This document provides a detailed, line-by-line implementation plan for eliminating `BackendNode` and making `RFDBServerBackend` return `BaseNodeRecord` directly. This fixes the architectural duplication that forces CLI commands to use `(node as any)` casts.

**Complexity:** Medium (2-3 hours)
**Risk:** Low-Medium (well-isolated, TypeScript catches errors)
**Impact:** High (eliminates entire class of bugs, sets pattern for all backends)

---

## Answers to Don's Open Questions

### Q1: Metadata handling - spread to top-level or nested?

**Answer:** Keep spread to top-level (current behavior).

**Reasoning:**
- Backward compatibility - CLI commands already expect `node.async`, `node.params`, etc.
- Matches `BaseNodeRecord` index signature: `[key: string]: unknown`
- No migration needed - existing code continues working
- Plugin-added properties remain accessible

**Confirmation:** Yes, metadata spread is correct. Don't change it.

### Q2: Edge types - unify `BackendEdge` in same PR?

**Answer:** NO. Separate task.

**Reasoning:**
- Different scope - edges have different usage patterns
- Node fixes are already substantial (4 CLI files + core)
- Keep PR focused and reviewable
- Edge unification should be REG-193 (separate Linear issue)
- Same pattern applies, but don't mix concerns

**Decision:** This PR only touches nodes. Create follow-up issue for edges.

### Q3: Migration path - support both `type` and `nodeType`?

**Answer:** NO. Clean break. Single field: `type`.

**Reasoning:**
- `BaseNodeRecord` only has `type: NodeType`
- All CLI code already handles both via `(node as any).type || (node as any).nodeType`
- After fix, TypeScript knows `node.type` exists
- Supporting both fields prolongs confusion
- Clean unification = single source of truth

**Decision:** Remove `nodeType` from `_parseNode()` return. Only return `type`.

### Q4: Which test files need priority review?

**Answer:** These files in order:

1. **`test/unit/storage/backends/RFDBServerBackend.data-persistence.test.js`** (exists, verified)
   - Already uses `backend.addNodes()`, `backend.nodeCount()`
   - Should verify returned nodes have correct shape

2. **Any CLI command tests** (if they exist)
   - `test/unit/cli/commands/trace.test.js`
   - `test/unit/cli/commands/query.test.js`
   - `test/unit/cli/commands/get.test.js`
   - `test/unit/cli/commands/impact.test.js`

3. **MCP handler tests** (if they exist)
   - `test/unit/mcp/handlers.test.js`

**NOTE:** If CLI/MCP tests don't exist, this is NOT a blocker. Core backend tests are sufficient to validate type safety.

---

## Implementation Plan

### Phase 1: Core Type Changes (RFDBServerBackend)

**File:** `/Users/vadimr/grafema-worker-7/packages/core/src/storage/backends/RFDBServerBackend.ts`

#### Step 1.1: Add import for BaseNodeRecord

**Location:** Line 28 (after existing WireNode, WireEdge imports)

**Current:**
```typescript
import type { WireNode, WireEdge } from '@grafema/types';
import type { NodeType, EdgeType } from '@grafema/types';
```

**Change to:**
```typescript
import type { WireNode, WireEdge } from '@grafema/types';
import type { NodeType, EdgeType } from '@grafema/types';
import type { BaseNodeRecord } from '@grafema/types';
```

#### Step 1.2: Remove BackendNode interface

**Location:** Lines 46-54

**DELETE ENTIRELY:**
```typescript
export interface BackendNode {
  id: string;
  type: string;
  nodeType: string;
  name: string;
  file: string;
  exported: boolean;
  [key: string]: unknown;
}
```

**Reason:** This interface is redundant. We'll use `BaseNodeRecord` directly.

#### Step 1.3: Update getNode() return type

**Location:** Line 405

**Current:**
```typescript
async getNode(id: string): Promise<BackendNode | null> {
```

**Change to:**
```typescript
async getNode(id: string): Promise<BaseNodeRecord | null> {
```

#### Step 1.4: Update _parseNode() signature and implementation

**Location:** Lines 440-465

**Current:**
```typescript
private _parseNode(wireNode: WireNode): BackendNode {
  const metadata: Record<string, unknown> = wireNode.metadata ? JSON.parse(wireNode.metadata) : {};

  // Parse nested JSON strings
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
      try {
        metadata[key] = JSON.parse(value);
      } catch {
        // Not JSON, keep as string
      }
    }
  }

  const humanId = (metadata.originalId as string) || wireNode.id;

  return {
    id: humanId,
    nodeType: wireNode.nodeType,
    type: wireNode.nodeType,
    name: wireNode.name,
    file: wireNode.file,
    exported: wireNode.exported,
    ...metadata,
  };
}
```

**Change to:**
```typescript
private _parseNode(wireNode: WireNode): BaseNodeRecord {
  const metadata: Record<string, unknown> = wireNode.metadata ? JSON.parse(wireNode.metadata) : {};

  // Parse nested JSON strings
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
      try {
        metadata[key] = JSON.parse(value);
      } catch {
        // Not JSON, keep as string
      }
    }
  }

  const humanId = (metadata.originalId as string) || wireNode.id;

  return {
    id: humanId,
    type: wireNode.nodeType,  // Single 'type' field, NOT 'nodeType'
    name: wireNode.name,
    file: wireNode.file,
    exported: wireNode.exported,
    ...metadata,  // Spread metadata to top level
  };
}
```

**Key changes:**
- Return type: `BackendNode` → `BaseNodeRecord`
- Remove `nodeType` field entirely
- Keep single `type` field
- Preserve metadata spread (backward compat)

#### Step 1.5: Update queryNodes() return type

**Location:** Line 470

**Current:**
```typescript
async *queryNodes(query: NodeQuery): AsyncGenerator<BackendNode, void, unknown> {
```

**Change to:**
```typescript
async *queryNodes(query: NodeQuery): AsyncGenerator<BaseNodeRecord, void, unknown> {
```

#### Step 1.6: Update getAllNodes() return type

**Location:** Line 499

**Current:**
```typescript
async getAllNodes(query: NodeQuery = {}): Promise<BackendNode[]> {
```

**Change to:**
```typescript
async getAllNodes(query: NodeQuery = {}): Promise<BaseNodeRecord[]> {
```

#### Step 1.7: Update findNodes() parameter type

**Location:** Line 743

**Current:**
```typescript
async findNodes(predicate: (node: BackendNode) => boolean): Promise<BackendNode[]> {
```

**Change to:**
```typescript
async findNodes(predicate: (node: BaseNodeRecord) => boolean): Promise<BaseNodeRecord[]> {
```

**Summary of Phase 1:**
- 1 import added
- 1 interface deleted (BackendNode)
- 5 type signatures updated
- 1 implementation updated (_parseNode removes nodeType duplication)

---

### Phase 2: CLI Commands - Remove Type Casts

All CLI commands follow the same pattern. Replace `(node as any).property` with `node.property`.

#### File 1: trace.ts

**File:** `/Users/vadimr/grafema-worker-7/packages/cli/src/commands/trace.ts`

**Locations to fix (7 occurrences):**

##### Fix 1: Line 151
**Before:**
```typescript
const name = (node as any).name || '';
```
**After:**
```typescript
const name = node.name || '';
```

##### Fix 2: Lines 166-169
**Before:**
```typescript
results.push({
  id: node.id,
  type: (node as any).type || nodeType,
  name: name,
  file: (node as any).file || '',
  line: (node as any).line,
});
```
**After:**
```typescript
results.push({
  id: node.id,
  type: node.type || nodeType,
  name: name,
  file: node.file || '',
  line: node.line,
});
```

##### Fix 3: Lines 305-309 (in getValueSources function)
**Before:**
```typescript
sources.push({
  id: node.id,
  type: (node as any).type || (node as any).nodeType || 'UNKNOWN',
  name: (node as any).name || '',
  file: (node as any).file || '',
  line: (node as any).line,
  value: (node as any).value,
});
```
**After:**
```typescript
sources.push({
  id: node.id,
  type: node.type || 'UNKNOWN',
  name: node.name || '',
  file: node.file || '',
  line: node.line,
  value: node.value,
});
```

**Note:** Remove `|| (node as any).nodeType` fallback - no longer needed since backend returns `type`.

##### Fix 4: Lines 208-213 (in traceBackward function)
**Before:**
```typescript
const nodeInfo: NodeInfo = {
  id: targetNode.id,
  type: (targetNode as any).type || (targetNode as any).nodeType || 'UNKNOWN',
  name: (targetNode as any).name || '',
  file: (targetNode as any).file || '',
  line: (targetNode as any).line,
  value: (targetNode as any).value,
};
```
**After:**
```typescript
const nodeInfo: NodeInfo = {
  id: targetNode.id,
  type: targetNode.type || 'UNKNOWN',
  name: targetNode.name || '',
  file: targetNode.file || '',
  line: targetNode.line,
  value: targetNode.value,
};
```

##### Fix 5: Lines 263-266 (in traceForward function)
**Before:**
```typescript
const nodeInfo: NodeInfo = {
  id: sourceNode.id,
  type: (sourceNode as any).type || (sourceNode as any).nodeType || 'UNKNOWN',
  name: (sourceNode as any).name || '',
  file: (sourceNode as any).file || '',
  line: (sourceNode as any).line,
};
```
**After:**
```typescript
const nodeInfo: NodeInfo = {
  id: sourceNode.id,
  type: sourceNode.type || 'UNKNOWN',
  name: sourceNode.name || '',
  file: sourceNode.file || '',
  line: sourceNode.line,
};
```

**Total changes in trace.ts:** 7 casts removed

---

#### File 2: query.ts

**File:** `/Users/vadimr/grafema-worker-7/packages/cli/src/commands/query.ts`

**Locations to fix (8 occurrences):**

##### Fix 1: Line 172
**Before:**
```typescript
const nodeName = (node as any).name || '';
```
**After:**
```typescript
const nodeName = node.name || '';
```

##### Fix 2: Lines 177-180
**Before:**
```typescript
results.push({
  id: node.id,
  type: (node as any).type || nodeType,
  name: nodeName,
  file: (node as any).file || '',
  line: (node as any).line,
});
```
**After:**
```typescript
results.push({
  id: node.id,
  type: node.type || nodeType,
  name: nodeName,
  file: node.file || '',
  line: node.line,
});
```

##### Fix 3: Lines 223-227 (in getCallers function)
**Before:**
```typescript
callers.push({
  id: containingFunc.id,
  type: (containingFunc as any).type || 'FUNCTION',
  name: (containingFunc as any).name || '<anonymous>',
  file: (containingFunc as any).file || '',
  line: (containingFunc as any).line,
});
```
**After:**
```typescript
callers.push({
  id: containingFunc.id,
  type: containingFunc.type || 'FUNCTION',
  name: containingFunc.name || '<anonymous>',
  file: containingFunc.file || '',
  line: containingFunc.line,
});
```

##### Fix 4: Line 270 (in findContainingFunction)
**Before:**
```typescript
const parentType = (parentNode as any).type || (parentNode as any).nodeType;
```
**After:**
```typescript
const parentType = parentNode.type;
```

##### Fix 5: Lines 274-280 (in findContainingFunction)
**Before:**
```typescript
return {
  id: parentNode.id,
  type: parentType,
  name: (parentNode as any).name || '<anonymous>',
  file: (parentNode as any).file || '',
  line: (parentNode as any).line,
};
```
**After:**
```typescript
return {
  id: parentNode.id,
  type: parentType,
  name: parentNode.name || '<anonymous>',
  file: parentNode.file || '',
  line: parentNode.line,
};
```

##### Fix 6: Line 327 (in getCallees function)
**Before:**
```typescript
type: (targetNode as any).type || (targetNode as any).nodeType || 'UNKNOWN',
```
**After:**
```typescript
type: targetNode.type || 'UNKNOWN',
```

##### Fix 7: Line 367 (in findCallsInFunction)
**Before:**
```typescript
const childType = (child as any).type || (child as any).nodeType;
```
**After:**
```typescript
const childType = child.type;
```

##### Fix 8: Lines 371-375 (in findCallsInFunction)
**Before:**
```typescript
calls.push({
  id: child.id,
  type: 'CALL',
  name: (child as any).name || '',
  file: (child as any).file || '',
  line: (child as any).line,
});
```
**After:**
```typescript
calls.push({
  id: child.id,
  type: 'CALL',
  name: child.name || '',
  file: child.file || '',
  line: child.line,
});
```

**Total changes in query.ts:** 8 casts removed

---

#### File 3: get.ts

**File:** `/Users/vadimr/grafema-worker-7/packages/cli/src/commands/get.ts`

**Locations to fix (3 occurrences):**

##### Fix 1: Lines 115-118 (in outputJSON)
**Before:**
```typescript
node: {
  id: node.id,
  type: (node as any).type || (node as any).nodeType || 'UNKNOWN',
  name: (node as any).name || '',
  file: (node as any).file || '',
  line: (node as any).line,
  ...getMetadataFields(node),
},
```
**After:**
```typescript
node: {
  id: node.id,
  type: node.type || 'UNKNOWN',
  name: node.name || '',
  file: node.file || '',
  line: node.line,
  ...getMetadataFields(node),
},
```

##### Fix 2: Lines 146-149 (in outputText)
**Before:**
```typescript
const nodeInfo: NodeInfo = {
  id: node.id,
  type: (node as any).type || (node as any).nodeType || 'UNKNOWN',
  name: (node as any).name || '',
  file: (node as any).file || '',
  line: (node as any).line,
};
```
**After:**
```typescript
const nodeInfo: NodeInfo = {
  id: node.id,
  type: node.type || 'UNKNOWN',
  name: node.name || '',
  file: node.file || '',
  line: node.line,
};
```

##### Fix 3: Line 240 (in getNodeName)
**Before:**
```typescript
return (node as any).name || '';
```
**After:**
```typescript
return node.name || '';
```

**Total changes in get.ts:** 3 casts removed

---

#### File 4: impact.ts

**File:** `/Users/vadimr/grafema-worker-7/packages/cli/src/commands/impact.ts`

**Locations to fix (5 occurrences):**

##### Fix 1: Line 131
**Before:**
```typescript
const nodeName = (node as any).name || '';
```
**After:**
```typescript
const nodeName = node.name || '';
```

##### Fix 2: Lines 135-138
**Before:**
```typescript
return {
  id: node.id,
  type: (node as any).type || nodeType,
  name: nodeName,
  file: (node as any).file || '',
  line: (node as any).line,
};
```
**After:**
```typescript
return {
  id: node.id,
  type: node.type || nodeType,
  name: nodeName,
  file: node.file || '',
  line: node.line,
};
```

##### Fix 3: Lines 248-252 (in findCallsToNode)
**Before:**
```typescript
calls.push({
  id: callNode.id,
  type: (callNode as any).type || 'CALL',
  name: (callNode as any).name || '',
  file: (callNode as any).file || '',
  line: (callNode as any).line,
});
```
**After:**
```typescript
calls.push({
  id: callNode.id,
  type: callNode.type || 'CALL',
  name: callNode.name || '',
  file: callNode.file || '',
  line: callNode.line,
});
```

##### Fix 4: Line 294 (in findContainingFunction)
**Before:**
```typescript
const parentType = (parent as any).type || (parent as any).nodeType;
```
**After:**
```typescript
const parentType = parent.type;
```

##### Fix 5: Lines 299-303 (in findContainingFunction)
**Before:**
```typescript
return {
  id: parent.id,
  type: parentType,
  name: (parent as any).name || '',
  file: (parent as any).file || '',
  line: (parent as any).line,
};
```
**After:**
```typescript
return {
  id: parent.id,
  type: parentType,
  name: parent.name || '',
  file: parent.file || '',
  line: parent.line,
};
```

**Total changes in impact.ts:** 5 casts removed

---

### Phase 3: Verification

No MCP changes needed (handlers likely already type-safe or will benefit automatically).

**Files changed:**
- **Core:** 1 file (`RFDBServerBackend.ts`)
- **CLI:** 4 files (`trace.ts`, `query.ts`, `get.ts`, `impact.ts`)
- **Total:** 5 files

**Casts removed:** 23 total
- `trace.ts`: 7
- `query.ts`: 8
- `get.ts`: 3
- `impact.ts`: 5

---

## Testing Strategy

### Unit Tests (Kent will implement)

#### Test 1: _parseNode returns BaseNodeRecord
```typescript
test('_parseNode converts WireNode to BaseNodeRecord with single type field', async () => {
  const wireNode: WireNode = {
    id: 'file.js->FUNCTION->foo',
    nodeType: 'FUNCTION',
    name: 'foo',
    file: 'file.js',
    exported: true,
    metadata: JSON.stringify({ async: true, line: 10, params: ['a', 'b'] })
  };

  const backend = new RFDBServerBackend({ dbPath: '/tmp/test.rfdb' });
  await backend.connect();

  const result = backend._parseNode(wireNode);

  // Should have 'type', NOT 'nodeType'
  expect(result.type).toBe('FUNCTION');
  expect(result.nodeType).toBeUndefined();

  // Metadata should be spread to top level
  expect(result.async).toBe(true);
  expect(result.line).toBe(10);
  expect(result.params).toEqual(['a', 'b']);

  // Standard fields
  expect(result.name).toBe('foo');
  expect(result.file).toBe('file.js');
  expect(result.exported).toBe(true);

  await backend.close();
});
```

**NOTE:** `_parseNode` is private. We'll need to either:
- Make it `public` temporarily for testing
- OR test it indirectly via `getNode()` / `queryNodes()`
- Prefer indirect testing (black box)

#### Test 2: queryNodes returns BaseNodeRecord (indirect test)
```typescript
test('queryNodes yields BaseNodeRecord with typed properties', async () => {
  const backend = new RFDBServerBackend({ dbPath: '/tmp/test.rfdb' });
  await backend.connect();
  await backend.clear();

  // Add a function node
  await backend.addNodes([
    {
      id: 'test.js->FUNCTION->authenticate',
      type: 'FUNCTION',
      name: 'authenticate',
      file: 'test.js',
      async: true,
      params: ['username', 'password']
    }
  ]);

  const nodes: BaseNodeRecord[] = [];
  for await (const node of backend.queryNodes({ nodeType: 'FUNCTION' })) {
    nodes.push(node);
  }

  expect(nodes.length).toBeGreaterThan(0);

  const funcNode = nodes[0];

  // TypeScript should know these exist (no 'as any' needed)
  expect(funcNode.type).toBe('FUNCTION');
  expect(funcNode.name).toBe('authenticate');
  expect(funcNode.file).toBe('test.js');
  expect(funcNode.async).toBe(true);
  expect(funcNode.params).toEqual(['username', 'password']);

  // Should NOT have 'nodeType' field
  expect((funcNode as any).nodeType).toBeUndefined();

  await backend.close();
});
```

#### Test 3: Type-level validation (compile-time test)
```typescript
// This test validates TypeScript compilation, not runtime behavior
test('BaseNodeRecord properties are type-safe', async () => {
  const backend = new RFDBServerBackend({ dbPath: '/tmp/test.rfdb' });
  await backend.connect();

  await backend.addNodes([
    { id: 'test', type: 'FUNCTION', name: 'foo', file: 'test.js' }
  ]);

  const node = await backend.getNode('test');

  if (node) {
    // These should compile without errors:
    const name: string = node.name;
    const file: string = node.file;
    const line: number | undefined = node.line;
    const type: NodeType = node.type;

    // This should be a TypeScript ERROR (property doesn't exist):
    // const typo = node.nane;  // ← Uncomment to verify TS catches this

    expect(name).toBe('foo');
  }

  await backend.close();
});
```

### Integration Tests

#### Test 4: CLI commands work without casts
```bash
# After implementation, these should work:
grafema query "function authenticate"
grafema trace "userId from authenticate"
grafema get "file.js->FUNCTION->foo"
grafema impact "class UserService"
```

**Validation:** No TypeScript errors, commands output correct results.

### Regression Tests

#### Test 5: Existing tests still pass
```bash
npm test -- test/unit/storage/backends/RFDBServerBackend.data-persistence.test.js
```

**Expected:** All existing tests pass without modification.

---

## Edge Cases & Mitigation

### Edge Case 1: Plugin-added metadata properties

**Scenario:** Plugins add custom fields like `node.customField`.

**Behavior:**
- Still works via `[key: string]: unknown` index signature
- Access as `unknown`, narrow with type guards
- Example:
  ```typescript
  const customValue = node.customField;  // type: unknown
  if (typeof customValue === 'string') {
    console.log(customValue);  // type: string
  }
  ```

**Mitigation:** No changes needed. Index signature preserves flexibility.

### Edge Case 2: Old code checking `node.nodeType`

**Risk:** Code might check `if (node.nodeType === 'FUNCTION')`.

**Search pattern:**
```bash
grep -r "\.nodeType" packages/cli/src/
grep -r "\.nodeType" packages/mcp/src/
```

**Mitigation:**
- All CLI code already handles both: `node.type || node.nodeType`
- After fix, only `node.type` exists
- TypeScript will catch any remaining `node.nodeType` references

**Action:** Search before implementing. Fix any direct `nodeType` references.

### Edge Case 3: Optional fields (line, column)

**Scenario:** `line?: number` is optional in `BaseNodeRecord`.

**Behavior:**
- Safe to access: `node.line` has type `number | undefined`
- Existing code already uses `|| ''` or `|| 0` fallbacks
- No changes needed

**Example:**
```typescript
// Before:
const line = (node as any).line || 0;

// After:
const line = node.line || 0;  // type: number | undefined → number
```

### Edge Case 4: Metadata as nested object vs. spread

**Current behavior:** `_parseNode` spreads metadata to top level.

**Alternative:** Keep in `node.metadata.field`.

**Decision:** Keep spread (backward compat).

**Validation:** Existing code expects `node.async`, not `node.metadata.async`.

---

## Risk Assessment

### Risk 1: Breaking changes in backend interface

**Likelihood:** Low
**Impact:** Medium

**Analysis:**
```bash
grep -r "BackendNode" packages/
```

**Expected:** Only `RFDBServerBackend.ts` uses it.

**Mitigation:** Search confirms isolation.

### Risk 2: Tests depend on specific metadata structure

**Likelihood:** Low
**Impact:** Low

**Mitigation:**
- Review test file: `RFDBServerBackend.data-persistence.test.js`
- Add new tests for `BaseNodeRecord` shape
- Metadata spread is preserved, so existing tests should pass

### Risk 3: TypeScript compilation errors

**Likelihood:** Medium (expected)
**Impact:** Low (good thing!)

**Analysis:** TypeScript WILL error on any remaining unsafe access.

**Mitigation:** This is GOOD. We WANT TypeScript to catch issues.

**Process:**
1. Run `npm run build` after changes
2. Fix any compilation errors (likely in CLI commands)
3. Re-run until clean build

---

## Success Criteria

### Must Have (blocking release)

1. ✅ No `(node as any)` casts in CLI commands
2. ✅ `backend.queryNodes()` returns `AsyncGenerator<BaseNodeRecord>`
3. ✅ `backend.getNode()` returns `Promise<BaseNodeRecord | null>`
4. ✅ All existing tests pass
5. ✅ TypeScript compiles without errors (`npm run build`)
6. ✅ No `BackendNode` references in codebase

### Should Have (high priority)

7. ✅ New tests validate typed access
8. ✅ Manual CLI testing shows correct output
9. ✅ No `BackendNode` in git grep results

### Nice to Have (post-merge)

10. ⚪ LSP autocomplete works in CLI commands
11. ⚪ Documentation updated (if backend docs exist)
12. ⚪ Create follow-up issue for `BackendEdge` unification (REG-193)

---

## Rollout Sequence

### Step 1: Core changes (packages/core)
**Time:** 30 minutes

1. Add `BaseNodeRecord` import to `RFDBServerBackend.ts`
2. Delete `BackendNode` interface
3. Update method signatures (6 locations)
4. Update `_parseNode()` implementation
5. Run `npm run build` in `packages/core`
6. Fix any TypeScript errors

**Validation:**
```bash
cd packages/core
npm run build
```

### Step 2: CLI changes (packages/cli)
**Time:** 60 minutes

1. Remove casts in `trace.ts` (7 locations)
2. Remove casts in `query.ts` (8 locations)
3. Remove casts in `get.ts` (3 locations)
4. Remove casts in `impact.ts` (5 locations)
5. Run `npm run build` in `packages/cli`
6. Fix any TypeScript errors

**Validation:**
```bash
cd packages/cli
npm run build
```

### Step 3: Testing
**Time:** 45 minutes

1. Run existing backend tests
2. Kent adds new tests for `BaseNodeRecord` shape
3. Manual CLI testing:
   ```bash
   grafema query "function authenticate"
   grafema trace "userId from authenticate"
   grafema get "file.js->FUNCTION->foo"
   ```
4. Verify no runtime errors

**Validation:**
```bash
npm test -- test/unit/storage/backends/
npm test  # Full suite
```

### Step 4: Final verification
**Time:** 15 minutes

1. Search for remaining `BackendNode` references:
   ```bash
   grep -r "BackendNode" packages/
   ```
2. Search for remaining `as any` casts on nodes:
   ```bash
   grep -r "(node as any)" packages/cli/
   ```
3. TypeScript strict check:
   ```bash
   npm run build
   ```
4. Git status clean (no unintended changes)

---

## Implementation Checklist (for Rob)

**Core (RFDBServerBackend.ts):**
- [ ] Add `BaseNodeRecord` import
- [ ] Delete `BackendNode` interface (lines 46-54)
- [ ] Update `getNode()` return type (line 405)
- [ ] Update `_parseNode()` signature and body (lines 440-465)
  - [ ] Return type: `BaseNodeRecord`
  - [ ] Remove `nodeType` field from return
  - [ ] Keep single `type` field
- [ ] Update `queryNodes()` return type (line 470)
- [ ] Update `getAllNodes()` return type (line 499)
- [ ] Update `findNodes()` parameter type (line 743)
- [ ] Run `npm run build` in packages/core
- [ ] Fix TypeScript errors

**CLI (trace.ts):**
- [ ] Remove cast: line 151
- [ ] Remove casts: lines 166-169 (4 properties)
- [ ] Remove casts: lines 208-213 (6 properties)
- [ ] Remove casts: lines 263-266 (5 properties)
- [ ] Remove casts: lines 305-309 (6 properties)
- [ ] Remove `|| nodeType` fallbacks

**CLI (query.ts):**
- [ ] Remove cast: line 172
- [ ] Remove casts: lines 177-180 (4 properties)
- [ ] Remove casts: lines 223-227 (5 properties)
- [ ] Remove cast: line 270
- [ ] Remove casts: lines 274-280 (5 properties)
- [ ] Remove cast: line 327
- [ ] Remove cast: line 367
- [ ] Remove casts: lines 371-375 (4 properties)

**CLI (get.ts):**
- [ ] Remove casts: lines 115-118 (5 properties)
- [ ] Remove casts: lines 146-149 (5 properties)
- [ ] Remove cast: line 240

**CLI (impact.ts):**
- [ ] Remove cast: line 131
- [ ] Remove casts: lines 135-138 (4 properties)
- [ ] Remove casts: lines 248-252 (5 properties)
- [ ] Remove cast: line 294
- [ ] Remove casts: lines 299-303 (5 properties)

**Build & Test:**
- [ ] `npm run build` in packages/cli
- [ ] Fix TypeScript errors
- [ ] Run existing tests
- [ ] Kent adds new tests
- [ ] Manual CLI testing
- [ ] Grep for `BackendNode` (should find nothing)
- [ ] Grep for `(node as any)` in CLI (should find nothing)

---

## Post-Implementation Tasks

### Immediate (same PR)
1. Update success criteria in Linear (REG-192)
2. Steve Jobs demo (verify UX)
3. Linus review (architectural correctness)

### Follow-up (separate issue)
1. Create REG-193: Unify `BackendEdge` → `EdgeRecord`
   - Same pattern as nodes
   - Separate PR for clean review
2. Document pattern for future backends
3. Consider: type-level tests in `packages/types`

---

## Alignment with Project Vision

### Root Cause Fix (not symptom patch)

**Symptom:** `(node as any)` casts everywhere

**Disease:** Architectural duplication (three node types)

**Treatment:** Eliminate wrong abstraction, unify on domain type

From CLAUDE.md:
> "If behavior or architecture doesn't match project vision: STOP, identify mismatch, fix from roots."

We're doing exactly this. No shortcuts.

### AI-First Design

**Before:** AI must know to cast to `any` when using RFDB.

**After:** AI uses typed interfaces. TypeScript guides correct usage.

From CLAUDE.md:
> "AI-first tool: Every function must be documented for LLM-based agents."

**Typed interfaces ARE documentation for LLMs.** Type errors guide AI to correct code.

### TDD Discipline

From CLAUDE.md:
> "New features/bugfixes: write tests first"

**Our sequence:**
1. Kent writes tests for typed behavior
2. Tests fail (current code requires casts)
3. Rob implements unification
4. Tests pass (typed access works)

This is proper TDD.

---

## Questions for Team

### For Don (Tech Lead)
- ✅ Confirmed: Metadata spread to top level?
- ✅ Confirmed: Edges in separate PR?
- ✅ Confirmed: Single `type` field (no `nodeType`)?

### For Kent (Test Engineer)
- Should we test `_parseNode` directly (make it public) or indirectly via `getNode()`?
- Priority: backend shape tests or CLI integration tests?

### For Linus (High-level Reviewer)
- Is this the RIGHT fix? Or are we missing something deeper?
- Architectural concerns?

---

## Estimated Effort Breakdown

**Core changes:** 30 minutes
- Type imports and signature updates
- Low risk, TypeScript catches errors

**CLI changes:** 60 minutes
- 23 casts to remove across 4 files
- Mechanical changes, low risk

**Testing:** 45 minutes
- Existing tests validation
- New test writing (Kent)
- Manual CLI testing

**Review & fixes:** 30 minutes
- TypeScript error fixes
- Final grep verification

**Total:** ~2.5 hours

**Actual (with interruptions):** 3 hours budgeted

---

## Conclusion

This is a **clean architectural fix**, not a typing hack.

We're eliminating `BackendNode` (wrong abstraction) and unifying on `BaseNodeRecord` (domain type).

**Result:**
- Type-safe node access throughout CLI
- No casts, no lies to TypeScript
- Single source of truth
- Pattern for future backends

**Would we show this on stage?**

Hell yes. "Look — typed graph queries. No casts. TypeScript knows your graph. This is how backends should work."

---

Joel Spolsky
2025-01-25
