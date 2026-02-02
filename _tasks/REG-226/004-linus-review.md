# REG-226: ExternalCallResolver - Linus Review

## Summary

**APPROVED WITH CRITICAL CHANGES REQUIRED.**

The plan is fundamentally sound and aligns with Grafema's vision. However, there are several architectural issues that need fixing before implementation:

1. **Node metadata strategy is broken** - no updateNode() exists
2. **Built-ins list is too broad** - conflicts with Node.js semantics
3. **Test coverage has gaps** - missing critical edge cases
4. **Priority ordering needs verification** - may conflict with existing pipeline

## Critical Issues

### 1. Node Metadata Strategy - BROKEN

**Problem:** Joel's spec assumes we can add `resolutionType` metadata to CALL nodes via `graph.updateNode()`. This method does not exist in GraphBackend interface.

**Evidence:**
```typescript
// From GraphBackend.ts - NO updateNode() method exists:
abstract addNode(node: NodeRecord): Promise<void>;
abstract getNode(id: string): Promise<NodeRecord | null>;
// That's it. No update method.
```

**Impact:** The spec's core metadata strategy cannot be implemented as written.

**Solution:** Two options:

**Option A (Recommended):** Add metadata AT CREATION TIME during GraphBuilder analysis phase
- CALL nodes get created with `isExternal`, `isBuiltin`, `unresolvedReason` attributes from the start
- ExternalCallResolver becomes simpler - just creates edges, no metadata updates
- Requires: update JSASTAnalyzer to detect external/builtin calls during analysis

**Option B:** Drop node metadata entirely
- ExternalCallResolver only creates edges
- CallResolverValidator derives resolution type from graph structure:
  - Has CALLS to EXTERNAL_MODULE → external
  - Name in JS_BUILTINS → builtin
  - Otherwise → unresolved
- Simpler but requires validator to duplicate built-ins list

**Decision needed before implementation starts.**

### 2. Built-ins List is TOO BROAD

**Problem:** Joel's JS_BUILTINS includes constructors that SHOULD have CALLS edges:

```typescript
// From Joel's spec:
'String', 'Number', 'Boolean', 'Array', 'Object', 'Symbol', 'BigInt',
'Error', 'TypeError', 'RangeError', ...
'JSON', 'Date', 'RegExp', 'Promise',
'Function', 'GeneratorFunction', 'AsyncFunction'
```

**Why this is wrong:**

1. **These are NOT functions, they're constructors/objects:**
   - `Array()` vs `Array.from()` - first is constructor call, second is method call
   - `JSON.parse()` - this is a METHOD call, not a function call
   - `Date.now()` - also method call

2. **This creates false negatives for dependency tracking:**
   - If code calls `Array.from()`, we should see "code uses Array.from"
   - With current approach, it gets marked as builtin and we lose this information

3. **Conflicts with MethodCallResolver:**
   - `Array.from()` has `object='Array'`, `method='from'`
   - ExternalCallResolver should skip it (has object attribute)
   - But if we mark 'Array' as builtin, we confuse the resolution

**Correct scope for JS_BUILTINS:**

```typescript
const JS_BUILTINS = new Set([
  // Global functions (actually called as functions)
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',

  // Timers (global functions)
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',

  // CommonJS (special case - global in CJS environments)
  'require'
]);
```

**Constructors like Array, Object, Error should NOT be in this list.**

If we encounter `Array()` as a call (not method call), it's:
- Either a constructor call (should be analyzed as such)
- Or needs special handling in a separate "constructor calls" resolver

**This is a ROOT CAUSE issue per project rules - we must fix the architecture, not paper over it.**

### 3. Priority Order Verification MISSING

**Problem:** Joel specifies priority 70, but provides NO VERIFICATION that this doesn't conflict with existing pipeline.

