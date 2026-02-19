# REG-492: Dijkstra Plan Verification

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-19

---

## Verdict: APPROVE (with one required fix)

**Completeness tables:** 4 built
**Gaps found:** 2 (one blocking, one minor)
**Precondition issues:** 1 (requires implementation fix)

---

## 1. Source Verification

I read `ExternalCallResolver.ts` in full. Don's description matches the implementation precisely:

- Step 1 builds `importIndex` keyed by `${imp.file}:${imp.local}` — confirmed (line 80).
- Only non-relative imports are indexed — confirmed (lines 77-78).
- Step 2 collects CALL nodes without `object` and without existing CALLS edges — confirmed (lines 91-98).
- Step 4 performs the lookup at `${file}:${calledName}` — confirmed (line 156).
- Step 4.6 creates CALLS edge with `exportedName = imp.imported || calledName` — confirmed (lines 189-196).

Don's claim of "~15 lines" is accurate. The insertion point (after line 196) is clean.

---

## 2. Matching Logic — Completeness Table

The import index key is `${file}:${local}`. The lookup key is `${file}:${calledName}`. Match succeeds when `calledName === local`. This is correct because the AST emits CALL.name as the local binding name used at the call site.

| Import Syntax | IMPORT.local | CALL.name | Key Match | HANDLED_BY Correct? |
|---------------|-------------|-----------|-----------|----------------------|
| `import { Router } from 'express'` | `Router` | `Router` | YES | YES |
| `import { Router as R } from 'express'` | `R` | `R` | YES | YES — IMPORT.imported = 'Router' preserved |
| `import express from 'express'` (called as `express()`) | `express` | `express` | YES | YES |
| `import * as express from 'express'` (called as `express.Router()`) | — | has `object` field | SKIPPED pre-lookup | Correctly excluded |
| `import type { Foo } from 'bar'` | `Foo` | `Foo` | YES | PROBLEM — see Gap 1 |
| `import { map } from './utils'` | `map` | `map` | NOT INDEXED | Correctly excluded (relative) |

The table is complete for all syntactic import forms. No false positives in the matching logic for the cases where `imp` IS found. The `object` guard correctly excludes namespace method calls before the lookup is even attempted.

---

## 3. IMPORT Node ID — Structural Verification

Don states the IMPORT node ID is `${file}:IMPORT:${source}:${localName}`. I verified against `ImportNode.ts` line 74:

```typescript
id: `${file}:IMPORT:${source}:${name}`,  // SEMANTIC ID: no line number
```

Where `name` is the first positional argument to `ImportNode.create()`, described as "the local binding name." The field `local` is separately stored as `options.local || name` (line 84). Both `name` and `local` default to the same value; they are identical in all normal cases.

Don's plan refers to `imp.id` directly from the index entry. The `imp` object is the node record itself, so `imp.id` IS `${file}:IMPORT:${source}:${localName}`. This is correct. No manual ID reconstruction is needed.

**Precondition verified:** `imp.id` is available and correct at the insertion point.

---

## 4. IMPORT Node Existence at Enrichment Time

The import index is built in Step 1 by iterating all IMPORT nodes currently in the graph. ExternalCallResolver runs AFTER `ImportExportLinker` and `FunctionCallResolver`. IMPORT nodes are created during the ANALYSIS phase (by `JSASTAnalyzer` / `ModuleRuntimeBuilder`), which runs before any ENRICHMENT plugin. Therefore the IMPORT node is guaranteed to exist in the graph when ExternalCallResolver runs.

**Precondition verified:** IMPORT nodes exist at enrichment time.

---

## 5. HANDLED_BY Registration — Verified

From `typeValidation.ts` line 43:
```
'HAS_CALLBACK', 'IMPORTS_FROM', 'HANDLED_BY', 'MAKES_REQUEST',
```

`HANDLED_BY` is registered in `KNOWN_EDGE_TYPES`. Don's claim that it is assigned numeric ID 17 in `GraphBackend.ts` — I did not verify this specific number as it is an implementation detail of the Rust RFDB storage layer, not the TypeScript backend abstraction. What matters for correctness is that `HANDLED_BY` is a registered, valid edge type, which is confirmed.

**Precondition verified:** HANDLED_BY is a known, registered edge type.

---

## 6. Gap 1 (BLOCKING): `importBinding` Missing from Local Interface

Don's plan specifies adding a guard:
> "skip if `imp.importBinding === 'type'`"

The `ImportNode` interface in `ExternalCallResolver.ts` (lines 37-42) is:

```typescript
interface ImportNode extends BaseNodeRecord {
  source?: string;
  importType?: string;
  imported?: string;
  local?: string;
}
```

