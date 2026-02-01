# REG-227: Don Melton - High-Level Analysis

## Summary

Update CallResolverValidator to work correctly with the new resolution architecture established by FunctionCallResolver (REG-225) and ExternalCallResolver (REG-226).

**Core Problem**: The current validator reports ALL CALL nodes without CALLS edges as violations. But after REG-225 and REG-226, there are legitimate resolution states that don't need CALLS edges:
- JS built-ins (`parseInt`, `setTimeout`) - recognized by name, no edge needed
- External calls now HAVE CALLS edges to EXTERNAL_MODULE nodes

The validator logic is outdated and creates false positives.

## Current State Analysis

### CallResolverValidator (Current Implementation)

Located at: `/packages/core/src/plugins/validation/CallResolverValidator.ts`

**Current Datalog rule:**
```prolog
violation(X) :- node(X, "CALL"), \+ attr(X, "object", _), \+ edge(X, _, "CALLS").
```

This finds CALL nodes:
1. Without `object` attribute (excluding method calls)
2. Without any CALLS edge

**Problem #1: External calls now HAVE CALLS edges**
After ExternalCallResolver runs:
- `import { map } from 'lodash'; map();` creates CALLS edge to EXTERNAL_MODULE:lodash
- Current validator WON'T report this (has CALLS edge) - CORRECT

**Problem #2: Built-in calls have NO CALLS edges**
- `parseInt('42')` - no edge created, counted as `builtinResolved` by ExternalCallResolver
- Current validator WILL report this as violation - WRONG

**Problem #3: Statistics don't reflect resolution categories**
Current summary only shows:
- `totalCalls`
- `resolvedInternalCalls` (has CALLS edge)
- `unresolvedInternalCalls` (no CALLS edge - but this includes builtins!)
- `externalMethodCalls` (has `object` attribute - wrong categorization)

### Resolution Architecture After REG-225/226

Call resolution now has multiple outcome types:

1. **Internal resolved** - CALLS edge to FUNCTION node
2. **External resolved** - CALLS edge to EXTERNAL_MODULE node
3. **Builtin resolved** - no edge, but NOT a violation
4. **Truly unresolved** - no edge, no matching import, not a builtin

The current validator conflates #3 and #4.

### How ExternalCallResolver Tracks Builtins

From `ExternalCallResolver.ts`:
```typescript
const JS_BUILTINS = new Set([
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',
  'require'
]);
```

When processing a call:
```typescript
if (JS_BUILTINS.has(calledName)) {
  builtinResolved++;
  continue; // No edge needed, just count it
}
```

**Critical insight**: ExternalCallResolver does NOT modify the CALL node or create any marker. It just counts and moves on. The validator has no way to know which calls were resolved as builtins vs truly unresolved.

## The Architectural Gap

The task description suggests using `resolutionType` attribute:
```prolog
violation(X) :- node(X, "CALL"), attr(X, "resolutionType", "unresolved").
ok(X) :- node(X, "CALL"), attr(X, "resolutionType", "builtin").
```

**But this attribute doesn't exist!** Neither FunctionCallResolver nor ExternalCallResolver sets `resolutionType` on CALL nodes.

### Options to Fix

**Option A: Add resolutionType attribute to CALL nodes**
- Modify ExternalCallResolver to set `attr(node, 'resolutionType', 'builtin')` for builtins
- Modify to set `resolutionType='external'` for external calls
- Modify FunctionCallResolver to set `resolutionType='internal'` for resolved calls
- Validator checks attribute

**Option B: Validator re-detects builtins by name**
- Duplicate the JS_BUILTINS set in validator
- Check name before reporting violation
- No changes to resolvers

**Option C: Check edge destination type**
- For CALLS edges: check if destination is FUNCTION vs EXTERNAL_MODULE
- For no edge: check name against builtin list
- Hybrid approach

### Recommendation: Option A with Fallback

**Option A is the RIGHT approach** - resolution type should be a property of the resolved call, not re-discovered by validator. This aligns with the project principle: "fix from the roots, not symptoms."

However, this requires modifying ExternalCallResolver and potentially FunctionCallResolver. Let's assess scope:

1. ExternalCallResolver already processes all calls and knows their resolution category
2. It just needs to update the node with `resolutionType` attribute
3. FunctionCallResolver creates CALLS edges for internal calls - could set `resolutionType='internal'`

**Fallback for backward compatibility**: Validator can ALSO check destination type if `resolutionType` not set.

## Implementation Plan

### Phase 1: Update ExternalCallResolver (Small Change)

Add attribute updates when resolving:

```typescript
// For builtins
if (JS_BUILTINS.has(calledName)) {
  await graph.updateNode(callNode.id, { resolutionType: 'builtin' });
  builtinResolved++;
  continue;
}

// For external packages
await graph.addEdge({ type: 'CALLS', src: callNode.id, dst: externalModuleId, ... });
await graph.updateNode(callNode.id, { resolutionType: 'external' });
externalResolved++;

// For unresolved (explicit marking)
await graph.updateNode(callNode.id, { resolutionType: 'unresolved' });
```

**Wait** - checking if `graph.updateNode` exists... Need to verify the Graph interface supports this.

Actually, looking at the code more carefully, we can set attributes when the node is processed. But CALL nodes are created during ANALYSIS phase by GraphBuilder, and enrichment plugins don't typically modify them.

