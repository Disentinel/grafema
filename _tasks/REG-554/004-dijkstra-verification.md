# Dijkstra Verification: REG-554

**Verifier:** Edsger Dijkstra, Plan Verifier
**Date:** 2026-02-22
**Plan under review:** `003-don-plan.md`
**Exploration reviewed:** `002-don-explore.md`

---

## Verdict: REJECT

Two blockers. One architectural flaw in the plan's buffering logic (the `valueNodeId` branch will
never fire for `this.prop = value` assignments). One missing import that will cause a build failure.
Additionally, several minor issues that will produce silent incorrect behavior or test gaps.

---

## Issues Found

### [BLOCKER 1] `valueNodeId` is never populated by `extractMutationValue()` for `this.prop = value`

**Plan section:** Step 6d, lines 371–378 in `003-don-plan.md`:

```typescript
// Pre-resolved node IDs (LITERAL, OBJECT_LITERAL, ARRAY_LITERAL from valueNodeId)
if (propAssign.valueNodeId) {
  this.ctx.bufferEdge({
    type: 'ASSIGNED_FROM',
    src: propAssign.id,
    dst: propAssign.valueNodeId,
  });
}
```

**Finding:** `extractMutationValue()` (JSASTAnalyzer.ts lines 4536–4559) does NOT set
`valueNodeId`. It only sets:
- `valueType: 'LITERAL'` + `literalValue` (raw value, not a node ID) for literals
- `valueType: 'VARIABLE'` + `valueName` for identifiers
- `valueType: 'CALL'` + `callLine`/`callColumn` for calls
- `valueType: 'OBJECT_LITERAL'` / `'ARRAY_LITERAL'` / `'EXPRESSION'` with no ID

`valueNodeId` IS populated in other paths (e.g., `ObjectPropertyExtractor`, array argument
processing where nodes are pre-created during traversal), but `extractMutationValue()` — the
specific function used inside `detectObjectPropertyAssignment()` — never creates or assigns a
`valueNodeId`. The `ObjectMutationValue` interface shows `valueNodeId` as `optional`.

**Consequence:** The `PropertyAssignmentInfo.valueNodeId` field will always be `undefined` when
populated from `detectObjectPropertyAssignment()`. The `if (propAssign.valueNodeId)` branch in
`bufferPropertyAssignmentNodes()` will never execute. This is not a correctness problem for the
acceptance criteria (which only require VARIABLE resolution), but the plan's comment — "For
LITERAL/OBJECT_LITERAL/ARRAY_LITERAL: pre-resolved node ID" — is factually wrong and will confuse
Rob. The `valueNodeId` field should either be removed from `PropertyAssignmentInfo` entirely, or the
plan must explicitly document that it will always be `undefined` in V1 and the branch is dead code.

**Fix required:** Remove `valueNodeId` from `PropertyAssignmentInfo`. Remove the `valueNodeId`
branch from `bufferPropertyAssignmentNodes()`. Document in the plan that LITERAL type means the
assignment value is an inline literal with no pre-resolved node ID and no `ASSIGNED_FROM` edge in
V1. This is consistent with how `MutationBuilder.bufferObjectMutationEdges()` handles literals
(silently skips them, line 244 comment).

---

### [BLOCKER 2] `computeSemanticIdV2` is not imported in `JSASTAnalyzer.ts`

**Plan section:** Step 4, Risk 1, lines 481–484 in `003-don-plan.md`.

**Finding:** Confirmed by grep. `JSASTAnalyzer.ts` imports only `computeSemanticId` (line 55):
```typescript
import { computeSemanticId } from '../../core/SemanticId.js';
```
There is no `computeSemanticIdV2` import anywhere in `JSASTAnalyzer.ts`.

The plan acknowledges this as "Risk 1" but leaves mitigation to Rob: "Rob must verify the import
path before implementing Step 4." This is insufficient — a plan that defers a required import to
implementer discovery is incomplete. The plan must specify the exact import line to add.

**Fix required:** Add to Step 4 the explicit import statement:
```typescript
import { computeSemanticId, computeSemanticIdV2 } from '../../core/SemanticId.js';
```
(Replace the existing single-name import at line 55.) This must be listed as an explicit sub-step in
the implementation order, not buried in a risk section.

---

## Minor Issues

### [MINOR 1] `this['x'] = value` (computed string property): classified as `'property'`, not `'computed'`