**`importBinding` is NOT declared in this local interface.** The full `ImportNodeRecord` in `ImportNode.ts` has `importBinding: ImportBinding` as a required field. The `BaseNodeRecord` does not include it.

The consequence: when Rob accesses `imp.importBinding`, TypeScript will produce a type error because the local `ImportNode` interface does not declare this field. The field IS present at runtime on every IMPORT node object (it defaults to `'value'` during creation — `ImportNode.ts` line 82), so the guard would work at runtime, but it will NOT compile without adding `importBinding?: string` (or the proper `ImportBinding` type) to the local `ImportNode` interface in `ExternalCallResolver.ts`.

**Required fix:** Add `importBinding?: string` to the `ImportNode` interface in `ExternalCallResolver.ts` before the guard can be written. Rob must include this in the implementation.

---

## 7. Gap 2 (MINOR): Metadata Counts Will Be Inaccurate After Change

Don's plan adds `handledByEdgesCreated` counter and updates `metadata.creates.edges` and `metadata.produces`. The existing `edgesCreated` counter and the `result.created.edges` return value count only CALLS edges. After the change, HANDLED_BY edges are also created but the `edgesCreated` counter — and thus `result.created.edges` — will still only increment once per resolved call (for the CALLS edge at line 198).

Don acknowledges "Update counters/stats to track `handledByEdgesCreated`" in the plan. However, the existing `createSuccessResult` call at line 213 uses `{ nodes: nodesCreated, edges: edgesCreated }`. If `handledByEdgesCreated` is tracked separately but NOT added to `edgesCreated`, the `result.created.edges` field will under-report. This creates a consistency issue:

- The metadata field says `HANDLED_BY` is created.
- `result.created.edges` does not count HANDLED_BY edges.
- The existing test `'Plugin Metadata'` asserts `metadata.creates.edges` equals `['CALLS']` — that assertion will FAIL after the metadata update unless the test is updated.

**Assessment:** This is expected to be handled during implementation. The plan explicitly calls for updating metadata and counters. However, Don's plan does not specify whether `result.created.edges` should be the sum of both edge types, or whether a new separate field should be added. Rob needs clarity on this. The safe approach: add HANDLED_BY edges to the `edgesCreated` counter (one total count), OR add a separate `handledByEdgesCreated` to `result.metadata`.

---

## 8. Edge Cases — Enumeration

### 8.1 `require()` calls

`require` is in `JS_GLOBAL_FUNCTIONS` (confirmed by the existing test at line 468 of the test file, which asserts `require` is treated as a builtin with no CALLS edge). ExternalCallResolver short-circuits at Step 4.1. No HANDLED_BY edge is created. This is correct: `require()` calls are CJS module loading, not a call to an imported binding.

### 8.2 Dynamic `import()` expressions

The IMPORT nodes for `import()` have `isDynamic: true`. However, the guard that prevents HANDLED_BY concerns CALL nodes, not IMPORT nodes. The `callNode.isDynamic` check at Step 4.2 exits before the import lookup. Additionally, dynamic IMPORT nodes have `isResolvable: false` when the path is not a string literal — but this does not affect ExternalCallResolver's matching logic since it only matches by name. Net result: dynamic calls are correctly excluded from HANDLED_BY.

### 8.3 Shadowing a built-in (`import { Map } from 'immutable'`)

