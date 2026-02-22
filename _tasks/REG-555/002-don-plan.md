# REG-555: Plan — Link PROPERTY_ACCESS Nodes to Source Variable/Parameter

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-21

---

## Executive Summary

PROPERTY_ACCESS nodes are currently "floating" — connected only via CONTAINS to their enclosing scope. The fix is to add READS_FROM edges from each PROPERTY_ACCESS node to the variable/parameter node its `objectName` resolves to. This is a contained change: add `scopePath` to `PropertyAccessInfo`, populate it in `PropertyAccessVisitor`, and emit the edges in `CoreBuilder.bufferPropertyAccessNodes`.

---

## Codebase Understanding

### What exists

1. **`PropertyAccessInfo`** (`packages/core/src/plugins/analysis/ast/types.ts`, line 277) — has `objectName: string` and `parentScopeId?: string`, but **NO `scopePath` field**. The `scopePath` is the string-array form needed for `resolveVariableInScope` / `resolveParameterInScope`.

2. **`PropertyAccessVisitor.extractPropertyAccesses`** (`...ast/visitors/PropertyAccessVisitor.ts`, line 114) — creates `PropertyAccessInfo` entries. Receives `scopeTracker: ScopeTracker | undefined` and `parentScopeId: string`. It calls `scopeTracker.getItemCounter(...)` for semantic ID generation but NEVER captures `scopeTracker.getContext().scopePath` for edge linking.

3. **`CoreBuilder.bufferPropertyAccessNodes`** (`...ast/builders/CoreBuilder.ts`, line 218) — buffers PROPERTY_ACCESS nodes and CONTAINS edges only. Does NOT create READS_FROM edges.

4. **`GraphBuilder.resolveVariableInScope`** / **`resolveParameterInScope`** (`...ast/GraphBuilder.ts`, lines 415–519) — scope-chain-aware lookups using `scopePath: string[]`. Available via `BuilderContext`.

5. **`this` → CLASS pattern** (`MutationBuilder.ts`, lines 196–207) — when `objectName === 'this'`, lookup uses `enclosingClassName` → find CLASS node. `PropertyAccessInfo` does NOT currently store `enclosingClassName`.

6. **Precedent for `scopePath` on info structs**: `ObjectMutationInfo` and `ArrayMutationInfo` both have `mutationScopePath?: string[]` populated from `scopeTracker.getContext().scopePath` in the visitor.

### How `this.prop` is currently handled for mutations
MutationBuilder receives `enclosingClassName` (stored on `ObjectMutationInfo`) and does:
```ts
const classDecl = classDeclarations.find(c =>
  c.name === enclosingClassName && c.file === fileBasename
);
objectNodeId = classDecl?.id ?? null;
```
The `enclosingClassName` comes from `scopeTracker.getEnclosingScope('CLASS')` called in JSASTAnalyzer at mutation-detection time.

### Why this matters for REG-555
For `this.prop` accesses, the acceptance criteria says "Works for: this access" — but the target is ambiguous. Following the MutationBuilder precedent, we link `this.prop` to the CLASS node. However, `PropertyAccessVisitor` currently does NOT capture `enclosingClassName`. We need to add it.

---

## Plan

### Phase 1: Extend `PropertyAccessInfo` type
**File:** `packages/core/src/plugins/analysis/ast/types.ts`
**Lines:** 277–291 (15 lines, add 2 fields)

Add two fields:
```ts
export interface PropertyAccessInfo {
  // ...existing fields...
  scopePath?: string[];        // NEW: scope path for resolveVariable/resolveParam
  enclosingClassName?: string; // NEW: class name when objectName === 'this' (REG-152 pattern)
}
```

**Why:** `resolveVariableInScope` and `resolveParameterInScope` require `scopePath: string[]`. The `enclosingClassName` is required for CLASS lookup when `objectName === 'this'`.

### Phase 2: Populate the new fields in `PropertyAccessVisitor`
**File:** `packages/core/src/plugins/analysis/ast/visitors/PropertyAccessVisitor.ts`
**Lines:** 114–171 (capture + store in push)

In `extractPropertyAccesses`, after computing the `id`, add to each pushed `PropertyAccessInfo`:
```ts
scopePath: scopeTracker?.getContext().scopePath ?? [],
enclosingClassName: (() => {
  if (baseName === 'this') {
    return (scopeTracker as any)?.getEnclosingScope?.('CLASS') ?? undefined;
  }
  return undefined;
})(),
```

**Note on `getEnclosingScope`:** This is the same method called from `JSASTAnalyzer.ts` lines 3685, 4212, 4337. It is available on `ScopeTracker`. We need to verify its signature in ScopeTracker to confirm.

**Complication for module-level visitor:** The module-level `getHandlers()` uses `scopeTracker` from constructor — the same ScopeTracker used for other module-level visitors. This is correct.

### Phase 3: Add READS_FROM edges in `CoreBuilder`
**File:** `packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts`
**Function:** `bufferPropertyAccessNodes` (lines 218–244)
**Change:** +30–40 lines of edge-linking logic