**Alternative**: FunctionCallResolver and ExternalCallResolver could add metadata to the CALLS edge instead. But that doesn't help for builtins (no edge).

**Simpler approach**: Let validator do the detection but use the same logic as ExternalCallResolver.

### Phase 2: Update CallResolverValidator

The validator should:

1. Query all CALL nodes without `object` attribute (same as now)
2. For each, determine resolution status:
   - Has CALLS edge? -> resolved (internal or external)
   - Name in JS_BUILTINS set? -> builtin (not a violation)
   - Otherwise? -> truly unresolved (warning)
3. Update summary to show breakdown

**New Summary Structure:**
```typescript
interface ValidationSummary {
  totalCalls: number;
  resolvedInternal: number;   // CALLS -> FUNCTION
  resolvedExternal: number;   // CALLS -> EXTERNAL_MODULE
  resolvedBuiltin: number;    // Name in JS_BUILTINS
  unresolvedCalls: number;    // No edge, not builtin
  warnings: number;           // = unresolvedCalls
}
```

### Phase 3: Update Reporting

- Change from `ValidationError` to warning (not error)
- Provide actionable message: "Unresolved call - ensure function is imported or define locally"
- Show breakdown in summary log

## Key Decisions

### 1. Should we set `resolutionType` attribute?

**Decision: No for now**

The validator can determine resolution type at validation time. Adding attributes requires:
1. Modifying multiple plugins
2. Ensuring updateNode works correctly
3. Migration path for existing graphs

For v0.2, use the simpler approach: validator re-detects. Consider `resolutionType` attribute for v0.3 when we add more resolution features.

### 2. Should unresolved calls be errors or warnings?

**Decision: Warnings**

Per the task description: "Only report `resolutionType='unresolved'` as warnings (not errors)"

Unresolved calls are often legitimate:
- Functions defined in same file (already resolved by GraphBuilder)
- Global functions from environment (window.*, globals in tests)
- Dynamic evaluation patterns

### 3. How to detect external vs internal resolution?

Check the destination node type:
```typescript
const edges = await graph.getOutgoingEdges(node.id, ['CALLS']);
if (edges.length > 0) {
  const dst = await graph.getNode(edges[0].dst);
  if (dst?.type === 'FUNCTION') -> internal
  if (dst?.type === 'EXTERNAL_MODULE') -> external
}
```

### 4. Should we export JS_BUILTINS for reuse?

**Decision: Yes**

Create a shared constant in `@grafema/core` that both ExternalCallResolver and CallResolverValidator use. Prevents divergence.

## Files to Modify

1. **`packages/core/src/plugins/validation/CallResolverValidator.ts`**
   - Update Datalog query (or replace with programmatic check)
   - Add builtin detection
   - Update summary structure
   - Change ValidationError to warning

2. **`packages/core/src/plugins/enrichment/ExternalCallResolver.ts`**
   - Export JS_BUILTINS constant (or move to shared location)

3. **`packages/core/src/constants/builtins.ts`** (new file)
   - Shared JS_BUILTINS set
   - Can add other builtin categories later

4. **`test/unit/CallResolverValidator.test.js`**
   - Add tests for builtin handling
   - Add tests for external call handling
   - Update existing tests for new summary format

## Test Cases

### New Test Cases

1. **Built-in calls not reported as violations**
   ```
   - Add CALL node with name='parseInt'
   - Run validator
   - Assert: no violations, summary shows resolvedBuiltin=1
   ```

2. **External calls not reported as violations**
   ```
   - Add CALL node with CALLS edge to EXTERNAL_MODULE
   - Run validator
   - Assert: no violations, summary shows resolvedExternal=1
   ```

3. **Truly unresolved calls reported as warnings**
   ```
   - Add CALL node with no edge, name not in builtins
   - Run validator
   - Assert: 1 warning (not error), summary shows unresolvedCalls=1
   ```

4. **Mixed resolution types in summary**
   ```
   - Add internal, external, builtin, and unresolved calls
   - Run validator
   - Assert: correct counts for each category
   ```

### Update Existing Tests

Tests like "should detect call to undefined function using Datalog" need updating:
- Change assertion from "violation" to "warning"
- Or update expectation if logic changes

## Risk Assessment

**Low risk with caveats**:
- Clear scope: only modifying validator logic
- No changes to resolvers (they work correctly)
- Backward compatible: existing graphs still validate

**Potential issues**:
1. Performance: Adding builtin check for every CALL node adds O(n) lookups
   - Mitigation: Set lookups are O(1), should be negligible

2. Missing builtins: JS_BUILTINS might not cover all global functions
   - Mitigation: Document as known limitation, add more as discovered

3. False negatives: Legitimate unresolved calls not flagged
   - This is actually correct behavior - unresolved calls are warnings, not errors

## Alignment with Project Vision

This change aligns with Grafema's vision:
- **Better graph understanding**: Resolution type is now explicit in summary
- **Actionable diagnostics**: Warnings for truly unresolved calls
- **No false positives**: Built-ins and externals correctly recognized

The validator becomes more useful for identifying actual issues vs. noise.

## Conclusion

The task is straightforward:
1. Share JS_BUILTINS constant
2. Update validator to check builtin names and edge destination types
3. Update summary to show resolution breakdown
4. Change unresolved reports from errors to warnings

Ready for Joel to create detailed technical spec.