CALL.name = `'Map'`. JS builtins check uses `JS_GLOBAL_FUNCTIONS`. I verified the existing test file which lists `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `eval`, timer functions, and `require`. `Map` (the constructor) is NOT in this list per the test. Therefore:

- Step 4.1 does NOT short-circuit for `Map`.
- Step 4.3 finds `importIndex.get('/file.js:Map')` — the IMPORT node.
- CALLS edge to `EXTERNAL_MODULE:immutable` is created.
- HANDLED_BY edge to `IMPORT[/file.js:IMPORT:immutable:Map]` is created.

This is **correct behavior**. The import explicitly shadows the built-in, so linking to the IMPORT binding is right.

### 8.4 Same function name imported from two different modules in the same file

Example:
```javascript
import { create } from 'zustand';
import { create } from 'jotai'; // This shadows the first!
```

This is a JavaScript name collision — the second import shadows the first. In this case, the AST will produce only one IMPORT node per binding name per file (the ID is `${file}:IMPORT:${source}:${name}`). If both imports use the same local name, the `importIndex` map will only retain the LAST one indexed (Map.set overwrites). The CALL will be linked to whichever IMPORT was indexed last.

However, this is a degenerate case. In valid JavaScript, you cannot have two bindings with the same name in the same scope — the second import declaration is a syntax error (`SyntaxError: Identifier 'create' has already been declared`). The JS parser will reject this file before the AST analyzer processes it. This case cannot arise in valid source code.

**Confirmed safe:** No issue here.

### 8.5 `export { Router } from 'express'` — Does this create an IMPORT node?

This is a re-export statement. Based on searching `ModuleRuntimeBuilder.ts`, this pattern creates an EXPORT node with a `source` field (the external module), NOT an IMPORT node. There is no `import { Router }` statement; the binding is directly re-exported.

Therefore, in a file containing only `export { Router } from 'express'`, there is NO IMPORT node with local name `Router` for that file. ExternalCallResolver would find no match in `importIndex` for any CALL in this file that uses `Router`. But in practice, the file with the re-export would not typically contain CALL nodes for `Router` — it just re-exports it. The consuming file would have its own `import { Router } from './re-exporter'` (relative import), which ExternalCallResolver skips.

**Conclusion:** This pattern does not create an IMPORT node, but it also does not create a false match. No action required.

---

## 9. Idempotency of HANDLED_BY Edge Creation

Don's plan states: "Since HANDLED_BY and CALLS are created in the same step, if CALLS already exists the node was resolved in a previous run — skip both."

This is correct. The `getOutgoingEdges(call.id, ['CALLS'])` check at Step 2 (lines 94-95) filters out already-resolved CALL nodes BEFORE the loop body executes. If CALLS already exists, the CALL node never reaches Step 4.7. HANDLED_BY is not created on re-runs. The existing idempotency test covers this because any re-run of ExternalCallResolver will find the CALLS edge and skip the node.

However: there is a subtle case where HANDLED_BY could already exist but CALLS does not. This would require another plugin to have created a HANDLED_BY edge from this CALL to this IMPORT prior to ExternalCallResolver running. No such plugin exists in the current codebase. Don's guard is sufficient for current code.

---

## 10. Test Coverage Assessment

The existing test file (`test/unit/ExternalCallResolver.test.js`) has good coverage of CALLS behavior. Don's plan adds 8 new test cases for HANDLED_BY. I verify the critical ones:

| Test | Sufficient? | Notes |
|------|-------------|-------|
| Named import → HANDLED_BY created | YES | Core case |
| Default import → HANDLED_BY created | YES | Needed |
| Aliased import → HANDLED_BY to local-name IMPORT | YES | Needed |
| Type-only import → NO HANDLED_BY | YES | Required for Gap 1 guard |
| Method call → NO HANDLED_BY | YES | Already tested in existing suite for CALLS; extend |
| Existing CALLS → no HANDLED_BY duplicate | YES | Idempotency |
| Multiple files → file isolation | YES | Correct |
| Regression: CALLS still created | YES | Backwards compat |

The existing `'Plugin Metadata'` test (line 1100) asserts:
```javascript
assert.deepStrictEqual(metadata.creates.edges, ['CALLS']);
```
This test **will fail** after the metadata update. Don's plan lists updating `metadata.creates.edges` to include `'HANDLED_BY'`. Rob must also update this assertion in the test, or the suite will break.

---

## Summary Table

| Claim in Plan | Verified? | Result |
|---------------|-----------|--------|
| ExternalCallResolver description matches code | YES | Exact match |
| `${file}:${calledName}` matching logic correct | YES | Correct for all cases |
| `imp.id` available at insertion point | YES | Direct field access |
| IMPORT node exists at enrichment time | YES | Created in ANALYSIS phase |
| HANDLED_BY registered in typeValidation | YES | Line 43 confirmed |
| `importBinding` guard implementable | NO | `importBinding` missing from local interface — must be added |
| Namespace imports correctly excluded | YES | `object` guard fires first |
| `require()` correctly excluded | YES | Builtin guard fires first |
| Dynamic calls correctly excluded | YES | `isDynamic` guard fires first |
| Built-in shadowing (e.g., `Map`) handled correctly | YES | Correctly links to IMPORT |
| Same-name dual imports impossible | YES | JS syntax error |
| `export { X } from 'lib'` — no false IMPORT match | YES | Creates EXPORT, not IMPORT |
| Idempotency via CALLS guard | YES | Sufficient |
| Test file exists | YES | `test/unit/ExternalCallResolver.test.js` |
| Existing metadata test will need update | NOTED | Rob must update |

---

## Required Actions Before Implementation

1. **Rob must add `importBinding?: string` to the local `ImportNode` interface** in `ExternalCallResolver.ts` before the type-only guard can be written. Without this, the TypeScript compilation will fail.

2. **Rob must update the existing metadata test** that asserts `metadata.creates.edges` equals `['CALLS']` to include `'HANDLED_BY'`.

These are small, well-defined changes. The plan is otherwise sound.
