## Dijkstra Plan Verification — REG-554

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-22

**Verdict:** APPROVE (with one documented precondition and one noted gap)

**Completeness tables:** 6 built

**Summary:** The plan is structurally sound and all major claims check out against the actual code. Two findings require documentation but do not block implementation.

---

## Table 1: `detectObjectPropertyAssignment` — what gets a PROPERTY_ASSIGNMENT?

Guard: `if (propertyAssignments && objectName === 'this' && enclosingClassName)`

| Input | `objectName` | `enclosingClassName` from `getEnclosingScope('CLASS')` | PROPERTY_ASSIGNMENT created? | Correct? |
|---|---|---|---|---|
| `this.x = v` in constructor | `'this'` | className (CLASS on stack) | YES | YES |
| `this.x = v` in class method | `'this'` | className (CLASS on stack) | YES | YES |
| `this.x = v` in arrow function inside method | `'this'` | className (CLASS still on stack — arrow enters `'arrow'` scope, not `'CLASS'`) | YES | YES — arrow function does NOT pop CLASS from scope stack |
| `this.x = v` in standalone function | `'this'` | `undefined` (no CLASS on stack) | NO | YES |
| `this.x = v` at module scope | `'this'` | `undefined` (no CLASS on stack, module-level traversal has `functionParent` guard that returns early before reaching `this`) | NO | YES |
| `obj.x = v` (not `this`) | `'obj'` | irrelevant | NO — `objectName !== 'this'` | YES |
| `this.x.y = v` nested LHS | early return (complex expression) | N/A | NO | YES — documented known limitation |
| `this[key] = v` computed | `'this'` | className | YES with `name='<computed>'` | YES — documented |
| `this['str'] = v` string literal | `'this'` | className | YES with `name='str'` | YES |
| `this.x += v` compound | `'this'` | className | YES (operator not checked) | YES — documented in plan |

**Verification of arrow function case:** `NestedFunctionHandler.ts` line 166 calls `scopeTracker.enterScope(funcName, 'arrow')`. `ScopeTracker.getEnclosingScope('CLASS')` walks from innermost to outermost (line 130-135 of `ScopeTracker.ts`) and finds the CLASS entry. Arrow functions inherit `this` lexically — and the scope stack correctly reflects this by keeping the CLASS entry. No gap.

---

## Table 2: Two call sites for `detectObjectPropertyAssignment`

| Call site | Location | Has `scopeTracker`? | Has `propertyAssignments`? | Plan's update |
|---|---|---|---|---|
| Module-level | `JSASTAnalyzer.ts` line 1942 | YES (`scopeTracker` in scope) | NO currently, plan adds `allCollections.propertyAssignments` | `allCollections` is confirmed in scope at line 1802 |
| Function-level | `VariableHandler.ts` line 91 via `AnalyzerDelegate` | YES (`ctx.scopeTracker`) | NO currently, plan adds `ctx.collections.propertyAssignments` | `ctx.collections` is `VisitorCollections` which has `[key: string]: unknown` — arbitrary keys allowed |

**Verification:** `allCollections` is declared at JSASTAnalyzer.ts line 1802, before both the `traverse_assignments` block (line 1867) and the `traverse_classes` block (line 1962). The module-level call site at line 1942 is inside the `traverse_assignments` block, so `allCollections` is in scope. Confirmed.

**Verification:** `VisitorCollections` (ASTVisitor.ts line 48) has `[key: string]: unknown`. `ctx.collections.propertyAssignments` will work by dynamic key access. No TypeScript error. Confirmed.

---

## Table 3: `ClassDeclarationInfo.file` matching

The plan claims: "both are `module.file`."

| Source | How `file` is set |
|---|---|
| `ClassDeclarationInfo.file` | `ClassNode.createWithContext()` sets `file: context.file` where `context = scopeTracker.getContext()` and ScopeTracker is constructed with `module.file` (ScopeTracker constructor line 44) |
| `PropertyAssignmentInfo.file` | `file: module.file` (set directly in `detectObjectPropertyAssignment`) |

Both are `module.file`. The `PropertyAssignmentBuilder.classDeclarations.find(c => c.name === pa.enclosingClassName && c.file === pa.file)` comparison is safe. This is the same pattern used by `MutationBuilder.bufferObjectMutationEdges` line 197 (`c.file === file`). **Confirmed correct.**

Note: The REG-555 bug mentioned in the plan involved `CoreBuilder` comparing file basenames vs full paths from two different data sources. That bug does NOT apply here because both sides come from the same `module.file`.

---

## Table 4: `resolveVariableInScope` / `resolveParameterInScope` existence

| Method | Exists in `BuilderContext`? | Location |
|---|---|---|
| `resolveVariableInScope` | YES | `builders/types.ts` line 42 |
| `resolveParameterInScope` | YES | `builders/types.ts` line 49 |

Both are implemented and used by `MutationBuilder`, `CoreBuilder`, `CallFlowBuilder`. The `PropertyAssignmentBuilder` can call them identically. **Confirmed.**

---

## Table 5: `computeSemanticId` API usage

The plan calls: `computeSemanticId('PROPERTY_ASSIGNMENT', ..., scopeTracker.getContext(), { discriminator: ... })`

