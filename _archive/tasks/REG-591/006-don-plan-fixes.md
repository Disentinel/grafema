# REG-591: Plan Fixes — Dijkstra Gap Resolution

**Author:** Don Melton, Tech Lead
**Date:** 2026-03-01
**Fixes:** 005-dijkstra-verification.md — three blocking gaps + two non-blocking

---

## Gap 2 — walkFile Signature Audit

### Investigation

Grep result across all `.mjs`, `.ts`, `.js` callers of `walkFile`:

```
packages/core-v2/test/verify-golden.mjs:     walkFile(code, file, jsRegistry)
packages/core-v2/test/element-of.test.mjs:   walkFile(code, 'test.js', jsRegistry)
packages/core-v2/test/package-map.test.mjs:  walkFile(code, file, jsRegistry)
packages/core-v2/test/scope.test.mjs:        walkFile(code, 'test.js', jsRegistry)   [8 call sites]
packages/core-v2/test/smoke.mjs:             walkFile(code, relPath, jsRegistry)
packages/core/src/plugins/analysis/CoreV2Analyzer.ts:  walkFile(code, filePath, jsRegistry)
```

**Result: Every existing caller uses the 3-argument form.** No caller passes a 4th argument (the
old `strict` positional parameter). The signature change from `(code, file, registry, strict = true)`
to `(code, file, registry, domainPlugins = [], strict = true)` does not break any existing call site.

### Spec change required

Add the following sentence to the "Signature change for `walkFile`" subsection of Commit 3:

**Add after the "After:" code block:**

> **Backward compatibility audit:** Verified via `grep -r "walkFile" packages/` across all `.mjs`
> and `.ts` files. Zero existing callers pass an explicit 4th argument. All six call sites use the
> 3-argument form `walkFile(code, file, registry)`. The new `domainPlugins` parameter defaults to
> `[]` and `strict` defaults to `true`, so the change is non-breaking.

---

## Gap 3 — CommonJS require() and Import Detection

### Investigation

Reading `packages/core-v2/src/visitors/expressions.ts` lines 401–414:

```typescript
// require('module') / import('module') → EXTERNAL_MODULE node + IMPORTS/IMPORTS_FROM edge
if ((calleeName === 'require' || calleeName === 'import') && call.arguments.length >= 1 && call.arguments[0].type === 'StringLiteral') {
  const moduleName = (call.arguments[0] as StringLiteral).value;
  const extId = ctx.nodeId('EXTERNAL_MODULE', moduleName, line);
  result.nodes.push({
    id: extId,
    type: 'EXTERNAL_MODULE',
    name: moduleName,
    file: ctx.file,
    line,
    column,
  });
  result.edges.push({ src: nodeId, dst: extId, type: calleeName === 'require' ? 'IMPORTS' : 'IMPORTS_FROM' });
}
```

**Findings:**

1. `require('express')` DOES produce an `EXTERNAL_MODULE` node with `name: 'express'`.
2. The edge emitted is `IMPORTS` (CALL → EXTERNAL_MODULE), NOT `DEPENDS_ON` (MODULE → EXTERNAL).
3. The spec's `_importsExpress()` checks `DEPENDS_ON` and `IMPORTS_FROM` edges — neither covers `require()`.
4. However, the spec's node-scanning loop at the bottom of `_importsExpress()` already covers this:
   ```typescript
   if (node.type === 'EXTERNAL_MODULE' && node.name === 'express') {
     return true;
   }
   ```
   This exact-match check on `EXTERNAL_MODULE` nodes DOES detect `require('express')` because the
   node is created with `name: moduleName` where `moduleName === 'express'`.

**Conclusion:** CommonJS `require('express')` is already handled by the existing node-scanning loop.
The spec's description "check DEPENDS_ON edges from MODULE to EXTERNAL nodes" is incomplete — the
actual detection relies on the node check for CommonJS files, not the edge check. No code change
needed, but the spec must document this accurately to avoid implementors being misled.

### Spec change required

In Commit 4, replace the `_importsExpress` JSDoc comment:

**Before:**
```typescript
/**
 * Check if the file imports from 'express'.
 * Looks at DEPENDS_ON edges from MODULE to EXTERNAL nodes, and also
 * at the edge destination IDs (which contain the module name).
 */
```

**After:**
```typescript
/**
 * Check if the file imports from 'express'.
 *
 * Detection strategy (handles both ESM and CommonJS):
 *
 * 1. Edge check — ESM: `import express from 'express'` creates a DEPENDS_ON edge
 *    from MODULE to EXTERNAL#express and an IMPORTS_FROM edge to EXTERNAL_MODULE#express.
 *    The edge dst is an exact node ID, not a substring match.
 *
 * 2. Node check — both ESM and CommonJS: both `import express from 'express'` and
 *    `const express = require('express')` create an EXTERNAL_MODULE node with
 *    `name === 'express'` (exact). This check covers CommonJS files that do not
 *    produce DEPENDS_ON edges.
 *
 * False positive guard: the edge check uses exact ID matching (see Gap 4 fix).
 * The node check uses exact string equality on `node.name`, which is the package
 * name extracted from the import/require source argument.
 */
```

---

## Gap 4 — Substring Match Causes False Positives

### Investigation

**Problem:** `edge.dst.includes('express')` matches:
- `file->EXTERNAL->express-async-handler#0` (package `express-async-handler`)
- `file->EXTERNAL->express-validator#0` (package `express-validator`)
- `file->EXTERNAL->@express/core#0` (any scoped package containing `express`)

**Root cause:** The spec uses substring matching on the edge destination ID. The ID encodes the
package name, so partial package names match.

**Correct approach:** For ESM imports, the EXTERNAL node ID format (from `modules.ts` line 38) is:

```typescript
const externalId = `${ctx.file}->EXTERNAL->${source}#0`;
```

And the EXTERNAL_MODULE node ID format (from `ctx.nodeId`) is:

```typescript
`${ctx.file}->EXTERNAL_MODULE->${source}#${line}`
```

The node name is always the exact package name string. The correct fix is to check the node name
(already done for the node loop), or to build the exact expected edge destination.

**Fix strategy:** Replace the substring-based edge check with a set-based approach: first collect
the IDs of all EXTERNAL and EXTERNAL_MODULE nodes whose `name === 'express'` (exact), then check
whether any DEPENDS_ON/IMPORTS_FROM/IMPORTS edge points to one of those exact IDs.

### Code change required

In Commit 4, replace the `_importsExpress` method body:

**Before:**
```typescript
private _importsExpress(fileResult: Readonly<FileResult>): boolean {
  // Check edges: MODULE --DEPENDS_ON--> EXTERNAL#express or similar
  for (const edge of fileResult.edges) {
    if (edge.type === 'DEPENDS_ON' && edge.dst.includes('express')) {
      return true;
    }
    if (edge.type === 'IMPORTS_FROM' && edge.dst.includes('express')) {
      return true;
    }
  }
  // Also check EXTERNAL nodes directly (some may be in nodes without edges yet)
  for (const node of fileResult.nodes) {
    if (node.type === 'EXTERNAL' && node.name === 'express') {
      return true;
    }
    if (node.type === 'EXTERNAL_MODULE' && node.name === 'express') {
      return true;
    }
  }
  return false;
}
```

**After:**
```typescript
private _importsExpress(fileResult: Readonly<FileResult>): boolean {
  // Collect exact IDs of all EXTERNAL / EXTERNAL_MODULE nodes whose package name
  // is exactly 'express'. This covers both ESM and CommonJS:
  //   ESM:  import express from 'express'  → EXTERNAL node + EXTERNAL_MODULE node
  //   CJS:  require('express')             → EXTERNAL_MODULE node only
  const expressNodeIds = new Set<string>();
  for (const node of fileResult.nodes) {
    if (
      (node.type === 'EXTERNAL' || node.type === 'EXTERNAL_MODULE')
      && node.name === 'express'
    ) {
      expressNodeIds.add(node.id);
    }
  }

  if (expressNodeIds.size === 0) {
    return false;
  }

  // Confirm there is at least one import/dependency edge pointing at an express node.
  // This prevents false positives from manually constructed graph state.
  for (const edge of fileResult.edges) {
    if (
      (edge.type === 'DEPENDS_ON' || edge.type === 'IMPORTS_FROM' || edge.type === 'IMPORTS')
      && expressNodeIds.has(edge.dst)
    ) {
      return true;
    }
  }

  return false;
}
```

**Rationale for the two-pass approach:**

1. First pass collects exact node IDs for `'express'` nodes — uses `node.name === 'express'`
   (exact string equality, no substring). This correctly excludes `express-async-handler`,
   `express-validator`, and `@express/core`.

2. Second pass checks whether any import edge points to one of those exact IDs. This handles ESM
   (`DEPENDS_ON`, `IMPORTS_FROM`) and CommonJS (`IMPORTS`).

The previous single-pass EXTERNAL_MODULE node check (`node.name === 'express'`) was sufficient on
its own for detecting the presence of express, but the two-pass approach is more robust: it verifies
both that the node exists AND that there is an edge connecting it to the file's code, not just that
a node with that name happens to be in the result.

**Note:** The early return `if (expressNodeIds.size === 0) return false` short-circuits before the
edge scan for files with no express-related nodes, which is the common case for non-Express files.

---

## Gap 1 — Document TemplateElement.value.cooked Null Fallback (Non-blocking)

### Spec change required

In Commit 1, update the `argValues` extraction code comment and the "Invariants maintained" section.

**In the code block, replace the comment block before the argValues loop:**

**Before:**
```typescript
  // Extract string literal values for domain plugin consumption.
  // Position is preserved: argValues[i] corresponds to call.arguments[i].
  // null means the argument at that position is not a string literal.
  const argValues: (string | null)[] = [];
  for (const arg of call.arguments) {
    if (arg.type === 'StringLiteral') {
      argValues.push((arg as StringLiteral).value);
    } else if (
      arg.type === 'TemplateLiteral'
      && (arg as TemplateLiteral).quasis.length === 1
      && (arg as TemplateLiteral).expressions.length === 0
    ) {
      const tl = arg as TemplateLiteral;
      argValues.push(tl.quasis[0].value.cooked ?? tl.quasis[0].value.raw);
    } else {
      argValues.push(null);
    }
  }
