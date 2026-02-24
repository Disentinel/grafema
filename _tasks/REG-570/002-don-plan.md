# REG-570 Implementation Plan — Don Melton

**Task:** ClassVisitor: missing ASSIGNED_FROM edges for class field initializers

## Problem Summary

`ClassVisitor` creates `VARIABLE` nodes for class field declarations but never calls
`trackVariableAssignment` to wire them to their initializer expressions. This causes
`DataFlowValidator.ERR_MISSING_ASSIGNMENT` for every class field that has an initializer,
producing 1330 false warnings on Grafema's own codebase.

Fields with **no initializer** (`name: string;`) are legitimately uninitialized at the
JS level. `DataFlowValidator` currently emits `ERR_MISSING_ASSIGNMENT` for these too —
that must be suppressed with a dedicated exemption.

---

## Verification of Exploration Findings

Source code confirmed at these exact paths and line numbers:

| File | Line | Finding |
|------|------|---------|
| `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` | 99–108 | Constructor takes 4 params: `module`, `collections`, `analyzeFunctionBody`, `scopeTracker`. No `trackVariableAssignment` param. |
| `ClassVisitor.ts` | 164–201 | `indexClassFieldDeclaration` pushes to `collections.variableDeclarations` — **no** `trackVariableAssignment` call. |
| `ClassVisitor.ts` | 589–624 | `ClassPrivateProperty` else-branch pushes to `collections.variableDeclarations` — **no** `trackVariableAssignment` call. |
| `ClassVisitor.ts` | 827 | `ClassExpression` handler calls `this.indexClassFieldDeclaration(...)` — will be fixed for free once the method is fixed. |
| `JSASTAnalyzer.ts` | 1969–1974 | `new ClassVisitor(module, allCollections, this.analyzeFunctionBody.bind(this), scopeTracker)` — 4-arg call site. |
| `JSASTAnalyzer.ts` | 612–625 | `trackVariableAssignment` signature: 13 parameters (initNode, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef, arrayLiterals, arrayLiteralCounterRef). |
| `JSASTAnalyzer.ts` | 1795–1801 | Pattern to follow: `VariableVisitor` receives `this.trackVariableAssignment.bind(this)` as 4th constructor arg. |
| `DataFlowValidator.ts` | 67–78 | `leafTypes` set — missing `'ARRAY_LITERAL'` and `'OBJECT_LITERAL'`. |
| `DataFlowValidator.ts` | 96–110 | No-assignment check — must skip `isClassProperty` nodes where `propNode.value` is absent. |

`allCollections` (built at line 1805–1856) includes all required collections:
`literals`, `variableAssignments`, `literalCounterRef`, `objectLiterals`,
`objectProperties`, `objectLiteralCounterRef`, `arrayLiterals`, `arrayLiteralCounterRef`.
All are present when `allCollections` is passed to `ClassVisitor`, so no new collections
need to be threaded through.

---

## Implementation Plan

### Change 1 — `ClassVisitor.ts`: Add `trackVariableAssignment` callback

**File:** `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`

#### 1a. Import the callback type (after existing imports)

After line 29 (`import type { AnalyzeFunctionBodyCallback } from './FunctionVisitor.js';`),
add:

```typescript
import type { TrackVariableAssignmentCallback } from './VariableVisitor.js';
```

#### 1b. Add private field (line 91, after `private scopeTracker`)

```typescript
private trackVariableAssignment: TrackVariableAssignmentCallback;
```

#### 1c. Extend constructor (lines 99–108) — add 5th parameter

Replace:
```typescript
constructor(
  module: VisitorModule,
  collections: VisitorCollections,
  analyzeFunctionBody: AnalyzeFunctionBodyCallback,
  scopeTracker: ScopeTracker  // REQUIRED, not optional
) {
  super(module, collections);
  this.analyzeFunctionBody = analyzeFunctionBody;
  this.scopeTracker = scopeTracker;
}
```

