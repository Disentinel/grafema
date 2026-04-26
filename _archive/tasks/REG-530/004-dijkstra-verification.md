## Dijkstra Plan Verification — REG-530

**Verdict:** REJECT

**Reason:** Plan has 3 critical gaps that would cause incorrect behavior.

---

## 1. Input Universe for ImportSpecifier Types

**Table 1: Import Declaration Specifier Types**

| Specifier Type | Example | Planned Coverage | Babel loc Range (Empirical) | Status |
|----------------|---------|------------------|------------------------------|--------|
| ImportSpecifier | `import { foo } from '...'` | ✅ Yes (line 108-136) | `foo`: col 9-12 | ✅ COVERED |
| ImportSpecifier (aliased) | `import { foo as bar } from '...'` | ✅ Yes (line 108-136) | `foo as bar`: col 9-20 (FULL expression) | ✅ COVERED |
| ImportSpecifier (type) | `import { type Foo } from '...'` | ✅ Yes (line 108-136) | `type Foo`: col 9-17 (includes `type` keyword) | ✅ COVERED |
| ImportDefaultSpecifier | `import React from '...'` | ✅ Yes (line 122-128) | `React`: col 7-12 | ✅ COVERED |
| ImportNamespaceSpecifier | `import * as path from '...'` | ✅ Yes (line 129-136) | `* as path`: col 7-16 | ✅ COVERED |

**Verdict for Universe Coverage:** ✅ PASS — All import specifier types are covered.

**Note on Re-exports:** `export { foo } from '...'` is handled by `ExportNamedDeclaration`, not `ImportDeclaration`. The plan correctly excludes this from cursor matching scope (re-exports are not IMPORT nodes).

---

## 2. Column Range Matching — Completeness Table

**Empirical Evidence from Babel Parser:**

```javascript
// Test: import { foo, bar as baz } from 'module';
// ImportDeclaration loc: line 1, col 0-41
// Specifier 0 (foo):       line 1, col 9-12
// Specifier 1 (bar as baz): line 1, col 14-24  ← FULL "bar as baz" expression
```

**Table 2: Cursor Position Coverage**

| Cursor Position | Expected Behavior | Planned Behavior | Gap? |
|----------------|-------------------|------------------|------|
| On first specifier name (`foo`) | Return IMPORT node for `foo` | Range match: col 9 in [9, 12] → ✅ correct | ✅ CORRECT |
| On second specifier name (`bar`) | Return IMPORT node for `bar` | Range match: col 14 in [14, 24] → ✅ correct | ✅ CORRECT |
| On `as baz` in `bar as baz` | Return IMPORT node for `bar` (same specifier) | Range match: col 21 in [14, 24] → ✅ correct | ✅ CORRECT |
| On `import` keyword (col 0) | Return ANY IMPORT node (closest) | No endColumn range match → fallback to distance | ✅ CORRECT |
| On `from` keyword (col ~27) | Return ANY IMPORT node (closest) | No endColumn range match → fallback to distance | ✅ CORRECT |
| On module path string (col ~33) | Return ANY IMPORT node (closest) | No endColumn range match → fallback to distance | ✅ CORRECT |
| Between specifiers: comma (col 12) | Return closest specifier | No range match → fallback to distance | ✅ CORRECT |
| Between specifiers: space (col 13) | Return closest specifier | No range match → fallback to distance | ✅ CORRECT |
| On `{` brace (col 7) | Return closest specifier | No range match → fallback to distance | ✅ CORRECT |
| On `}` brace (col ~25) | Return closest specifier | No range match → fallback to distance | ✅ CORRECT |
| On `type` keyword in `import { type Foo }` | Return IMPORT node for `Foo` | Range match: `type Foo` is col 9-17 → ✅ correct | ✅ CORRECT |

**Verdict for Cursor Coverage:** ✅ PASS — All cursor positions handled correctly.

**Key Insight:** Babel's `ImportSpecifier.loc` covers the FULL specifier expression, including `as` aliases and `type` keywords. This is exactly what we need for precise cursor matching.

---

## 3. Babel AST loc Accuracy — Empirical Verification

**Question:** Does `ImportSpecifier.loc` cover just the identifier name, or the full expression (including `as` alias)?

**Empirical Answer (from test above):**

