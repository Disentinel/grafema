# Uncle Bob PREPARE Review: REG-555

**Author:** Robert Martin (Uncle Bob)
**Date:** 2026-02-22

---

## File Sizes

| File | Lines | Status |
|------|-------|--------|
| `packages/core/src/plugins/analysis/ast/types.ts` | 1291 | WATCH — single large type registry, adding 2 fields is safe; does NOT require a split before this task, but the file is approaching a threshold where future additions should trigger a split discussion |
| `packages/core/src/plugins/analysis/ast/visitors/PropertyAccessVisitor.ts` | 416 | OK |
| `packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts` | 308 | OK |
| `test/unit/plugins/analysis/ast/property-access.test.ts` | 1007 | OK — test files are allowed to grow larger; the size is proportional to edge case coverage |

No file requires splitting before implementation proceeds. The `types.ts` file at 1291 lines is the only concern, but it is a type-registry file — its growth is linear with feature additions and a mechanical split is not warranted for 4 additional lines.

---

## Methods to Modify

### `CoreBuilder.ts` : `buffer()`

- **Current length:** 26 lines
- **Recommendation:** SKIP refactoring
- The method is a clean dispatcher — all it does is destructure `data` and delegate to private methods. Readable and well-structured. Adding `classDeclarations = []` to the destructuring is a one-line additive change that does not affect readability.

### `CoreBuilder.ts` : `bufferPropertyAccessNodes()`

- **Current length:** 27 lines
- **Estimated length after change:** ~67 lines (27 + ~40 new lines per plan)
- **Recommendation:** SKIP refactoring for now, but consider extraction if the method exceeds 60 lines in practice
- The current method has low nesting depth (one `for` loop, two operations per iteration). The incoming change adds a second conceptual responsibility: CONTAINS edges (current) + READS_FROM edges (new). The total will approach but not exceed the 50-line extraction candidate threshold significantly.
- **Specific note:** If the `this` branch, the dot-check branch, and the variable/param resolution branch each have 8+ lines of code, consider extracting a private helper `resolveObjectNode(propAccess, variableDeclarations, parameters, classDeclarations): string | null` to keep the main loop readable. This is a judgment call for the implementer based on the actual line count after writing the branches. If the method stays under 60 lines, no extraction is needed.

### `PropertyAccessVisitor.ts` : `extractPropertyAccesses()` (static)

- **Current length:** 58 lines (from method signature to closing brace)
- **Estimated length after change:** ~66 lines (+8 lines per plan)
- **Recommendation:** SKIP refactoring
- The method has one `for` loop with a semantic ID branch (`if (scopeTracker) / else`) and a `push`. The new fields (`scopePath`, `enclosingClassName`) are added inside the same `push`. The `enclosingClassName` logic (only run when `baseName === 'this'`) is a one-liner once `as any` is removed (see below). No nesting depth concern.

### `types.ts` : `PropertyAccessInfo`

- **Current length:** 15 lines (lines 277–291)
- **Change:** +4 lines (2 new fields with comments)
- **Recommendation:** SKIP refactoring — additive only, interface remains cohesive

---

## Test File Pattern

The existing test file follows a clear and consistent pattern that must be replicated exactly:

1. Each test group is a `describe()` block with a human-readable name and a comment header
2. Test setup uses `await setupTest(backend, { 'index.js': \`...\` })`
3. Lookups use the existing helpers: `findPropertyAccessNode`, `findAllPropertyAccessNodes`, `getEdgesByType`, `getNodesByType`
4. Each edge test verifies: (a) the PROPERTY_ACCESS node exists, then (b) the specific edge exists with correct `src`/`dst`
5. Comment headers use the `// ===...===` banner style with TEST number

The new `describe` block for REG-555 should be added at the end of the file (after the closing `}` of the existing `describe('PROPERTY_ACCESS Nodes (REG-395)', ...)` block — or, more naturally, as a nested `describe` inside it, which is how all other test groups are structured).

Looking at the file structure: all existing test groups ARE nested inside the outer `describe('PROPERTY_ACCESS Nodes (REG-395)', ...)`. The REG-555 tests should follow the same pattern — a nested `describe('READS_FROM edges for PROPERTY_ACCESS (REG-555)', ...)` at the end of the outer describe block, before the final `});`.