```

**After:**
```typescript
  // Extract string literal values for domain plugin consumption.
  // Position is preserved: argValues[i] corresponds to call.arguments[i].
  // null means the argument at that position is not a static string.
  //
  // For TemplateLiteral with no expressions (e.g. `app.get(\`/users\`, h)`):
  //   - quasis[0].value.cooked is used when available. It is typed string | null
  //     in Babel's typedefs: it is null when the template contains an invalid escape
  //     sequence (e.g. `\unicode`). In that case, .raw is used as fallback — raw
  //     preserves the original backslash characters verbatim. For route paths this
  //     distinction is irrelevant in practice since route paths do not contain
  //     escape sequences.
  const argValues: (string | null)[] = [];
  for (const arg of call.arguments) {
    if (arg.type === 'StringLiteral') {
      argValues.push((arg as StringLiteral).value);
    } else if (
      arg.type === 'TemplateLiteral'
      && (arg as TemplateLiteral).quasis.length === 1
      && (arg as TemplateLiteral).expressions.length === 0
    ) {
      const tl = arg as TemplateLiteral;
      // cooked can be null for invalid escape sequences; fall back to raw.
      argValues.push(tl.quasis[0].value.cooked ?? tl.quasis[0].value.raw);
    } else {
      argValues.push(null);
    }
  }
```

**In the "Invariants maintained" section, add a bullet:**

After the existing bullets, add:
> - For `TemplateLiteral` arguments: `TemplateElement.value.cooked` is `string | null` per Babel's
>   type definitions (null when the template contains an invalid escape sequence). The implementation
>   falls back to `value.raw` when `cooked` is null. `raw` is always a string.

---

## Gap 5 — Duplicate Route Node ID Disambiguator (Non-blocking)

### Investigation

The ID format `${file}->http:route->${method}:${path}#${line}` can produce duplicate IDs when two
routes share the same method, path, AND line number. The most common real-world case:

```javascript
if (flag) app.get('/a', h1); else app.get('/a', h2); // both on line 1
```

Duplicate IDs silently corrupt the graph (two nodes with the same ID in `result.nodes`).

### Fix: add column as disambiguator

The CALL node already has a `column` field populated from `node.loc?.start.column ?? 0`. Two
method calls on the same line must start at different column positions (they cannot overlap).
Adding column to the ID makes same-line same-path same-method routes unique.

### Code change required

In `_createHttpRouteNode`, change the `id` field:

**Before:**
```typescript
id: `${callNode.file}->http:route->${method}:${path}#${callNode.line}`,
```

**After:**
```typescript
id: `${callNode.file}->http:route->${method}:${path}#${callNode.line}:${callNode.column}`,
```

Same change in `_createExpressMountNode`:

**Before:**
```typescript
id: `${callNode.file}->express:mount->${prefix}#${callNode.line}`,
```

**After:**
```typescript
id: `${callNode.file}->express:mount->${prefix}#${callNode.line}:${callNode.column}`,
```

### Test to add (Commit 4 test suite)

Add after the existing 8 test cases:

**Test 9: Same-line routes get unique IDs**
```javascript
test('two routes on same line produce unique node IDs', async () => {
  // Both app.get calls are on the same line — must differ by column
  const code = `import express from 'express'; const app = express(); app.get('/a', h1); app.get('/a', h2);`;
  const result = await walkFile(code, 'src/app.ts', jsRegistry, [new ExpressPlugin()]);
  const routeNodes = result.nodes.filter(n => n.type === 'http:route');
  assert.equal(routeNodes.length, 2, 'Two route nodes created');
  const ids = routeNodes.map(n => n.id);
  assert.notEqual(ids[0], ids[1], 'Route node IDs are unique');
});
```

### Update the node ID format documentation

In the "http:route node type and metadata schema" section, update the id comment:

**Before:**
```typescript
id:      string;  // "{file}->http:route->{METHOD}:{path}#{line}"
```

**After:**
```typescript
id:      string;  // "{file}->http:route->{METHOD}:{path}#{line}:{column}"
```

Same update for express:mount:

**Before:**
```typescript
id:      string;  // "{file}->express:mount->{prefix}#{line}"
```

**After:**
```typescript
id:      string;  // "{file}->express:mount->{prefix}#{line}:{column}"
```

---

## Summary of Changes

| Gap | Severity | Fix type | Changed section |
|-----|----------|----------|-----------------|
| Gap 1 | Non-blocking | Documentation | Commit 1: argValues loop comment + Invariants |
| Gap 2 | Blocking | Documentation | Commit 3: add backward-compat audit sentence |
| Gap 3 | Blocking | Documentation + JSDoc | Commit 4: `_importsExpress` JSDoc rewrite |
| Gap 4 | Blocking | Code change | Commit 4: replace `_importsExpress` body with two-pass approach |
| Gap 5 | Non-blocking | Code change + test | Commit 4: `id` field in `_createHttpRouteNode` / `_createExpressMountNode` + test 9 |

### Impact on other commits

- Commits 1, 2, 3: no code changes — Gap 2 fix is documentation only.
- Commit 4: `_importsExpress` body replaced (Gap 4), `_createHttpRouteNode` and
  `_createExpressMountNode` id format updated (Gap 5), JSDoc updated (Gap 3).
- Commit 5: no changes.

### No changes to test count for existing tests

The Gap 4 fix (`_importsExpress`) is purely a behavioral correction for false positives. All
existing tests in the spec use `import express from 'express'` as the import pattern, which
creates an EXTERNAL_MODULE node with `name === 'express'`. The new implementation detects this
correctly through the node check + edge confirmation. Existing tests pass unchanged.

The Gap 5 fix (id format adds `:column`) changes node IDs. **Update all existing test assertions**
in `express-plugin.test` that hard-code route node IDs to include the column suffix, or avoid
hard-coding IDs by looking up nodes by type and checking `metadata.path`/`metadata.method`.
The spec's existing tests already use `result.nodes.find(n => n.type === 'http:route')` rather than
asserting on raw IDs, so this change does not break the tests as written.