With:
```typescript
constructor(
  module: VisitorModule,
  collections: VisitorCollections,
  analyzeFunctionBody: AnalyzeFunctionBodyCallback,
  scopeTracker: ScopeTracker,  // REQUIRED, not optional
  trackVariableAssignment: TrackVariableAssignmentCallback  // REG-570
) {
  super(module, collections);
  this.analyzeFunctionBody = analyzeFunctionBody;
  this.scopeTracker = scopeTracker;
  this.trackVariableAssignment = trackVariableAssignment;
}
```

#### 1d. Extend `indexClassFieldDeclaration` — add assignment tracking after the `push` (lines 164–201)

`indexClassFieldDeclaration` already has access to `collections`. Add this block
**after** the `collections.variableDeclarations.push(...)` call at line 186–200, still
inside the `if (!propNode.computed && !(propNode as any).declare)` guard:

```typescript
// REG-570: wire initializer to VARIABLE node via ASSIGNED_FROM edge
if (propNode.value) {
  this.trackVariableAssignment(
    propNode.value,
    fieldId,
    propName,
    module,
    propLine,
    (collections.literals ?? []) as unknown[],
    (collections.variableAssignments ?? []) as unknown[],
    (collections.literalCounterRef ?? { value: 0 }) as CounterRef,
    (collections.objectLiterals ?? []) as unknown[],
    (collections.objectProperties ?? []) as unknown[],
    (collections.objectLiteralCounterRef ?? { value: 0 }) as CounterRef,
    (collections.arrayLiterals ?? []) as unknown[],
    (collections.arrayLiteralCounterRef ?? { value: 0 }) as CounterRef,
  );
}
```

`CounterRef` is already imported via `ASTVisitor.ts` in the visitor base — if not, add:
```typescript
import type { CounterRef } from './ASTVisitor.js';
```

#### 1e. Extend `ClassPrivateProperty` else-branch (lines 589–624) — same pattern

In the `else` block starting at line 589 (the non-function private field path), after
`(collections.variableDeclarations as VariableDeclarationInfo[]).push({...})` at line
600–612, add:

```typescript
// REG-570: wire initializer to VARIABLE node via ASSIGNED_FROM edge
if (propNode.value) {
  this.trackVariableAssignment(
    propNode.value as any,  // ClassPrivateProperty.value is typed differently in Babel
    variableId,
    displayName,
    module,
    propLine,
    (collections.literals ?? []) as unknown[],
    (collections.variableAssignments ?? []) as unknown[],
    (collections.literalCounterRef ?? { value: 0 }) as CounterRef,
    (collections.objectLiterals ?? []) as unknown[],
    (collections.objectProperties ?? []) as unknown[],
    (collections.objectLiteralCounterRef ?? { value: 0 }) as CounterRef,
    (collections.arrayLiterals ?? []) as unknown[],
    (collections.arrayLiteralCounterRef ?? { value: 0 }) as CounterRef,
  );
}
```

Note: `ClassExpression` at line 827 calls `this.indexClassFieldDeclaration(...)` and
thus gets the fix for **public** fields automatically.

#### 1f. Extend `ClassExpression` handler's `classPath.traverse()` — add `ClassPrivateProperty` handler (Dijkstra fix)

**Gap found by Dijkstra:** The `ClassExpression` handler (lines 772–879) only registers
`ClassProperty` and `ClassMethod` visitors — it does NOT register `ClassPrivateProperty`.
This means private fields in class expressions (`const MyClass = class { #count = 42; }`)
will NOT get ASSIGNED_FROM edges.

**Fix:** Add a `ClassPrivateProperty` handler to the `ClassExpression`'s `classPath.traverse()`
block (after the `ClassMethod` handler at line 878), following the same pattern as the
`ClassDeclaration` handler's `ClassPrivateProperty` block (lines 518–624). The handler must:
1. Skip if not direct child of current class body
2. Extract private name with `#` prefix
3. If value is function → create FUNCTION node (same as ClassDeclaration path)
4. If value is non-function → push to `variableDeclarations` AND call `trackVariableAssignment` if `propNode.value` exists