**Plan section:** Section 3 (`PropertyAssignmentInfo`), `computed?: boolean`.

**Finding:** In `detectObjectPropertyAssignment()`, lines 4241–4243:
```typescript
if (memberExpr.property.type === 'StringLiteral') {
  propertyName = memberExpr.property.value;
  mutationType = 'property'; // String literal is effectively a property name
}
```
So `this['x'] = value` sets `mutationType = 'property'` and `computed: false`. The PROPERTY_ASSIGNMENT
node will have `name: 'x'` and `computed: undefined/false`. This is correct behavior — a string literal
computed property is semantically equivalent to a dot-access property. But the plan's enumeration of
"what happens with `this['x'] = value`" is missing from the edge case analysis. Rob should know this
case is handled and produces a normal (non-computed) node.

### [MINOR 2] `this.x = value` inside a static method: `enclosingClassName` IS set, guard fires

**Finding:** `scopeTracker.getEnclosingScope('CLASS')` returns the class name regardless of whether
the method is static. A static method `this.x = value` is unusual JavaScript (valid only for static
class fields), but the current code will create a PROPERTY_ASSIGNMENT node with
`className: 'MyClass'`. This may or may not be the desired behavior. The plan does not address it.

**Recommendation:** Document this case explicitly. The guard `objectName === 'this' &&
enclosingClassName` will produce a node for static method `this.x = value`. This is acceptable for
V1 — static class property assignments are rare and the node created is still semantically meaningful.
Add a comment in the code and note it as a known edge case.

### [MINOR 3] `this.x = value` inside a class field initializer (no method): `enclosingClassName` behavior undefined

**Finding:** Class field initializers (ES2022 syntax):
```javascript
class Foo {
  bar = this.baz;  // 'this' in a class field initializer
}
```
This is not an `AssignmentExpression` node — it is a `ClassProperty` / `ClassAccessorProperty` node.
`detectObjectPropertyAssignment()` only fires on `AssignmentExpression`, so this case does not reach
the new code at all. The plan is implicitly correct (no node created) but does not explain why.

### [MINOR 4] `this.x = value` inside a derived class method: handled correctly but not stated

**Finding:** `scopeTracker.getEnclosingScope('CLASS')` returns the name of the immediately enclosing
class, not the base class. For a derived class, `className` will be the derived class name. This is
correct behavior (the assignment is in the derived class). No code change needed, but the plan is
silent on this case.

### [MINOR 5] Two classes with the same basename in different directories

**Plan section:** Step 6d, the `classDeclarations.find()` lookup:
```typescript
const fileBasename = basename(propAssign.file);
const classDecl = classDeclarations.find(c =>
  c.name === propAssign.enclosingClassName && c.file === fileBasename
);
```

**Finding:** This is the same limitation that exists in `bufferPropertyAccessNodes()`. If a project
has `src/auth/User.ts` and `src/billing/User.ts`, both defining a `User` class, the `find()` call
may match the wrong class node. The plan acknowledges this is the same constraint as PROPERTY_ACCESS
(Constraint 1 in exploration, Risk 3 in plan) but does not flag it as a known limitation that should
be documented in the code comment. This is not a new problem introduced by this task, but a test with
a subdirectory fixture (as Risk 3 recommends) should be included.

### [MINOR 6] Semantic ID of PROPERTY_ASSIGNMENT uses `scopeTracker.getNamedParent()` — which scope is "named parent"?

**Plan section:** Step 4 ID generation block:
```typescript
assignmentId = computeSemanticIdV2(
  'PROPERTY_ASSIGNMENT',
  fullName,
  module.file,
  scopeTracker.getNamedParent(),
  undefined,
  discriminator
);
```

**Finding:** `computeSemanticIdV2` is called identically to `PropertyAccessVisitor.ts` line 151.
The `getNamedParent()` call returns the nearest named parent scope (e.g., the constructor function
name). This means two PROPERTY_ASSIGNMENT nodes for `this.graph` in the constructor vs. a regular
method will have different semantic IDs (different `getNamedParent()` values). This is **correct**
behavior — each assignment site is distinct. The plan mentions this in Risk 4 but frames it only as
"multiple assignments to same property." The more important case is same property assigned in
different methods, which the plan does not enumerate explicitly. No code change needed, but the plan
should state this explicitly to prevent Rob from second-guessing.

### [MINOR 7] Test group 5 (semantic ID stability) may be fragile

