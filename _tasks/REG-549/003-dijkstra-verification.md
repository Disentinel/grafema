# REG-549: Plan Verification Report

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-22
**Plan reviewed:** `002-don-plan.md`

---

## Verdict: REJECT

The plan is directionally correct and identifies the right bug sites, but it contains one critical structural omission and one moderate omission that must be addressed before implementation begins.

---

## Enumeration of All Input Categories

### 1. What types of export specifiers exist in JavaScript/TypeScript?

Babel's `ExportNamedDeclaration` node can contain these specifier node types:

| Specifier type | Example | Handled by visitor? |
|---|---|---|
| `ExportSpecifier` | `export { foo }`, `export { foo as bar }` | Yes — both code paths in visitor (lines 285–297 and 308–317) |
| `ExportSpecifier` with `local.type === 'StringLiteral'` | `export { "foo" as bar }` (ES2022 module namespace) | Partial — `localName` fallback exists but no column captured |
| `ExportDefaultSpecifier` | `export foo from './module'` (CJS interop) | Not present in visitor, not in scope |
| `ExportNamespaceSpecifier` | `export * as ns from './module'` | **NOT handled** — see issue 2 below |

### 2. `export * from './module'` — does it have specifiers?

`ExportAllDeclaration` has **no specifiers array** — it is a separate AST node type. The visitor handles it as `type: 'all'` with no specifiers. `ModuleRuntimeBuilder` calls `NodeFactory.createExport('*', ...)` with hardcoded `column: 0`. This is **correct behavior** — there is no per-name specifier to position. No change needed here. The plan is correct in leaving it alone.

### 3. `export * as ns from './module'` — namespace re-export

**This is a gap not addressed by the plan.**

In Babel's AST, `export * as ns from './module'` parses as `ExportNamedDeclaration` with:
- `node.source` set (the `from` clause)
- `node.specifiers` containing one `ExportNamespaceSpecifier` node (type `ExportNamespaceSpecifier`, not `ExportSpecifier`)

Looking at the visitor code at lines 285–297:

```typescript
if (node.source) {
  const specifiers: ExportSpecifierInfo[] = node.specifiers.map((spec) => {
    const exportSpec = spec as ExportSpecifier;  // <-- unsafe cast
    ...
  });
```

The cast `spec as ExportSpecifier` is **incorrect** for `ExportNamespaceSpecifier`. When `spec.type === 'ExportNamespaceSpecifier'`, `spec.local` does not exist (the node has `.exported` only, the local binding is the namespace itself). The current code produces runtime incorrect data for this case.

**Assessment:** The plan proposes adding `column: getColumn(spec)` to this loop without first guarding the specifier type. Since `getColumn` reads `node.loc.start.column`, it works on any AST node — so the column fix itself would not crash. However, the existing structural bug (the unguarded cast) means the column data being added is on top of already-incorrect specifier data for the `export * as ns` case. The plan should either:
- Document that `ExportNamespaceSpecifier` is out of scope and add a type guard (`if (spec.type !== 'ExportSpecifier') return null`) and filter nulls, OR
- Fix both the structural bug and the column bug together

This is a **correctness gap**: adding column data while leaving the existing incorrect cast means the fix is applied to malformed data for one input category.

### 4. `export type { Foo }` — TypeScript type-only exports

`export type { Foo }` parses in Babel as `ExportNamedDeclaration` with `node.exportKind === 'type'` and specifiers with `spec.exportKind === 'type'`. The visitor does **not** read `exportKind` from specifiers — this is a pre-existing gap, not introduced by this plan. However:

- The plan adds `column` and `endColumn` to `ExportSpecifierInfo` but does not add `exportKind`
- The plan's `types.ts` `ExportSpecifier` interface also lacks `exportKind`

For the scope of REG-549 (column accuracy), this is acceptable — the plan is not claiming to fix type-kind tracking. The column fix applies to `export type { Foo }` specifiers identically to value specifiers, and that is correct. No gap here within the stated scope.

### 5. `export { default as Foo } from './mod'` — `default` as specifier name

In this form, `spec.local.name === 'default'` (Identifier). The Babel AST guarantees `spec.local.type === 'Identifier'` and `spec.local.name === 'default'`. The visitor already handles this correctly via:

```typescript
const localName = exportSpec.local.type === 'Identifier'
  ? exportSpec.local.name
  : exportedName;
```

`getColumn(spec)` reads `spec.loc.start.column` — the specifier start, not the `default` keyword position — which is correct. The plan is correct on this point.

### 6. Are there more code paths that create EXPORT nodes beyond the 5 sites?

The plan claims 5 sites. After checking all `createExport` and `createWithContext` call sites:

**In `ASTWorker.ts`:** 4 sites:
- Line 266 — `FunctionDeclaration` export (declaration-style) — column: 0, correct
- Line 274 — `ClassDeclaration` export (declaration-style) — column: 0, correct
- Line 284 — `VariableDeclaration` export (declaration-style) — column: 0, correct
- Line 300 — specifier loop — **BUG: column: 0** — plan addresses this
- Line 324 — default export — column: 0, correct

That is 5 uses in ASTWorker (not 4), but only one is a bug. Plan count of "5 sites" appears to count total `column: 0` occurrences, which matches.

**In `ModuleRuntimeBuilder.ts`:** 4 calls to `NodeFactory.createExport`:
- Line 160 — default export — column: 0, correct
- Line 178 — named specifier export — **BUG: column: 0** — plan addresses this
- Line 199 — named declaration export (name-only path, no specifiers) — column: 0, correct
- Line 216 — all/star export — column: 0, correct

No additional code paths were found. The plan's site enumeration is complete.

### 7. What does `getEndLocation(spec)` return with comments or whitespace?

`getEndLocation` in `location.ts` (line 98–103) reads `node.loc.end`. Babel's `loc.end` is the position **immediately after** the last significant token of the node — it does not include trailing whitespace or comments. Comments are stripped before positioning. This is standard Babel behavior.

For `export { foo /* comment */, bar }`, `spec.loc.end` for `foo` lands at the character after `foo`, not after the comment. This is robust.

One edge to verify: Babel's `ExportSpecifier` node spans from the start of `local` to the end of `exported` (for `export { foo as bar }`, `loc.start` is at `foo`, `loc.end` is after `bar`). The plan correctly captures the specifier start with `getColumn(spec)`. No issue here.

### 8. Does adding `endColumn` to `ExportSpecifier` in `types.ts` break downstream consumers?

**This is a critical structural gap in the plan.**

The plan proposes adding `column?` and `endColumn?` to `ExportSpecifier` in `types.ts` (lines 567–570). However, the data flow is:

```
ImportExportVisitor (private ExportSpecifierInfo)
    -> pushes into collections.exports (typed as public ExportInfo[])
    -> consumed by ModuleRuntimeBuilder.bufferExportNodes(exports: ExportInfo[])
    -> reads spec.exported, spec.local from ExportInfo.specifiers: ExportSpecifier[]
```

The `ExportInfo` and `ExportSpecifier` types in `types.ts` are the **public contract** types used by `ModuleRuntimeBuilder`. The `ImportExportVisitor` has its own **private** `ExportInfo` and `ExportSpecifierInfo` interfaces (lines 66–81 in the visitor) that are **structurally incompatible** with `types.ts` in one key way:

- Visitor's `ExportSpecifierInfo.exported: string` — matches `types.ts ExportSpecifier.exported: string`
- Visitor's `ExportSpecifierInfo.local: string` — matches `types.ts ExportSpecifier.local: string`

The cast `(exports as ExportInfo[]).push(...)` is an unsafe coercion from the visitor's private type to the public type. This works now only because both types have the same shape. Adding `column?` and `endColumn?` to the visitor's private `ExportSpecifierInfo` does NOT automatically make them available in the public `types.ts ExportSpecifier` — they will only pass through if the public type also declares them, AND if `ModuleRuntimeBuilder.bufferExportNodes` destructures them.

The plan says to add these fields to `types.ts ExportSpecifier` — but the current `bufferExportNodes` at line 157 destructures only:
```typescript
const { type, line, name, specifiers, source } = exp;
```

And the specifier loop at line 177:
```typescript
for (const spec of specifiers) {
  const exportNode = NodeFactory.createExport(
    spec.exported,
    module.file,
    line,
    0,   // <-- the bug
    { local: spec.local, source, exportType: 'named' }
  );
```