Update `buffer()` method to destructure `classDeclarations = []` from `data`. Then in `bufferPropertyAccessNodes`, after buffering the CONTAINS edge, add:

```
objectName resolution logic:
  if objectName === 'this':
    → lookup CLASS node using enclosingClassName (same pattern as MutationBuilder)
    → bufferEdge { type: 'READS_FROM', src: propAccess.id, dst: classNode.id }
  elif objectName === 'import.meta':
    → skip (no variable/param node to link to)
  elif objectName contains '.':
    → objectName is a chained prefix (e.g., "a.b" for PROPERTY_ACCESS "c" on "a.b")
    → skip linking the base (the base "a" is already linked by an earlier PROPERTY_ACCESS node)
    → OR: link to the PROPERTY_ACCESS node for "a.b" — but we don't have IDs yet at this point
    → Decision: SKIP chained objects for now (see edge cases below)
  else:
    → resolveVariableInScope(objectName, scopePath, file, variableDeclarations)
    → if found: bufferEdge { type: 'READS_FROM', src: propAccess.id, dst: variable.id }
    → else: resolveParameterInScope(objectName, scopePath, file, parameters)
    → if found: bufferEdge { type: 'READS_FROM', src: propAccess.id, dst: parameter.id }
    → else: skip gracefully (external/unknown identifier)
```

**Signature change for `bufferPropertyAccessNodes`:**
```ts
private bufferPropertyAccessNodes(
  module: ModuleNode,
  propertyAccesses: PropertyAccessInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  parameters: ParameterInfo[],
  classDeclarations: ClassDeclarationInfo[]
): void
```

### Phase 4: Add test
**File:** `test/unit/plugins/analysis/ast/property-access.test.ts`
**Action:** Add a new `describe` block at end: "READS_FROM edges for PROPERTY_ACCESS (REG-555)"

Test cases to add:
1. `const x = obj.prop` → PROPERTY_ACCESS "prop" has READS_FROM → VARIABLE "obj"
2. `function f(options) { return options.graph; }` → PROPERTY_ACCESS "graph" has READS_FROM → PARAMETER "options"
3. `class C { m() { return this.val; } }` → PROPERTY_ACCESS "val" with objectName "this" has READS_FROM → CLASS "C"
4. Chained `a.b.c` → PROPERTY_ACCESS "b" (objectName "a") has READS_FROM → VARIABLE "a"; PROPERTY_ACCESS "c" (objectName "a.b") skips (chained object, no direct link)
5. Unknown identifier `unknownObj.prop` → gracefully no READS_FROM edge (no crash)

---

## Edge Cases

### 1. `parameter.prop` → link to PARAMETER node
**Handled:** `resolveParameterInScope` is called as fallback after variable lookup fails.

### 2. `variable.prop` → link to VARIABLE node
**Handled:** `resolveVariableInScope` is called first.

### 3. `this.prop` → link to CLASS node
**Handled:** same as MutationBuilder REG-152 pattern: `enclosingClassName` → find CLASS node. If `enclosingClassName` is undefined (i.e., `this` outside a class), skip gracefully.

### 4. `func().prop` — method call result access
**Handled by not handling:** `PropertyAccessVisitor.extractChain` already returns `[]` for non-Identifier/ThisExpression/MetaProperty base objects (line 354: "Complex expression as base - not trackable"). So no PROPERTY_ACCESS node is created at all for `func().prop`. No edge needed.

### 5. `obj.nested.prop` — chained access
Two PROPERTY_ACCESS nodes are created:
- PA1: objectName="obj", propertyName="nested" → can link to VARIABLE/PARAM "obj"
- PA2: objectName="obj.nested", propertyName="prop" → objectName contains ".", no variable node named "obj.nested" exists

**Decision:** For PA2, skip the READS_FROM edge. The objectName contains a dot → no variable node to link to. The chain already provides transitive connectivity (PA2 is created from the same `obj` which is linked via PA1).

**Alternative considered:** Link PA2 to PA1 (READS_FROM PA1 node). This would be cleaner for tracing but requires looking up PA1 by its semantic ID. Since PROPERTY_ACCESS IDs are computed during visitor phase and stored on the `PropertyAccessInfo`, we COULD do this in CoreBuilder by building a lookup map of property accesses by `semanticId`. However, this adds complexity and the acceptance criteria does not require it. Deferring to a future task.

### 6. `unknownIdentifier.prop` — not in scope
`resolveVariableInScope` and `resolveParameterInScope` both return `null`. **Skip gracefully** — no edge, no warning. This is consistent with MutationBuilder behavior.

### 7. `import.meta.prop`
`objectName === 'import.meta'` — no variable/param node. **Skip** (already handled via early return).

### 8. `new.target`
MetaProperty creates PropertyAccessInfo with `objectName === 'new'`. No variable named "new". `resolveVariableInScope` will return null. Skip gracefully.

### 9. Computed `obj[variable]` — objectName is "obj", propertyName is `<computed>`
**Handled:** The `objectName` is still "obj", so READS_FROM to obj variable is created correctly. The computed property name does not affect the object lookup.

---

## Files to Modify