| Check | Result |
|---|---|
| Function exists | YES — `SemanticId.ts` line 118 |
| Signature matches | YES — `(type, name, context: ScopeContext, options?: SemanticIdOptions)` |
| JSASTAnalyzer imports it | YES — `JSASTAnalyzer.ts` line 55: `import { computeSemanticId } from '../../core/SemanticId.js'` |
| Consistent with other PROPERTY_ASSIGNMENT IDs | YES — same V1 API used throughout JSASTAnalyzer |

**Confirmed.**

---

## Table 6: Duplicate property assignments (edge case from verification spec)

```js
class Foo {
  constructor(x) {
    this.x = x;
    this.x = null; // reassignment
  }
}
```

| What happens | Correct? |
|---|---|
| Two calls to `detectObjectPropertyAssignment` | YES — each `AssignmentExpression` node fires independently |
| Two `PropertyAssignmentInfo` entries pushed | YES |
| Discriminator: `scopeTracker.getItemCounter('PROPERTY_ASSIGNMENT:this.x')` returns 0 for first, 1 for second | YES — `getItemCounter` increments on each call |
| Two distinct semantic IDs | YES — `#0` and `#1` |
| Two PROPERTY_ASSIGNMENT nodes in graph | YES |
| Both linked to CLASS via CONTAINS | YES |

This is correct behavior. The plan does not mention it explicitly, but `getItemCounter` handles this automatically. No deduplication needed at the node level — each assignment is a distinct event. **No gap.**

---

## Gaps Found

### Gap 1: `callColumn` type mismatch in ASSIGNED_FROM lookup (minor, documented)

In `PropertyAssignmentBuilder`, the CALL resolution:
```ts
callSites.find(cs => cs.line === pa.callLine && cs.column === pa.callColumn && cs.file === pa.file)
```

`pa.callColumn` comes from `extractMutationValue`: `value.loc?.start.column` which is `number | undefined`.
`cs.column` comes from `getColumn(callNode)` which is always `number` (0 fallback).

If `pa.callColumn` is `undefined`, the comparison `number === undefined` is `false` — no match. This means `ASSIGNED_FROM` edges for CALL-typed RHS values would silently fail when Babel strips location info.

**In practice:** Babel always provides `loc` for real source code, so `callColumn` will always be a number. This is a theoretical edge case that would only manifest with malformed/synthetic AST input.

**Recommendation:** Non-blocking. The plan's test cases use real code. Document the assumption in a comment in the builder.

### Gap 2: `createTestOrchestrator` does NOT need updating

The MEMORY.md note warns that new enrichment plugins must be added to `createTestOrchestrator`. This does NOT apply here. `PropertyAssignmentBuilder` is a `DomainBuilder` called inside `GraphBuilder.build()`, which is invoked by `JSASTAnalyzer` (already in the orchestrator). No orchestrator change needed. The plan correctly omits this.

---

## Precondition Issues

### Precondition 1: `enclosingClassName` requires `scopeTracker` to be non-null

When `detectObjectPropertyAssignment` is called WITHOUT a `scopeTracker`, `enclosingClassName` is always `undefined` (line 4208-4213 of JSASTAnalyzer.ts: `if (scopeTracker) { enclosingClassName = ... }`). Without `scopeTracker`, no PROPERTY_ASSIGNMENT is ever created.

**Is this guaranteed to be safe?** YES. `scopeTracker` is always passed at both call sites (module-level: `scopeTracker` is in scope from line 1802; function-level: `ctx.scopeTracker` which is always provided for class methods). The `?` makes it optional in the signature for backward compatibility, but in practice it's always non-null for class method contexts.

**If scopeTracker is null:** PROPERTY_ASSIGNMENT nodes silently not created. The fallback ID `PROPERTY_ASSIGNMENT#${propertyName}#${module.file}#${line}:${column}` in the plan is never reached when `propertyAssignments` is provided but `scopeTracker` is null — the outer guard `enclosingClassName` being `undefined` prevents the push. This is correct defensive behavior.

### Precondition 2: `classDeclarations` must be populated before `PropertyAssignmentBuilder.buffer()` runs

`PropertyAssignmentBuilder` looks up `classDeclarations.find(c => ...)` to create the `CLASS --CONTAINS--> PROPERTY_ASSIGNMENT` edge.

`classDeclarations` is populated by `ClassVisitor` which runs in `traverse_classes` (JSASTAnalyzer.ts line 1961-1970). `GraphBuilder.buffer()` is called AFTER the entire analysis phase completes. Therefore `classDeclarations` is always fully populated when `PropertyAssignmentBuilder.buffer()` runs.

**Confirmed.** The `_coreBuilder`, `_mutationBuilder`, and all other builders already rely on this same ordering. No gap.

---

## Verdict: APPROVE

All classification rules have been enumerated and verified. The two call sites are confirmed to exist and be correctly threaded. The `resolveVariableInScope` / `resolveParameterInScope` methods are confirmed to exist. The `ClassDeclarationInfo.file` matching is confirmed correct. The semantic ID API is correct.

The plan is ready for implementation by Rob.

**One implementation note for Rob:** In `PropertyAssignmentBuilder`, when matching CALL-typed RHS by `(cs.column === pa.callColumn)`, add a defensive comment noting that `pa.callColumn` can theoretically be `undefined` (though Babel always provides loc for real code). The match will correctly fail silently in that case, which is acceptable per the plan's design (no ASSIGNED_FROM edge for unresolved calls).