| Syntax | Babel loc Range | Conclusion |
|--------|----------------|------------|
| `import { foo } from '...'` | col 9-12 (just `foo`) | Covers identifier name |
| `import { bar as baz } from '...'` | col 14-24 (full `bar as baz`) | Covers FULL expression including `as` |
| `import { type Foo } from '...'` | col 9-17 (full `type Foo`) | Covers FULL expression including `type` |
| `import * as path from '...'` | col 7-16 (full `* as path`) | Covers FULL expression |

**Verdict:** ✅ PASS — Babel provides exactly the range we need.

---

## 4. Precondition Issues

### 4.1. Does `spec.loc` always exist?

**Precondition Check:**

```typescript
// From location.ts (lines 67-88, 98-103)
export function getColumn(node: Node | null | undefined): number {
  return node?.loc?.start?.column ?? 0;
}

export function getEndLocation(node: Node | null | undefined): NodeLocation {
  return {
    line: node?.loc?.end?.line ?? 0,
    column: node?.loc?.end?.column ?? 0
  };
}
```

**Analysis:** `getColumn()` and `getEndLocation()` already handle missing `loc` by returning `0`. This is safe.

**Edge case:** If source is minified or lacks source maps, `spec.loc` might be `null`. In this case:
- `getColumn(spec)` returns `0`
- `getEndLocation(spec).column` returns `0`
- Both specifiers get `column=0, endColumn=0`
- Range matching: cursor 0 would match [0, 0] → works, but ambiguous

**Gap:** ❌ **CRITICAL GAP #1** — When `spec.loc` is missing, all specifiers get `column=0, endColumn=0`. The plan says "use `spec.column ?? column ?? 0`" (line 53 of plan), which would use the **ImportDeclaration-level column** as fallback. But:

1. The plan extracts `column` from `spec` (line 29), so `spec.column` would be 0 if `spec.loc` is missing
2. The fallback to `column` (ImportDeclaration column) would be 0 too (from `getColumn(node)` on line 143 of ImportExportVisitor.ts)
3. So the fallback chain `spec.column ?? column ?? 0` collapses to `0 ?? 0 ?? 0 = 0`