---

### Change 2 — `JSASTAnalyzer.ts`: Pass callback to ClassVisitor

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

At lines 1969–1974, change:

```typescript
const classVisitor = new ClassVisitor(
  module,
  allCollections,
  this.analyzeFunctionBody.bind(this),
  scopeTracker  // Pass ScopeTracker for semantic ID generation
);
```

To:

```typescript
const classVisitor = new ClassVisitor(
  module,
  allCollections,
  this.analyzeFunctionBody.bind(this),
  scopeTracker,  // Pass ScopeTracker for semantic ID generation
  this.trackVariableAssignment.bind(this) as TrackVariableAssignmentCallback  // REG-570
);
```

`TrackVariableAssignmentCallback` is already imported from `VariableVisitor.js` at line
1799 in the existing `variableVisitor` call — confirm the import exists or add it.

---

### Change 3 — `DataFlowValidator.ts`: Fix false positives

**File:** `packages/core/src/plugins/validation/DataFlowValidator.ts`

#### 3a. Add `ARRAY_LITERAL` and `OBJECT_LITERAL` to `leafTypes` (lines 67–78)

Replace:
```typescript
const leafTypes = new Set([
  'LITERAL',
  'net:stdio',
  'db:query',
  'net:request',
  'fs:operation',
  'event:listener',
  'CLASS',
  'FUNCTION',
  'CALL',
  'CONSTRUCTOR_CALL'
]);
```

With:
```typescript
const leafTypes = new Set([
  'LITERAL',
  'ARRAY_LITERAL',   // REG-570
  'OBJECT_LITERAL',  // REG-570
  'net:stdio',
  'db:query',
  'net:request',
  'fs:operation',
  'event:listener',
  'CLASS',
  'FUNCTION',
  'CALL',
  'CONSTRUCTOR_CALL'
]);
```

#### 3b. Suppress `ERR_MISSING_ASSIGNMENT` for uninitialized class fields (lines 96–110)

Class fields with no initializer (e.g., `name: string;`) are legitimately uninitialized
in JS — they produce a VARIABLE node with `isClassProperty: true` but no assignment.
These should NOT produce a warning.

Replace the no-assignment block:
```typescript
if (!assignment) {
  errors.push(new ValidationError(
    `Variable "${variable.name}" (${variable.file}:${variable.line}) has no ASSIGNED_FROM or DERIVES_FROM edge`,
    'ERR_MISSING_ASSIGNMENT',
    { ... },
    undefined,
    'warning'
  ));
  continue;
}
```

With:
```typescript
if (!assignment) {
  // REG-570: Class fields with no initializer are legitimately uninitialized.
  // isClassProperty + no value = TypeScript declaration-only field (e.g., `name: string;`)
  if ((variable as Record<string, unknown>).isClassProperty) {
    continue;
  }
  errors.push(new ValidationError(
    `Variable "${variable.name}" (${variable.file}:${variable.line}) has no ASSIGNED_FROM or DERIVES_FROM edge`,
    'ERR_MISSING_ASSIGNMENT',
    { ... },
    undefined,
    'warning'
  ));
  continue;
}
```

---

## Test Cases

New test file: `test/unit/plugins/analysis/ast/class-field-assigned-from.test.ts`

Pattern: follow `test/unit/plugins/analysis/ast/class-property-declarations.test.ts`
(the REG-552 file) — same helpers (`createTestDatabase`, `createTestOrchestrator`,
`setupTest`).

### Test 1 — Basic initializer creates ASSIGNED_FROM edge
```typescript
class Service {
  private count = 0;
}
```
Assert: VARIABLE node `count` has `ASSIGNED_FROM` edge pointing to a LITERAL node.

