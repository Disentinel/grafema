## Dijkstra Re-Verification

**Author:** Edsger Dijkstra, Plan Verifier
**Date:** 2026-03-01
**Input:** 005-dijkstra-verification.md (original rejection), 006-don-plan-fixes.md (Don's fixes)
**Source files verified:** packages/core-v2/src/visitors/expressions.ts, packages/core-v2/src/walk.ts, packages/core-v2/src/visitors/modules.ts

**Verdict:** APPROVE

---

## Gap-by-Gap Verification

**Gap 2 fix:** VERIFIED — Audit is complete and independently confirmed.

Don's grep audit lists six callers:

```
packages/core-v2/test/verify-golden.mjs:     walkFile(code, file, jsRegistry)
packages/core-v2/test/element-of.test.mjs:   walkFile(code, 'test.js', jsRegistry)
packages/core-v2/test/package-map.test.mjs:  walkFile(code, file, jsRegistry)
packages/core-v2/test/scope.test.mjs:        walkFile(code, 'test.js', jsRegistry) [8 call sites]
packages/core-v2/test/smoke.mjs:             walkFile(code, relPath, jsRegistry)
packages/core/src/plugins/analysis/CoreV2Analyzer.ts:  walkFile(code, filePath, jsRegistry)
```

I independently ran a grep across the codebase. The results confirm: every `walkFile(` call site uses
exactly the 3-argument form. `element-of.test.mjs` has two call sites, both 3-argument. No caller
passes a 4th positional argument. The signature change inserting `domainPlugins` at position 4 does
not break any existing caller.

Don's required spec addition (the backward-compatibility audit sentence in Commit 3) resolves the
gap: the spec now documents the audit result so a future reader can verify the "zero call sites"
claim without re-running the grep. Gap 2 is closed.

---

**Gap 3 fix:** VERIFIED — CommonJS `require()` is handled correctly by the two-pass approach.

I verified the source code at expressions.ts lines 401–414:

```typescript
if ((calleeName === 'require' || calleeName === 'import') && call.arguments.length >= 1
    && call.arguments[0].type === 'StringLiteral') {
  const moduleName = (call.arguments[0] as StringLiteral).value;
  const extId = ctx.nodeId('EXTERNAL_MODULE', moduleName, line);
  result.nodes.push({ id: extId, type: 'EXTERNAL_MODULE', name: moduleName, ... });
  result.edges.push({ src: nodeId, dst: extId, type: calleeName === 'require' ? 'IMPORTS' : 'IMPORTS_FROM' });
}
```

Don's claims are factually correct:

1. `require('express')` DOES create an `EXTERNAL_MODULE` node with `name: 'express'` (exact).
2. The edge type is `IMPORTS` with src = the CALL node ID, dst = the EXTERNAL_MODULE node ID.

Don's new `_importsExpress()` two-pass logic:
- Pass 1: collects IDs of all `EXTERNAL` or `EXTERNAL_MODULE` nodes where `node.name === 'express'` (exact equality). This is correct and excludes `express-async-handler` etc.
- Pass 2: checks whether any edge with type `DEPENDS_ON`, `IMPORTS_FROM`, or `IMPORTS` has `edge.dst` in `expressNodeIds`. The `IMPORTS` edge from `require('express')` has `dst = ctx.nodeId('EXTERNAL_MODULE', 'express', line)`, which IS in `expressNodeIds`. So CommonJS files are detected.

For ESM (`import express from 'express'`): modules.ts line 38–59 creates an `EXTERNAL` node (id:
`${ctx.file}->EXTERNAL->express#0`) AND an `EXTERNAL_MODULE` node. Both are named `'express'` (exact).
A `DEPENDS_ON` edge is emitted directly (not deferred): `{ src: ctx.moduleId, dst: externalId, type: 'DEPENDS_ON' }`.
Pass 1 adds the EXTERNAL node ID to `expressNodeIds`. Pass 2 finds the DEPENDS_ON edge with that dst.
ESM is detected correctly.

The updated JSDoc accurately describes both code paths and the rationale. Gap 3 is closed.

---

**Gap 4 fix:** VERIFIED — The new `_importsExpress` implementation eliminates false positives.

The old code used `edge.dst.includes('express')` which matches `express-async-handler`,
`express-validator`, `@express/core`, etc.

The new implementation uses exact `node.name === 'express'` string equality in pass 1. The node
`name` field is populated directly from the import source string (`import express from 'express-async-handler'`
produces a node with `name: 'express-async-handler'`, not `name: 'express'`). There is no substring
comparison anywhere in the new code.

Pass 2 then requires an edge pointing to one of those exact node IDs. This prevents false positives
even if a file has an EXTERNAL_MODULE with `name === 'express'` for some reason unrelated to an
actual import — it must have a corresponding import-type edge.

I also note a previously undocumented benefit: the early return `if (expressNodeIds.size === 0) return false`
is correct and not a shortcut — if no node named 'express' exists, no import edge can point to one.

One edge case worth noting: `import 'express'` (side-effect import, no specifiers) creates an
EXTERNAL node and EXTERNAL_MODULE node (both with `name: 'express'`) plus a DEPENDS_ON edge.
Pass 1 collects both node IDs. Pass 2 finds the DEPENDS_ON edge. Correctly detected. Gap 4 is closed.

---

**Gap 1 fix:** VERIFIED — Documentation is adequate.

Don's fix adds a multi-line comment before the argValues loop:

```
// For TemplateLiteral with no expressions (e.g. `app.get(`/users`, h)`):
//   - quasis[0].value.cooked is used when available. It is typed string | null
//     in Babel's typedefs: it is null when the template contains an invalid escape
//     sequence (e.g. `\unicode`). In that case, .raw is used as fallback — raw
//     preserves the original backslash characters verbatim. For route paths this
//     distinction is irrelevant in practice since route paths do not contain
//     escape sequences.
```

And an inline comment at the call site:
```
// cooked can be null for invalid escape sequences; fall back to raw.
```

And a new invariant bullet explaining the type constraint.

This satisfies my original requirement: the spec now explains that `cooked` can be null, why `.raw`
is the correct fallback, and the practical impact for route paths. Gap 1 is closed.

---

**Gap 5 fix:** VERIFIED — Adding column disambiguates sufficiently.

Don's fix changes the ID format from `#${line}` to `#${line}:${column}`.

The question I raised: "What if two routes on the same line, same column?" This would require two
distinct method call AST nodes at the same start position. In Babel's AST, two sibling call
expressions on the same line MUST occupy different character positions — they cannot both start at
the same column because each character position is unique in the source text. The only way two
nodes share line AND column is if one is an ancestor of the other (e.g., a call inside an argument),
not if they are sibling route registrations. Two sibling `app.get(...)` calls on one line necessarily
start at different columns.

One concern: Don's fix requires updating all existing test assertions that hard-code route node IDs.
Don notes that the existing tests use `result.nodes.find(n => n.type === 'http:route')` rather than
asserting on raw IDs, so no test breaks. This is a valid claim about the spec's test design.

Test 9 (same-line routes get unique IDs) is added and exercises the fix correctly. Gap 5 is closed.

---

## New Issues Found

**One minor issue discovered during verification (non-blocking):**

The two-pass `_importsExpress()` logic builds `expressNodeIds` from `fileResult.nodes`. The EXTERNAL
node for ESM imports is emitted by `visitImportDeclaration` with id `${ctx.file}->EXTERNAL->express#0`
(line 38 of modules.ts). The EXTERNAL_MODULE node for ESM is emitted at `ctx.nodeId('EXTERNAL_MODULE', source, line)`
which produces `${ctx.file}->EXTERNAL_MODULE->express#${line}`.

For CommonJS, only an EXTERNAL_MODULE node is emitted (no EXTERNAL node), via expressions.ts line 404.

Both are captured by the `node.type === 'EXTERNAL' || node.type === 'EXTERNAL_MODULE'` check in pass 1.

The DEPENDS_ON edge for ESM goes from `ctx.moduleId` to `externalId` (the EXTERNAL node, not
EXTERNAL_MODULE). Pass 2 must find either the DEPENDS_ON → EXTERNAL edge or the IMPORTS edge →
EXTERNAL_MODULE. Since both IDs are in `expressNodeIds`, both edges will match. This works correctly.

No blocking issues discovered. All five gaps are resolved. The implementation may proceed.
