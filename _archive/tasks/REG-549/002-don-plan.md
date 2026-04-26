# REG-549: Implementation Plan — Fix EXPORT named specifiers storing column=0

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-22

---

## Summary

Named export specifiers (`export { foo, bar }` and `export { foo } from './module'`) store `column: 0` instead of the actual per-specifier column from the source. This plan covers all 5 bug sites identified during exploration, the test strategy, and the correct build order.

---

## Open Questions — Resolved

### Q: In ASTWorker.ts, is `getColumn` already imported? What does `spec` refer to?

**Answer:** Yes, `getColumn` is already imported at line 23:

```typescript
import { getLine, getColumn } from '../plugins/analysis/ast/utils/location.js';
```

At line 294-306, `spec` is a raw Babel AST `ExportSpecifier` node (typed as `ExportSpecifier` from `@babel/types`, imported at line 16). It has a `.loc.start.column` field — exactly what `getColumn(spec)` reads. The fix is straightforward: replace `column: 0` with `column: getColumn(spec)` for the specifier loop. No new imports required.

The other `column: 0` occurrences in ASTWorker.ts (lines 266, 274, 284, 324) are for declaration-style exports (`export function foo`, `export class Foo`, `export default`) — those are correct to use `column: 0` or `getLine(node)` since the export position is the keyword itself, not a per-specifier name. Only the specifier loop at line 300 is a bug.

---

## Files to Change

### Build order: types → visitor → builder → worker → tests

---

### 1. `packages/core/src/plugins/analysis/ast/types.ts`

**Location:** `ExportSpecifier` public interface (lines 567-570 approx.)

**Change:** Add `column` and `endColumn` optional fields, mirroring `ImportSpecifier`.

Find the `ExportSpecifier` interface block. It currently looks like:

```typescript
export interface ExportSpecifier {
  name: string;
  local?: string;
  // ... other fields
}
```

Add:

```typescript
  column?: number;
  endColumn?: number;
```

These must be optional (`?`) to maintain backward compatibility with callers that don't supply them.

---

### 2. `packages/core/src/plugins/analysis/ast/visitors/ImportExportVisitor.ts`

#### 2a. `ExportSpecifierInfo` interface (lines 66-69)

**Change:** Add `column` and `endColumn` to the internal info type.

Note: There are TWO separate interfaces that both require this change (Dijkstra flag — both must be updated):

1. **`ExportSpecifierInfo`** in `ImportExportVisitor.ts` lines 66-69 — the private, visitor-internal interface used to carry specifier data through the visitor pipeline.
2. **`ExportSpecifier`** in `types.ts` lines 567-570 — the public interface exposed by the `types` package to callers such as `ModuleRuntimeBuilder.ts`.

These are distinct types. Updating only one will cause a type error at the boundary where `ExportSpecifierInfo` values are assigned to `ExportSpecifier` fields. Both must be updated before the column reads in 2b/2c can compile.

Current (`ImportExportVisitor.ts`):

```typescript
interface ExportSpecifierInfo {
  exported: string;
  local: string;
}
```

Updated:

```typescript
interface ExportSpecifierInfo {
  exported: string;
  local: string;
  column?: number;
  endColumn?: number;
}
```

(The `types.ts` public interface update is covered in step 1 above — do that first.)

#### 2b. Export handler for `export { foo } from './module'` (lines 285-297)

This is the `node.source` branch. The loop currently does:

```typescript
const specifiers: ExportSpecifierInfo[] = node.specifiers.map((spec) => {
  const exportSpec = spec as ExportSpecifier;
  ...
  return {
    exported: exportedName,
    local: localName
  };
});
```

**Problem:** `node.specifiers` can contain `ExportNamespaceSpecifier` nodes when the syntax is `export * as ns from './module'`. Casting those as `ExportSpecifier` is unsafe — `ExportNamespaceSpecifier` has no `.local` field, so `exportSpec.local.name` would throw or return garbage. This unsafe cast must be fixed BEFORE adding column reads.

**Fix:** Filter out non-`ExportSpecifier` nodes at the start of the map callback. Because `.map()` cannot use an early `return` to skip (unlike `.forEach()`), the correct pattern is to filter first, then map:

```typescript
const specifiers: ExportSpecifierInfo[] = (node.specifiers.filter(
  (spec) => spec.type === 'ExportSpecifier'
) as ExportSpecifier[]).map((spec) => {
  const exportedName = spec.exported.type === 'Identifier'
    ? spec.exported.name
    : spec.exported.value;
  const localName = spec.local.type === 'Identifier'
    ? spec.local.name
    : exportedName;
  return {
    exported: exportedName,
    local: localName,
    column: getColumn(spec),
    endColumn: getEndLocation(spec).column,
  };
});
```

Note: `ExportNamespaceSpecifier` nodes (`export * as ns`) are handled separately by the `ExportAllDeclaration` visitor — they are not specifier rows and should simply be dropped from this list.

#### 2c. Export handler for `export { foo }` (lines 308-317)

The local-only export branch. The loop currently does the same unsafe cast pattern:

```typescript
const specifiers: ExportSpecifierInfo[] = node.specifiers.map((spec) => {
  const exportSpec = spec as ExportSpecifier;
  ...
  return {
    exported: exportedName,
    local: exportSpec.local.name
  };
});
```

**Problem:** Same unsafe cast. Although `export { foo }` (no `from` clause) should never have `ExportNamespaceSpecifier` in practice, the type system allows it and defensive code is required for correctness.

**Fix:** Same filter-then-map pattern:

```typescript
const specifiers: ExportSpecifierInfo[] = (node.specifiers.filter(
  (spec) => spec.type === 'ExportSpecifier'
) as ExportSpecifier[]).map((spec) => {
  const exportedName = spec.exported.type === 'Identifier'
    ? spec.exported.name
    : spec.exported.value;
  return {
    exported: exportedName,
    local: spec.local.name,
    column: getColumn(spec),
    endColumn: getEndLocation(spec).column,
  };
});
```

`getColumn` and `getEndLocation` are already imported at line 31 — no new imports needed.

---

### 3. `packages/core/src/plugins/analysis/ast/builders/ModuleRuntimeBuilder.ts`

**Location:** `bufferExportNodes()`, named specifier section (line 182 approx.)

**Change:** Replace the hardcoded `0` with `spec.column ?? 0`.

Current:

```typescript
column: 0,
```

Fix:

```typescript
column: spec.column ?? 0,
```

Also add `endColumn` if the buffer struct accepts it:

```typescript
endColumn: spec.endColumn ?? 0,
```

Check whether the buffer write for named export specifiers also passes `endColumn` downstream. If the buffer field exists but was also hardcoded to `0`, fix it the same way. If it doesn't exist yet, add it — following the pattern from import specifier buffering.

The other hardcoded `0` values in this function (for default exports, namespace exports, declaration exports) are correct and must not be changed — they represent exports that genuinely don't have a per-name specifier position.

---

### 4. `packages/core/src/core/ASTWorker.ts`

**Location:** `ExportNamedDeclaration` handler, specifier loop (lines 293-308).

**Change:** Replace `column: 0` with `column: getColumn(spec)` for the specifier iteration only.

Current (line 300):

```typescript
{ line: getLine(node), column: 0 },
```

Fix:

```typescript
{ line: getLine(spec), column: getColumn(spec) },
```

Note: using `getLine(spec)` for the line is also more accurate — the specifier may be on a different line than the export keyword in multi-line exports. Confirm whether `ExportNode.createWithContext` uses `line` for ID generation or only for metadata; if for ID generation, changing `line` may affect IDs. If uncertain, change only `column` first and leave `line: getLine(node)` to minimize risk.

No import changes needed — `getColumn` is already imported at line 23.

Do NOT change the `column: 0` on lines 266, 274, 284, or 324 — those are for declaration-style and default exports where the whole-statement position is intentional.

---

## Test Strategy

### Test file to create

`test/unit/NodeFactoryExport.test.js`

Mirror the structure of `test/unit/NodeFactoryImport.test.js` lines 603-716 which cover per-specifier column for imports.

### Test cases

All tests should parse real source strings with Babel (or use fixture files), then assert on the `column` field of each export specifier in the resulting graph data.

#### Case 1: Single named export specifier — column accuracy

```js
export { foo };
//       ^ column should be 9 (0-based)
```

Assert: specifier for `foo` has `column: 9`.

#### Case 2: Multiple named specifiers on one line

```js
export { foo, bar, baz };
//       ^    ^    ^
//       9    14   19
```

Assert: each specifier has its own distinct column.

#### Case 3: Named re-export from module — single specifier

```js
export { foo } from './module';
//       ^ column 9
```

Assert: specifier column is 9, not 0.

#### Case 4: Named re-export from module — multiple specifiers

```js
export { foo, bar } from './module';
```