### Test 2 — String literal initializer
```typescript
class Config {
  name = 'default';
}
```
Assert: VARIABLE `name` has `ASSIGNED_FROM` → LITERAL.

### Test 3 — Array literal initializer
```typescript
class Renderer {
  phases = ['discovery', 'indexing', 'analysis'];
}
```
Assert: VARIABLE `phases` has `ASSIGNED_FROM` → ARRAY_LITERAL.

### Test 4 — Object literal initializer
```typescript
class Options {
  config = { debug: true };
}
```
Assert: VARIABLE `config` has `ASSIGNED_FROM` → OBJECT_LITERAL.

### Test 5 — Uninitialized field produces no warning (no false positive)
```typescript
class Typed {
  private graph: GraphBackend;
}
```
Assert: VARIABLE `graph` has `isClassProperty === true` and **no** `ASSIGNED_FROM`
edge, and DataFlowValidator produces zero `ERR_MISSING_ASSIGNMENT` for it.

### Test 6 — Private field with initializer
```typescript
class Private {
  #count = 42;
}
```
Assert: VARIABLE `#count` has `ASSIGNED_FROM` → LITERAL.

### Test 7 — Static field with initializer
```typescript
class Statics {
  static MAX = 100;
}
```
Assert: VARIABLE `MAX` has `ASSIGNED_FROM` → LITERAL.

### Test 8 — ClassExpression field (exercising the indirect path via `indexClassFieldDeclaration`)
```typescript
const MyClass = class {
  value = 'hello';
};
```
Assert: VARIABLE `value` has `ASSIGNED_FROM` → LITERAL.

### Test 9 — ClassExpression with private field (Dijkstra gap fix)
```typescript
const MyClass = class {
  #count = 42;
};
```
Assert: VARIABLE `#count` has `ASSIGNED_FROM` → LITERAL.

---

## LOC Estimate

| File | Change | LOC |
|------|--------|-----|
| `ClassVisitor.ts` | Import + field + constructor param | +4 |
| `ClassVisitor.ts` | `indexClassFieldDeclaration` initializer block | +14 |
| `ClassVisitor.ts` | `ClassPrivateProperty` initializer block (ClassDeclaration) | +14 |
| `ClassVisitor.ts` | `ClassPrivateProperty` handler in ClassExpression traverse (Dijkstra fix) | +80 |
| `JSASTAnalyzer.ts` | Pass 5th arg to ClassVisitor | +2 |
| `DataFlowValidator.ts` | Add 2 entries to leafTypes | +2 |
| `DataFlowValidator.ts` | isClassProperty skip guard | +5 |
| **New test file** | 9 test cases | ~170 |
| **Total** | | ~291 |

---

## Risk Assessment

**Low risk.** The change follows a well-established pattern (same as VariableVisitor).
The callback is bound before use and the collections are always present in `allCollections`.

The only non-obvious risk is the Babel type difference for `ClassPrivateProperty.value` —
it is typed as `Expression | null` just like `ClassProperty.value`, so the cast `as any`
is a safe workaround if TypeScript complains about the Babel type variant. Rob should
verify the actual Babel type during implementation and remove the cast if possible.

---

## Open Questions for Dijkstra

1. Should uninitialized class fields (no `propNode.value`) be tracked differently in the
   future — e.g., with a DERIVES_FROM edge to the `undefined` literal? For now, skip
   entirely in DataFlowValidator (`isClassProperty` guard).

2. `TrackVariableAssignmentCallback` in `VariableVisitor.ts` uses `Node` for `initNode`
   (not `t.Expression`), while `JSASTAnalyzer.trackVariableAssignment` uses
   `t.Expression | null | undefined`. The binding cast `as TrackVariableAssignmentCallback`
   already handles this at the VariableVisitor call site. Confirm this cast is sufficient
   for ClassVisitor too, or decide whether to narrow the type.