| File | Current Lines | Change |
|------|---------------|--------|
| `packages/core/src/plugins/analysis/ast/types.ts` | 1291 | Add 2 fields to `PropertyAccessInfo` (+4 lines with comments) |
| `packages/core/src/plugins/analysis/ast/visitors/PropertyAccessVisitor.ts` | 416 | Add `scopePath` + `enclosingClassName` population in `extractPropertyAccesses` (+8 lines) |
| `packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts` | 308 | Add READS_FROM edge emission in `bufferPropertyAccessNodes` (+40 lines) |
| `test/unit/plugins/analysis/ast/property-access.test.ts` | 1007 | Add REG-555 test describe block (+80 lines) |

**Total new code:** ~135 lines across 4 files. No new files.

---

## Implementation Steps (Ordered)

1. **Step 1:** Add `scopePath` and `enclosingClassName` to `PropertyAccessInfo` in `types.ts`.

2. **Step 2:** In `PropertyAccessVisitor.extractPropertyAccesses`, capture `scopeTracker.getContext().scopePath` and (for `this` base) `scopeTracker.getEnclosingScope('CLASS')`. Store both on each pushed `PropertyAccessInfo`.

3. **Step 3:** Verify `ScopeTracker.getEnclosingScope('CLASS')` signature exists (check `packages/core/src/core/ScopeTracker.ts`). If it does not exist, use an alternative method from ScopeTracker.

4. **Step 4:** In `CoreBuilder.buffer()`, destructure `classDeclarations = []` and `parameters = []` from `data` (parameters is already destructured; check if classDeclarations is already there). Pass both to `bufferPropertyAccessNodes`.

5. **Step 5:** Implement READS_FROM edge logic in `bufferPropertyAccessNodes` following the decision tree above.

6. **Step 6:** Write the test cases (TDD: write test first, then verify it passes after Step 5).

7. **Step 7:** `pnpm build` then run `node --test test/unit/plugins/analysis/ast/property-access.test.ts`.

---

## Complexity Assessment

- **Time complexity:** O(P × (V + Pa)) where P = property accesses, V = variable declarations, Pa = parameters per module. The `resolveVariableInScope` does a double loop (scope chain × variables). With lookup caches this could be O(P × S) where S = scope depth. For typical modules, this is well within acceptable bounds. No caching needed for the first implementation — we can optimize later if profiling shows it matters.
- **Space:** O(P) for storing scopePath and enclosingClassName on each PropertyAccessInfo entry.
- **Risk level:** Low. The change is additive: adds new fields and new edges. No existing edges are removed. Worst case is new edges that shouldn't exist — but those would only appear if `resolveVariableInScope` returns false positives, which is well-tested.

---

## Risks and Open Questions

### Risk 1: `getEnclosingScope` availability in PropertyAccessVisitor
The `PropertyAccessVisitor.extractPropertyAccesses` receives a `ScopeTracker | undefined`. The `getEnclosingScope` method is used in `JSASTAnalyzer.ts` directly. We need to verify it is accessible on the `ScopeTracker` class as a public method.

**Mitigation:** If `getEnclosingScope` is not public or doesn't exist on the `ScopeTracker` interface, we skip `this` linking for now and document it as a follow-up. The acceptance criteria says "Works for: this access" — if it's not feasible, clarify with user.

### Risk 2: Module-level `PropertyAccessVisitor` missing scopeTracker
Looking at `getHandlers()` in `PropertyAccessVisitor.ts` (line 56-106): the module-level handler has access to `this.scopeTracker` which may be undefined. When undefined, `scopePath` defaults to `[]` (module scope). This is correct — module-level variables have `scopePath = []` in `resolveVariableInScope`.

### Risk 3: `CoreBuilder` doesn't have `parameters` in its `buffer` signature
Checking `CoreBuilder.buffer()` line 29–43: it already destructures `parameters = []` from `data`. It does NOT destructure `classDeclarations`. We need to add `classDeclarations = []` to the destructuring.

### Open Question: Edge direction
The acceptance criteria says: PROPERTY_ACCESS "graph" has `READS_FROM → PARAMETER "options"`. In the existing graph schema, READS_FROM is used as `src --READS_FROM--> dst` where `src` reads from `dst`. So the edge direction is:
- `src = propAccess.id` (the reader)
- `dst = parameter.id` (the source being read from)

This matches the UpdateExpressionBuilder pattern where READS_FROM self-loops use `src = target, dst = target`.

### Open Question: Should chained objects (PA2 for `a.b.c`) link to PA1?
See edge case #5. Decision: Skip for now. The task acceptance criteria only requires that the BASE case (single-level `options.graph`) works. Chained linking can be a follow-up.

---

## Not Doing (Out of Scope)

- Enrichment-phase alternative: Not needed. We have `scopePath` at analysis time, so we can create the edges during the analysis phase in `CoreBuilder`. Enrichment is for cross-file resolution; this is same-file resolution.
- Linking chained PA2 nodes to PA1 nodes (follow-up task).
- Adding lookup cache optimization to `resolveVariableInScope` (existing optimization concern, not REG-555).
