# Don Melton - Analysis & Plan: REG-100

## Analysis

### Current State Summary

**Good news: 90% of REG-100 is already done.** The previous task (2026-01-21-nodefactory-import) implemented most of this, but was not fully merged due to test failures.

### Existing Patterns

NodeFactory follows a clean delegation pattern:
- Each node type has a class in `/packages/core/src/core/nodes/` with a static `create()` method
- NodeFactory provides wrapper methods that delegate to these classes
- NodeFactory also provides a `validate()` method that dispatches to each node class's validator

**Key files:**
- `/packages/core/src/core/NodeFactory.ts` - Factory with `createImport()` at lines 351-360
- `/packages/core/src/core/nodes/ImportNode.ts` - Import node contract with `create()` method
- `/packages/core/src/core/nodes/index.ts` - Exports ImportNode and related types

**ImportNode ID format (semantic, stable):**
```
{file}:IMPORT:{source}:{local_name}
```
Example: `/project/src/App.js:IMPORT:react:React`

Note: Line number is stored as a field but NOT part of the ID. This is the correct design for semantic identity.

### Current IMPORT Node Creation Sites

| File | Line | Status | ID Format |
|------|------|--------|-----------|
| `GraphBuilder.ts` | 490 | **MIGRATED** | Uses `ImportNode.create()` directly |
| `AnalysisWorker.ts` | 161-168 | **NOT MIGRATED** | `IMPORT#${localName}#${filePath}#${line}` |
| `QueueWorker.ts` | 234-243 | **NOT MIGRATED** | `IMPORT#${localName}#${filePath}#${line}` |
| `ASTWorker.ts` | 274-282 | **NOT MIGRATED** | `IMPORT#${localName}#${filePath}#${line}` |

**Observation:** GraphBuilder is correctly using the factory pattern. The three worker files use an **incompatible ID format** (`IMPORT#...` with line numbers vs. `file:IMPORT:source:name` semantic IDs).

### ImportNode Status

**ImportNode.ts is complete and correct:**
- Has `create()` static method with proper validation
- Uses semantic IDs (no line number in ID)
- Has `validate()` method
- Has proper type exports

**NodeFactory has createImport():**
- Lines 351-360 in NodeFactory.ts
- Delegates to `ImportNode.create()`
- Has proper documentation

### Test Status

**One test is failing:**
- `test/unit/NodeFactoryImport.test.js` line 361-365
- Test expects `line = 0` to throw "line is required"
- But after fix to `line === undefined` check, line 0 is now valid
- **This test expectation is WRONG** - line 0 should be accepted (consistent with FunctionNode pattern)

```javascript
// Current failing test
it('should throw when line is missing', () => {
  assert.throws(() => {
    NodeFactory.createImport('React', '/file.js', 0, 0, 'react');  // line=0
  }, /line is required/);  // WRONG: line=0 should be valid
});
```

### The Real Question: What About the Workers?

The three worker files (`AnalysisWorker.ts`, `QueueWorker.ts`, `ASTWorker.ts`) create IMPORT nodes with a **completely different ID format**:
- Current: `IMPORT#${localName}#${filePath}#${line}`
- Expected: `{file}:IMPORT:{source}:{localName}` (semantic)

These workers appear to be alternative/legacy analysis paths. We need to decide:
1. **Option A:** Migrate them to use `NodeFactory.createImport()` (consistent, correct)
2. **Option B:** Leave them as-is if they're deprecated/unused
3. **Option C:** They serve different purposes and need their own ID format

## High-Level Plan

### Step 1: Fix the Failing Test (5 min)
- Update test to not expect exception for `line = 0`
- Instead, test that `line = undefined` throws

### Step 2: Decide Worker Migration Strategy
**QUESTION FOR USER:** What is the status of these three workers?
- `AnalysisWorker.ts` - Worker thread for RFDB-based analysis
- `QueueWorker.ts` - Queue-based worker with plugin system
- `ASTWorker.ts` - Parallel AST parsing worker

Are they:
- Active code paths that should use NodeFactory?
- Legacy/deprecated paths to be removed?
- Different analysis modes with intentionally different ID formats?

### Step 3: Execute Migration (if workers are active)
If workers should use NodeFactory:
1. Import `NodeFactory` in each worker
2. Replace inline IMPORT creation with `NodeFactory.createImport()`
3. Ensure proper field mapping (importedName -> imported)
4. Update any dependent code that relies on old ID format

### Step 4: Verify
- Run all tests
- Verify no inline IMPORT literals remain (except type definitions)

## Risks & Concerns

### 1. ID Format Breaking Change
The workers use `IMPORT#name#file#line` while NodeFactory uses `file:IMPORT:source:name`. If these workers write to the same graph storage, this is an **incompatibility**.

### 2. Missing Fields in Workers
Worker node creation is simpler:
```javascript
// Worker pattern
{ id, type, name, file, line, importedName, source }
```

NodeFactory provides:
```javascript
{ id, type, name, file, line, column, source, importType, importBinding, imported, local }
```

The workers would need to be updated to pass correct options.

### 3. Test Suite Isolation
Previous task reported test isolation issues in `GraphBuilderImport.test.js`. Should verify those are resolved.

## Questions for User

1. **What is the production status of AnalysisWorker, QueueWorker, and ASTWorker?**
   - Are they actively used?
   - Should they be migrated or deprecated?

2. **Are all analysis paths expected to produce the same graph?**
   - If yes, ID format must be consistent across all paths
   - If no, different ID formats may be intentional

3. **Is there existing data with old ID formats that needs migration?**

---

## Preliminary Assessment

If the user confirms workers should be migrated:

**Complexity:** Medium
- GraphBuilder already migrated (done)
- 3 workers need updates (straightforward pattern)
- 1 test fix needed (trivial)

**Time estimate:**
- Test fix: 5 min
- Worker migration (3 files): 30-45 min
- Verification: 15 min

If workers are deprecated/separate:

**Complexity:** Low
- Fix test: 5 min
- Verify no other inline IMPORT creation: 10 min
- Task is essentially DONE