**Fix Required:** The plan should explicitly document that when `spec.loc` is missing, all specifiers on the same line will be ambiguous. This is acceptable behavior (minified code isn't the target), but should be called out.

### 4.2. Can `getColumn(spec)` return 0 (same as declaration column)?

**Analysis:** The ImportDeclaration column is always 0 (the `import` keyword). A specifier inside `{ }` braces will always have `column >= 7` (after `import {`).

**Scenario where specifier column = 0:** Only if `spec.loc` is missing (see 4.1 above).

**Verdict:** ✅ PASS — No risk of collision between declaration column and valid specifier column.

### 4.3. Is endColumn inclusive or exclusive?

**Empirical Test:**

```javascript
// Test: import { foo } from 'module';
//       01234567890123456789
//                ^   ^
//               col9 col12
// "foo" = indices 9, 10, 11 (3 chars)
// Babel loc: start.column=9, end.column=12
```

**Conclusion:** Babel uses **exclusive** end positions (endColumn = 12 means "up to but not including column 12").

**Plan Check (line 76):**

```typescript
column >= nodeColumn && column <= endColumn
```

**Gap:** ❌ **CRITICAL GAP #2** — The plan uses `<=` (inclusive) but Babel's endColumn is **exclusive**. This would incorrectly match the cursor position at `endColumn`.

**Example:**

```javascript
import { foo, bar } from 'module';
//       ^   ^
//      col9 col12 (endColumn for "foo")
// Cursor at col12 (the comma) should NOT match "foo", but plan would match it
```

**Fix Required:** Change `column <= endColumn` to `column < endColumn`.

### 4.4. Edge Case: Empty specifiers

**Test:**

```javascript
import {} from 'module';
```

**Analysis:** `node.specifiers` would be an empty array. The plan's loop (line 108-136 in ImportExportVisitor.ts) would not iterate. No IMPORT nodes created. No crash.

**Verdict:** ✅ PASS — Handled correctly (no nodes created for empty imports).

### 4.5. Edge Case: Single specifier

**Test:**

```javascript
import { only } from 'module';
```

**Analysis:** One IMPORT node created with column range. Range matching works. No ambiguity.

**Verdict:** ✅ PASS — Trivial case, no issues.

### 4.6. Edge Case: All specifiers same column (minified)

**Scenario:**

```javascript
// Minified: import{foo,bar,baz}from'module';
// If source maps are missing, all specifiers might get column=0
```

**Analysis:** Same as 4.1. All specifiers would have `column=0, endColumn=0`. Distance-based matching would return the first node in the buffer.

**Gap:** ❌ **CRITICAL GAP #3** — The plan does not specify which node is returned when multiple nodes have the same distance. This is determined by iteration order in `findNodeAtCursor` (line 33-54 in nodeLocator.ts).

**Current behavior:** First match wins (due to iteration order).

**Fix Required:** The plan should explicitly state: "When multiple specifiers have identical column ranges (e.g., minified code without source maps), the first specifier in declaration order is returned. This is acceptable for minified code (not the target use case)."

### 4.7. Edge Case: Multi-line specifiers

**Test:**

```javascript
import {
  join,
  resolve
} from 'path';
```

**Babel loc data:**

```
Specifier 0 (join):    line 2, col 2-6
Specifier 1 (resolve): line 3, col 2-9
```

**Analysis:** Each specifier has a different line. Line-based matching in `findNodeAtCursor` (line 45) handles this:

```typescript
if (nodeLine === line) { ... }
```

Only specifiers on the same line as the cursor would be candidates. Column ranges are a bonus for disambiguation when multiple specifiers share a line.

**Verdict:** ✅ PASS — Multi-line imports work correctly (each specifier on its own line).

---

## 5. Backward Compatibility

**Plan Statement (line 79, line 9):**

> Old graphs without endColumn still work — distance-based matching is fallback

**Code Check (nodeLocator.ts, lines 45-54):**

```typescript
if (nodeLine === line) {
  // If node has endColumn metadata: check range
  // Else: keep current distance-based matching
}
```

**Analysis:** The plan says "If node has `endColumn` metadata: check range, else: distance-based matching" (line 74-77).

**Implementation Detail Missing:** How do we check if `endColumn` exists in metadata?

```typescript
const metadata = parseNodeMetadata(node);
const endColumn = metadata.endColumn;

if (endColumn !== undefined) {
  // Range matching
} else {
  // Distance matching
}
```

**Verdict:** ✅ PASS — Backward compatibility works if implemented as specified.

---

## 6. Gap Summary

**Gaps Found:**

1. **CRITICAL: Inclusive vs Exclusive endColumn** — Plan uses `column <= endColumn` but Babel's endColumn is exclusive. Should be `column < endColumn`.

2. **CRITICAL: Missing loc Handling** — Plan does not explicitly document that minified code without source maps will have all specifiers at column=0, causing ambiguity. This is acceptable (minified code is not the target), but should be called out in the plan.

3. **CRITICAL: Ambiguous Distance Matching** — When multiple specifiers have the same column (e.g., all at 0 due to missing loc), the plan does not specify which node is returned. Current behavior: first in iteration order. Should be documented.

**Precondition Issues:**

- None beyond the gaps above.

---

## 7. Completeness Tables

**Tables Created:**

1. **Table 1: Import Declaration Specifier Types** — 5 rows, all covered ✅
2. **Table 2: Cursor Position Coverage** — 11 scenarios, all correct ✅

---

## 8. Final Verdict

**REJECT** — Plan has 3 critical implementation gaps that must be fixed:

1. Change `column <= endColumn` to `column < endColumn` (exclusive end)
2. Document behavior when `spec.loc` is missing (all specifiers get column=0)
3. Document that first specifier wins when multiple have same column

**Recommendation:** Don should update the plan to address these 3 gaps, then re-submit for verification.

---

## References

- Babel AST Spec: [babel/packages/babel-parser/ast/spec.md](https://github.com/babel/babel/blob/main/packages/babel-parser/ast/spec.md)
- Empirical verification: Ran Babel parser on test cases to confirm loc ranges
- Code references:
  - `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/visitors/ImportExportVisitor.ts` (lines 102-146)
  - `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/utils/location.ts` (lines 67-103)
  - `/Users/vadimr/grafema-worker-1/packages/core/src/core/nodes/ImportNode.ts` (lines 10-124)
  - `/Users/vadimr/grafema-worker-1/packages/vscode/src/nodeLocator.ts` (lines 19-95)
  - `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/builders/ModuleRuntimeBuilder.ts` (lines 53-152)
  - `/Users/vadimr/grafema-worker-1/packages/vscode/src/types.ts` (lines 10-16)