Assert: `foo` column = 9, `bar` column = 14.

#### Case 5: Multi-line export specifiers

```js
export {
  foo,
  bar,
};
```

Assert: `foo` and `bar` have different line AND column values — not both `column: 0`.

#### Case 6: Renamed specifier (`export { foo as fooAlias }`)

```js
export { foo as fooAlias };
//       ^
//       9
```

Assert: the exported name `fooAlias` is captured with `column: 9` (position of the specifier start, i.e., `foo`).

#### Case 7: Regression — declaration exports still use column 0

```js
export function foo() {}
export class Bar {}
export const x = 1;
```

These are NOT specifier exports. Assert that column for these remains `0` (or whatever the existing behavior is) — this is a non-regression guard.

### Pattern to follow

In `NodeFactoryImport.test.js`, tests:
1. Parse a source string
2. Run the relevant visitor/builder pipeline
3. Inspect the output collection
4. Assert exact `column` and `endColumn` values per specifier

Use the same approach. Do not mock — use the real visitor stack so the test exercises the full path from source to graph data.

---

## Summary Table

| File | Change | Risk |
|------|--------|------|
| `types.ts` — `ExportSpecifier` interface | Add `column?`, `endColumn?` | None — additive only |
| `ImportExportVisitor.ts` — `ExportSpecifierInfo` | Add `column?`, `endColumn?` | None — additive only |
| `ImportExportVisitor.ts` — re-export handler (node.source branch) | Add `.filter(spec.type === 'ExportSpecifier')` type guard + `getColumn(spec)`, `getEndLocation(spec).column` | Low — filter is safe, fixes latent crash on `export * as ns` |
| `ImportExportVisitor.ts` — local export handler (no source branch) | Add `.filter(spec.type === 'ExportSpecifier')` type guard + `getColumn(spec)`, `getEndLocation(spec).column` | Low |
| `ModuleRuntimeBuilder.ts` — `bufferExportNodes()` | `0` → `spec.column ?? 0` | Low — guarded by `?? 0` |
| `ASTWorker.ts` — specifier loop | `column: 0` → `column: getColumn(spec)` | Low — `getColumn` already imported |
| `test/unit/NodeFactoryExport.test.js` | New test file, 7 cases | N/A |

---

## Notes for Implementer (Dijkstra)

### Type guard — REQUIRED before column reads

Both specifier loops in `ImportExportVisitor.ts` use `.map()` with `spec as ExportSpecifier`. This is an unsafe cast. The array type is `(ExportSpecifier | ExportNamespaceSpecifier | ExportDefaultSpecifier)[]`. The `export * as ns from './module'` syntax produces `ExportNamespaceSpecifier` nodes in `node.specifiers`, which have no `.local` property — reading it silently returns `undefined` or throws depending on context.

**The fix is filter-then-map, not early-return-in-map.** `.map()` has no early-return skip mechanism. Use:

```typescript
(node.specifiers.filter((spec) => spec.type === 'ExportSpecifier') as ExportSpecifier[]).map((spec) => { ... })
```

This must be done in BOTH the `node.source` branch (lines 285-297) and the `node.specifiers.length > 0` branch (lines 308-317).

### Two interfaces — both must be updated

Update `ExportSpecifierInfo` in `ImportExportVisitor.ts` (private) AND `ExportSpecifier` in `types.ts` (public). They are separate types and both need `column?: number; endColumn?: number;`. The build order in this plan (types → visitor → builder → worker) ensures the public interface is updated before the private one depends on it.

### Existing imports — no new imports needed

`getColumn` is already imported in both `ImportExportVisitor.ts` (line 31) and `ASTWorker.ts` (line 23). `getEndLocation` is also already imported in `ImportExportVisitor.ts` (line 31). Do not re-import any of these.

### ASTWorker.ts specifier loop

`spec` in the ASTWorker specifier loop is a raw Babel `ExportSpecifier` AST node with `.loc.start.column` — exactly what `getColumn(spec)` reads. The `?? 0` fallback in ModuleRuntimeBuilder is defensive (Babel guarantees loc for parsed files, but the fallback is correct practice).

Only touch the specifier loop in ASTWorker — the declaration-style export handlers (`column: 0` on lines 266, 274, 284, 324) are correct and must not be changed.

### Build and test

After every TypeScript change: `pnpm build` first (tests run against `dist/`, not `src/`). Then: `node --test --test-concurrency=1 'test/unit/*.test.js'`.