---

## Specific Concerns

### 1. `as any` in Phase 2 snippet — DO NOT USE

Dijkstra's verification (Gap: Precondition 1) already flagged this. Confirmed: `getEnclosingScope(scopeType: string): string | undefined` is a **public method** on `ScopeTracker`. The plan's Phase 2 snippet uses `(scopeTracker as any)?.getEnclosingScope?.('CLASS')` — this is wrong and forbidden in this codebase. The correct call is:

```ts
scopeTracker?.getEnclosingScope('CLASS')
```

No cast, no optional-chaining on the method name. The `?.` before `getEnclosingScope` is already provided by `scopeTracker?.` prefix.

### 2. Missing import in `CoreBuilder.ts` — add before writing any code

`ClassDeclarationInfo` is not currently imported in `CoreBuilder.ts`. The import block is at lines 8–23. The implementer must add `ClassDeclarationInfo` to that import list before implementing Phase 3. TypeScript will catch this at build time, but it is cleaner to add it upfront.

### 3. `basename()` for CLASS node lookup — correctness risk

This was Dijkstra's Gap 3 (HIGH severity) and it is confirmed by reading MutationBuilder.ts lines 198–201 directly:

```ts
// Compare using basename since classes use scopeTracker.file (basename)
// but mutations use module.file (full path)
const fileBasename = basename(file);
const classDecl = classDeclarations.find(c => c.name === enclosingClassName && c.file === fileBasename);
```

`CoreBuilder.bufferPropertyAccessNodes` will have `propAccess.file` as a full path, but `classDecl.file` is a basename. The implementer MUST apply `basename(propAccess.file)` — or `basename(module.file)` (equivalent) — in the CLASS lookup. If omitted, all `this.prop` READS_FROM edges will silently fail to create with no error thrown. This is the highest-risk item in this implementation.

The `basename` import from `'path'` (or `'node:path'`) must also be added to `CoreBuilder.ts` if it is not already there. Quick check shows the current `CoreBuilder.ts` does NOT import `basename`.

### 4. Module-level access test — missing from test plan

Dijkstra's Table 7 identified that module-level property access (where `scopeTracker` is `undefined`) is not tested for READS_FROM edges specifically. The plan's Risk 2 claims `scopePath = []` correctly defaults to module-level scope, and Dijkstra verified this against `resolveVariableInScope`'s loop logic. However, the test gap remains. Recommend adding a sixth test case:

```js
// Module level (no function wrapper)
const config = { timeout: 5000 };
const limit = config.timeout;
```

Expect: PROPERTY_ACCESS "timeout" has READS_FROM → VARIABLE "config". This exercises the `scopeTracker = undefined` path where `scopePath` defaults to `[]`.

---

## Risk Assessment

**Risk: LOW-MEDIUM**

- The algorithmic change is additive (new edges only, no modifications to existing nodes/edges)
- Three implementation landmines are well-documented and avoidable:
  1. `basename()` for CLASS lookup (HIGH if missed)
  2. `ClassDeclarationInfo` import (caught at compile time)
  3. `as any` removal (caught at compile time OR review)
- The rest of the change is straightforward pattern-matching against existing code in MutationBuilder and CallFlowBuilder

**Estimated scope:** ~135 lines across 4 files as planned. No scope creep identified. The method sizes stay within acceptable limits. No splits required.

---

## Pre-Implementation Checklist for Implementer

Before writing any implementation code:

- [ ] Add `ClassDeclarationInfo` to the import block in `CoreBuilder.ts` (line 8)
- [ ] Add `import { basename } from 'node:path'` (or `'path'`) to `CoreBuilder.ts`
- [ ] Confirm `getEnclosingScope` is called as `scopeTracker?.getEnclosingScope('CLASS')` — NO `as any`
- [ ] Confirm CLASS file comparison uses `basename(propAccess.file)` to match `classDecl.file`
- [ ] Add module-level READS_FROM test (scopeTracker=undefined path)

Write tests first (TDD), then implement.