**Current pipeline (from Don's plan):**
```
90: ImportExportLinker
80: FunctionCallResolver
70: ExternalCallResolver (NEW)
50: MethodCallResolver
45: NodejsBuiltinsResolver
```

**Questions NOT answered:**

1. **Why before MethodCallResolver?**
   - Method calls have `object` attribute, ExternalCallResolver skips them
   - What happens if MethodCallResolver runs first?
   - Could we run at priority 40 (after methods) without issues?

2. **Why before NodejsBuiltinsResolver?**
   - NodejsBuiltinsResolver handles `fs.readFile()` (Node.js builtins)
   - ExternalCallResolver handles `parseInt()` (JS builtins)
   - These don't overlap, so order shouldn't matter
   - But spec doesn't justify the ordering

**This smells like "picked a number that fit" rather than "analyzed dependencies".**

**Required:** Don must provide dependency analysis showing why 70 is correct.

### 4. Test Coverage Gaps

**Missing critical test cases:**

1. **Namespace imports:**
   ```javascript
   import * as _ from 'lodash';
   _.map(arr, fn);  // How is this handled?
   ```
   Joel's spec doesn't test this. It's a CALL or METHOD_CALL? If object='_', ExternalCallResolver skips it. Is that correct?

2. **Aliased imports:**
   ```javascript
   import { map as lodashMap } from 'lodash';
   lodashMap();  // Spec shows this, but doesn't test exportedName
   ```
   Should `exportedName` be 'map' or 'lodashMap'? Spec says `imported || calledName` but test doesn't verify.

3. **Mixed resolution in single file:**
   ```javascript
   import { foo } from './utils';  // Internal
   import { bar } from 'lodash';   // External
   parseInt('42');                 // Builtin
   unknownFunc();                  // Unresolved
   ```
   No test verifies all four resolution types in single run.

4. **Re-exported external modules:**
   ```javascript
   // utils.js
   export { map } from 'lodash';

   // main.js
   import { map } from './utils';
   map();  // Should this link to EXTERNAL_MODULE:lodash?
   ```
   FunctionCallResolver follows IMPORTS_FROM chains. Does ExternalCallResolver need to?

**These gaps could hide major bugs.**

## Alignment with Vision

**Does it align with "AI should query the graph"?**

**YES.** This enables critical queries:

```
Query: What external packages does service X depend on?
Answer: lodash, react, @tanstack/react-query

Query: Show me all calls to lodash
Answer: [links to all CALL nodes with CALLS edges to EXTERNAL_MODULE:lodash]
```

**Before this plugin:** External dependency analysis requires reading code.
**After this plugin:** Query the graph.

This is exactly what Grafema should do.

## Architecture Review

**Good decisions:**

1. **Reuses EXTERNAL_MODULE nodes** - NodejsBuiltinsResolver already creates these, no duplication
2. **Clear separation from FunctionCallResolver** - relative vs external imports
3. **Follows existing plugin patterns** - matches FunctionCallResolver structure
4. **Idempotent** - can run multiple times safely
5. **Edge metadata for exportedName** - enables "what exports are called" queries

**Bad decisions:**

1. **Metadata strategy assumes updateNode() exists** - doesn't
2. **Built-ins list too broad** - includes constructors that shouldn't be there
3. **No dependency analysis for priority** - just picked 70

## High-Level Correctness

**Did we do the right thing?**

Almost. The CONCEPT is right:
- Handle remaining unresolved calls after FunctionCallResolver
- Link external package calls to EXTERNAL_MODULE
- Mark built-ins so they don't show as errors

But the IMPLEMENTATION PLAN has holes:
- Metadata strategy broken
- Built-ins list wrong
- Priority not justified
- Test coverage incomplete

**This is NOT READY for Kent/Rob to implement.**

## Actionable Changes Required

### BEFORE implementation starts:

1. **Don:** Decide metadata strategy (Option A or B above)
2. **Don:** Analyze priority dependencies, justify why 70 is correct
3. **Joel:** Revise built-ins list to remove constructors
4. **Joel:** Add test cases for namespace imports, mixed resolution, re-exports
5. **Joel:** Update spec based on metadata strategy decision

### After fixes:

When these are done, I'll re-review. If issues are addressed, we proceed to Kent for tests.

## Bottom Line

**The plan shows good architectural thinking but has critical gaps that will cause implementation to fail or produce wrong results.**

Fix the four issues above. Don't implement until fixed.

No shortcuts. This matters.

---

**Status:** CHANGES REQUIRED
**Next step:** Don addresses metadata strategy and priority analysis
**Estimated rework:** 2-4 hours