**Plan section:** Section 4, Test group 5.

The plan says "run orchestrator twice on the same code" and compare `semanticId`. This is good.
However, the test plan does not specify how to get the `semanticId` out of the graph — the test
pattern from `ObjectMutationTracking.test.js` queries edges, not node fields. The test writer (Kent)
needs to know which API to use to retrieve node attributes (e.g., `backend.getNode(id)` or
equivalent). This is a test-writing gap, not a code gap, but should be clarified.

### [MINOR 8] `MemberExpression` RHS (`this.x = other.y`, `this.x = this.y`) produces `valueType: 'EXPRESSION'`

**Finding:** `extractMutationValue()` does not have a branch for `MemberExpression`. If the RHS is
`other.y` or `this.y`, it falls through to the default `valueType: 'EXPRESSION'` with no
`valueName`. The PROPERTY_ASSIGNMENT node is still created; no ASSIGNED_FROM edge is created. This
is acceptable for V1 (per the plan's open question section). The plan correctly defers MEMBER_EXPRESSION
RHS resolution. However, the test suite should include one assertion that `this.x = options.graph!`
(a MemberExpression — note the `!` non-null assertion makes this a TSNonNullExpression wrapping
a MemberExpression) does NOT cause an error — i.e., the node is created but no ASSIGNED_FROM edge
is emitted without crashing.

**Follow-up:** The acceptance criteria in the Linear issue mention `this.graph = options.graph!` as
the motivating example. If this is a TypeScript non-null assertion, the RHS AST node is
`TSNonNullExpression` wrapping a `MemberExpression`. `extractMutationValue()` does not handle either
of these. The PROPERTY_ASSIGNMENT node is created, but AC1 ("ASSIGNED_FROM edge to rhs") is NOT met
for this specific example if "rhs" means `options.graph`. Rob must be aware of this. If AC1 requires
an ASSIGNED_FROM edge for the `options.graph!` example, MEMBER_EXPRESSION resolution cannot be
deferred.

**This is the most significant acceptance criteria risk in the plan.** The plan defers CALL and
MEMBER_EXPRESSION resolution, but the canonical motivating example (`this.graph = options.graph!`)
is itself a MemberExpression. If the acceptance criteria requires an ASSIGNED_FROM edge for this
case, the plan is incomplete.

---

## Edge Cases Enumerated

| Case | Behavior | Correct? |
|------|----------|----------|
| `this.x = value` at module level (no class) | `enclosingClassName` is `undefined`; guard fails; no PROPERTY_ASSIGNMENT node | Correct |
| `this.x = value` in derived class method | `enclosingClassName` = derived class name; node created with derived class | Correct |
| `this.x = value` in static method | `enclosingClassName` set; node created (unusual but valid JS) | Acceptable, document |
| `this.x = value` in class field initializer | Not an `AssignmentExpression`; `detectObjectPropertyAssignment` never called; no node | Correct |
| `this['x'] = value` (string literal key) | `mutationType = 'property'`, `computed: false`, `propertyName = 'x'` | Correct |
| `this[key] = value` (computed key) | `mutationType = 'computed'`, `propertyName = '<computed>'` | Correct |
| `obj.prop = value` (non-`this`) | Guard `objectName === 'this'` fails; no PROPERTY_ASSIGNMENT node | Correct (in-scope) |
| RHS = VARIABLE (identifier) | `valueType: 'VARIABLE'`, `valueName` set; ASSIGNED_FROM edge resolved via scope | Correct |
| RHS = LITERAL (string/number/bool/null) | `valueType: 'LITERAL'`; no `valueNodeId`; no ASSIGNED_FROM edge | Correct for V1, but `valueNodeId` field in interface is misleading |
| RHS = CALL expression | `valueType: 'CALL'`; no ASSIGNED_FROM edge | Correct for V1 |
| RHS = MemberExpression (`this.x = other.y`) | `valueType: 'EXPRESSION'`; no ASSIGNED_FROM edge | Correct for V1 |
| RHS = `this.y` (self-reference) | `valueType: 'EXPRESSION'`; no ASSIGNED_FROM edge | Correct for V1 |
| RHS = `new Foo()` | `valueType: 'EXPRESSION'`; no ASSIGNED_FROM edge | Correct for V1 |
| RHS = template literal | `valueType: 'EXPRESSION'`; no ASSIGNED_FROM edge | Correct for V1 |
| RHS = `options.graph!` (TSNonNullExpression) | `valueType: 'EXPRESSION'`; no ASSIGNED_FROM edge | **Conflicts with AC1 example** |
| Variable not found in scope | `sourceVar` and `sourceParam` both `null`; no ASSIGNED_FROM edge; no crash | Correct |
| Two classes with same basename | Wrong CLASS node may be linked by `classDeclarations.find()` | Known limitation, pre-existing |
| Two properties with same name in same class | Different discriminator; distinct semantic IDs | Correct |
| Constructor vs method assignment of same property | Different `getNamedParent()`; distinct semantic IDs | Correct |
| No CLASS node exists yet when PROPERTY_ASSIGNMENT buffered | `classDecl` is `undefined`; CONTAINS edge silently skipped | Correct (same as PROPERTY_ACCESS) |

---

## Confirmed Correct

1. **`ASSIGNED_FROM` edge exists in `edges.ts`** (line 57). No new edge types needed. Confirmed.
2. **`CONTAINS` edge exists and the direction `CLASS --CONTAINS--> PROPERTY_ASSIGNMENT` is consistent** with `bufferPropertyAccessNodes()` lines 246–252. Confirmed.
3. **`NodeRecord` union update is needed** and the plan addresses it correctly. Adding `PropertyAssignmentNodeRecord` to the union is required for TypeScript to accept the new node type without falling through to `BaseNodeRecord`. Confirmed.
4. **The guard `objectName === 'this' && enclosingClassName`** correctly excludes module-level `this.x` assignments (where `enclosingClassName` is `undefined`). Confirmed.
5. **`extractMutationValue()` return shape** (`ObjectMutationValue`) maps correctly to the `valueType`/`valueName` fields in `PropertyAssignmentInfo`. The mapping in Step 4 is correct. Confirmed.
6. **Basename normalization** (`basename(propAssign.file)`) for `classDeclarations.find()` matches the existing pattern in `bufferPropertyAccessNodes()`. Confirmed.
7. **`propertyAssignmentCounterRef` as a shared counter** across both call sites (module-level in `JSASTAnalyzer.ts` and function-body level in `VariableHandler.ts`) correctly prevents ID collisions within the same file. Confirmed.
8. **Test groups 1–4** cover the core acceptance criteria. The fixture in test group 1 (3 constructor assignments) satisfies AC3 directly.
9. **No changes needed to `GraphBuilder.ts`** — `data: ASTCollections` is passed wholesale to builders; if `propertyAssignments` is populated it will reach `CoreBuilder`. Confirmed by reviewing `buffer()` method signature.
10. **`PROPERTY_ASSIGNMENT` placement in `NODE_TYPE`** after `PROPERTY_ACCESS` is consistent with the "read/write pair" grouping rationale. Confirmed.

---

## Summary of Required Fixes Before Implementation

**BLOCKER 1 fix (must be done by Don or incorporated by Rob before Step 6):**
- Remove `valueNodeId?: string` from `PropertyAssignmentInfo` interface.
- Remove the `if (propAssign.valueNodeId)` branch from `bufferPropertyAssignmentNodes()`.
- Add explicit comment: "LITERAL, OBJECT_LITERAL, ARRAY_LITERAL, CALL, EXPRESSION RHS types produce no ASSIGNED_FROM edge in V1. `extractMutationValue()` does not pre-resolve node IDs for these types."

**BLOCKER 2 fix (must be incorporated into Step 4):**
- Change the existing import in `JSASTAnalyzer.ts` line 55:
  ```typescript
  // Before:
  import { computeSemanticId } from '../../core/SemanticId.js';
  // After:
  import { computeSemanticId, computeSemanticIdV2 } from '../../core/SemanticId.js';
  ```
  List this as an explicit sub-step in Section 7 (Implementation Order Summary).

**AC1 clarification required (must be resolved with product owner before implementation):**
- The motivating example `this.graph = options.graph!` is a TSNonNullExpression over a MemberExpression.
- `extractMutationValue()` classifies this as `'EXPRESSION'`, producing no ASSIGNED_FROM edge.
- If AC1 requires an ASSIGNED_FROM edge pointing to `options` (the object) or `options.graph` (a property access), MemberExpression resolution cannot be deferred.
- If AC1 only requires the PROPERTY_ASSIGNMENT node to be created (with the edge being best-effort), the plan is acceptable.
- This must be clarified before Rob writes a single line of code.