The plan says to change `0` to `spec.column ?? 0`. This requires `spec.column` to be accessible, which requires the public `ExportSpecifier` in `types.ts` to declare `column?: number`. The plan does state this — but the implementer must understand the chain: **three** types must be updated, not just the one `ExportSpecifier` in `types.ts`:

1. Visitor's private `ExportSpecifierInfo` (add `column?`, `endColumn?`)
2. Public `types.ts ExportSpecifier` (add `column?`, `endColumn?`)
3. `ModuleRuntimeBuilder` reads `spec.column` from what is typed as `types.ts ExportSpecifier`

The plan covers all three, but the description is ambiguous: in section 2a it calls the interface `ExportSpecifierInfo` and in section 3 it talks about `types.ts ExportSpecifier` as if they were the same type. They are **not** the same type. They are two separate interfaces that happen to be structurally compatible. An implementer reading the plan may conflate them.

This ambiguity is **not a fatal gap** by itself (an implementer with codebase knowledge will navigate correctly), but it should be clarified to prevent a mistake where only one of the two types is updated.

### Additional gap: `ExportInfo` type mismatch for specifier data

There is a second, more subtle structural issue. `types.ts ExportInfo` (line 557) lacks a `column` field for the specifier position — the plan correctly threads `column` through the specifier objects, not the `ExportInfo` object. However, `types.ts ExportInfo` also has `id`, `name`, and `file` as required fields (line 558–561) while the visitor's private `ExportInfo` does not have these fields. This means the `as ExportInfo[]` cast is already incorrect for the public type — but this is a pre-existing issue, out of scope for REG-549, and should not be touched.

---

## Summary of Gaps

| # | Gap | Severity | Action Required |
|---|-----|----------|-----------------|
| 1 | `export * as ns from './module'` produces `ExportNamespaceSpecifier` in the specifiers array; the visitor unsafely casts it to `ExportSpecifier`. The plan adds column data on top of this without addressing the type mismatch. | **Moderate** | Add a `spec.type === 'ExportSpecifier'` guard in both specifier loops before applying the column fix. This prevents applying the fix to the wrong node type, and aligns with how ASTWorker.ts already does this (line 295: `if (spec.type !== 'ExportSpecifier') return;`). |
| 2 | Plan uses the terms `ExportSpecifierInfo` (visitor-private) and `ExportSpecifier` (public in `types.ts`) as if they are the same type. They are two separate interfaces. The plan must clarify that BOTH need the `column?`/`endColumn?` additions, and that the chain is: visitor private type → public types.ts type → ModuleRuntimeBuilder reads spec.column. | **Minor** | Clarify the description in sections 2a and the types.ts section so the implementer understands the two-type update requirement. |

---

## What Is Correct in the Plan

- The root cause is correctly identified: specifier loop uses `getLine(node)` / `column: 0` from the declaration node rather than `getLine(spec)` / `getColumn(spec)` from each specifier.
- The fix for `ASTWorker.ts` line 300 is correct: change to `{ line: getLine(spec), column: getColumn(spec) }`.
- The note about `line` affecting ID generation (section 4) is prudent; `ExportNode.create` uses `line` in its ID format (`${file}:EXPORT:${name}:${line}`), so changing `line` from `getLine(node)` to `getLine(spec)` for multi-line exports WILL change node IDs for multi-line specifier exports. The plan correctly flags this risk.
- The `getEndLocation` analysis is sound — it is robust against comments and whitespace.
- The `?? 0` fallback in `ModuleRuntimeBuilder` is correct defensive practice.
- The test cases cover the relevant categories well. The regression test for declaration exports (Case 7) is essential and correctly included.
- The declaration-style exports (`FunctionDeclaration`, `ClassDeclaration`, `VariableDeclaration`) are correctly left with `column: 0` — those export the keyword position, not a per-name position.

---

## Required Changes to Plan Before Implementation

**Gap 1 (Moderate — must fix):**

In sections 2b and 2c of the plan, the specifier mapping loops must include a type guard. The final mapping code in the visitor should be:

```typescript
// export { foo } from './module'
if (node.source) {
  const specifiers: ExportSpecifierInfo[] = node.specifiers
    .filter((spec): spec is ExportSpecifier => spec.type === 'ExportSpecifier')
    .map((spec) => {
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
  // ...
}
```

Note that ASTWorker.ts already correctly guards with `if (spec.type !== 'ExportSpecifier') return;` — the visitor should match this pattern.

**Gap 2 (Minor — clarify in plan):**

Add a note in the plan that `ExportSpecifierInfo` (visitor-private, in `ImportExportVisitor.ts`) and `ExportSpecifier` (public, in `types.ts`) are two separate interfaces that must both be updated. The plan currently implies they are one change.

---

## Final Assessment

The implementation plan has the correct mental model and will produce a correct fix for the primary bug case. However, it fails to handle the `export * as ns from './module'` input category (the `ExportNamespaceSpecifier` case), which exists in the same code path being modified. Adding column data while leaving the unsafe type cast unguarded means the fix is not sound for all input categories.

**REJECT.** Address Gap 1 (add `spec.type === 'ExportSpecifier'` guard in both specifier loops in the visitor) and clarify Gap 2 in the plan before proceeding to implementation.

---

## Re-verification

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-22
**Re-verifying:** Updated `002-don-plan.md` against the two gaps cited in the original rejection.

### Gap 1 — ExportNamespaceSpecifier type guard: RESOLVED

The updated plan prescribes the filter-then-map pattern in both sections 2b and 2c:

```typescript
const specifiers: ExportSpecifierInfo[] = (node.specifiers.filter(
  (spec) => spec.type === 'ExportSpecifier'
) as ExportSpecifier[]).map((spec) => { ... });
```

This is present for both the `node.source` branch and the local-only export branch. The "Notes for Implementer" section reiterates the requirement and correctly explains why an early-return inside `.map()` is not a valid alternative. Gap 1 is addressed.

### Gap 2 — Two separate interfaces: RESOLVED

Section 2a now contains an explicit callout distinguishing the two types:

1. `ExportSpecifierInfo` in `ImportExportVisitor.ts` — visitor-private
2. `ExportSpecifier` in `types.ts` — public contract type

The note states both must be updated before the column reads in 2b/2c can compile. The "Notes for Implementer" section repeats this with the same explicit language. The ambiguity that prompted the original rejection is gone. Gap 2 is addressed.

### Final pass — new edge cases from the filter-then-map pattern

**Empty array after filter:** If all specifiers in a given declaration were `ExportNamespaceSpecifier` nodes, the filter yields an empty array; `.map()` over an empty array yields an empty array. Correct — no crash.

**Mixed arrays:** Arrays containing both `ExportSpecifier` and `ExportNamespaceSpecifier` are valid AST. The filter isolates `ExportSpecifier` entries; `ExportNamespaceSpecifier` entries are silently dropped from the named-specifier list. The plan correctly notes these are handled by the separate `ExportAllDeclaration` visitor. No data loss, no duplication.

**Cast form vs. type predicate form:** The plan uses `(node.specifiers.filter((spec) => spec.type === 'ExportSpecifier') as ExportSpecifier[])` rather than a type predicate `((spec): spec is ExportSpecifier => ...)`. Both produce identical runtime behavior. The cast form is functionally correct; this is a style difference only and is not a defect.

**`spec.local.type` after the filter:** After filtering, all `spec` objects are `ExportSpecifier`, but `spec.local.type` can still be `'StringLiteral'` for ES2022 module namespace export syntax (`export { "foo" as bar } from './mod'`). The plan already handles this with the `localName` fallback. `getColumn(spec)` reads the specifier node start regardless of `local.type` — correct.

**`getEndLocation(spec).column`:** Reads `node.loc.end`, which Babel guarantees is set for all parsed nodes. Robust against comments and trailing whitespace as confirmed in the original report. No new concern.

No new edge cases are introduced by the filter-then-map pattern.

### Verdict: APPROVE

Both gaps are addressed with sufficient precision. The filter-then-map pattern introduces no new correctness risks. The plan is sound for all input categories, the build order is correct (types → visitor → builder → worker → tests), and the test strategy is thorough. The implementer has clear, unambiguous instructions.

Proceed to implementation.
