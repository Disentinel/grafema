# REG-545 Implementation Plan: CALL Nodes Linked to IMPORT Nodes via HANDLED_BY

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-21

## Summary of Root Causes

There are three distinct bugs to fix:

1. **ExternalCallResolver is not registered in `builtinPlugins.ts`** — the plugin exists and is correctly implemented with HANDLED_BY logic, but it is never instantiated in the production CLI pipeline.
2. **ExternalCallResolver is not in `createTestOrchestrator.js`** — integration tests cannot exercise it.
3. **FunctionCallResolver does not create HANDLED_BY edges for relative imports** — at Step 4.5, it creates `CALLS` to the FUNCTION but never creates `HANDLED_BY` to the IMPORT node.

---

## Shadowing: Include or Defer?

**Recommendation: Implement conservative shadowing detection.**

The AC says "via scope chain, respecting shadowing." The test scenario: a CALL inside a function where a local VARIABLE/CONSTANT has the same name as an imported symbol — the CALL should NOT get a HANDLED_BY edge to the import.

CALL nodes carry `parentScopeId`. VARIABLE/CONSTANT nodes with `parentScopeId` are the local bindings that shadow imports.

**Practical shadowing approach:** Build a `Set<string>` of `${file}:${localName}` pairs where a local variable/constant with that name exists in some scope (conservative). If a CALL's `file:calledName` is in this set, do not create HANDLED_BY.

This is conservative — may miss cases where variable is in nested scope but call is in outer scope — but will not create false HANDLED_BY edges. Full scope-chain traversal (walking parentScopeId chains) is deferred as follow-up.

---

## Step-by-Step Implementation Plan

### Phase 1: Tests First (TDD)

#### 1A. Add HANDLED_BY tests to `FunctionCallResolver.test.js`

File: `/Users/vadimr/grafema-worker-3/test/unit/FunctionCallResolver.test.js`

Add a new `describe` block: `'HANDLED_BY Edges (REG-545)'`.

Required test cases:
1. Named import called at top level: CALL gets `HANDLED_BY` pointing to the IMPORT node.
2. Named import called inside nested scope (CALL has `parentScopeId`): CALL still gets `HANDLED_BY` (not shadowed).
3. Shadowed import: CALL inside scope where a VARIABLE has same name as import — CALL should NOT get `HANDLED_BY`.
4. Update metadata test: `metadata.creates.edges` must now include `'HANDLED_BY'`.

#### 1B. Verify ExternalCallResolver tests cover HANDLED_BY

The existing `'HANDLED_BY Edges (REG-492)'` describe block in `test/unit/ExternalCallResolver.test.js` already covers this. No new tests needed — just confirm they pass once the plugin is registered.

---

### Phase 2: Fix FunctionCallResolver

File: `/Users/vadimr/grafema-worker-3/packages/core/src/plugins/enrichment/FunctionCallResolver.ts`

#### Change 2A: Update metadata `creates.edges`

```typescript
creates: {
  nodes: ['EXTERNAL_MODULE'],
  edges: ['CALLS', 'HANDLED_BY']  // add HANDLED_BY
},
```

Also update `produces` array to include `'HANDLED_BY'`.

#### Change 2B: Build shadowing index (after import index build)

Add after the existing import index is built:

```typescript
// Step 1.5: Build conservative shadowing index (REG-545)
// Set<file:localName> where a local variable/constant exists that shadows an import name.
// Conservative: any VARIABLE or CONSTANT in any scope with matching file+name blocks HANDLED_BY.
// Full scope-chain tracking deferred as follow-up.
const shadowedImportKeys = new Set<string>();
for await (const node of graph.queryNodes({ nodeType: 'VARIABLE' })) {
  const v = node as BaseNodeRecord & { parentScopeId?: string };
  if (v.file && v.name && v.parentScopeId) {
    shadowedImportKeys.add(`${v.file}:${v.name}`);
  }
}
for await (const node of graph.queryNodes({ nodeType: 'CONSTANT' })) {
  const c = node as BaseNodeRecord & { parentScopeId?: string };
  if (c.file && c.name && c.parentScopeId) {
    shadowedImportKeys.add(`${c.file}:${c.name}`);
  }
}
```

#### Change 2C: Add `handledByEdgesCreated` counter

```typescript
let edgesCreated = 0;
let handledByEdgesCreated = 0;
```

#### Change 2D: After CALLS edge for direct function (Step 4.5), add HANDLED_BY (Step 4.6)

```typescript
// Step 4.6: Create HANDLED_BY edge from CALL to IMPORT (REG-545)
const shadowKey = `${file}:${calledName}`;
if (!shadowedImportKeys.has(shadowKey)) {
  await graph.addEdge({
    type: 'HANDLED_BY',
    src: callSite.id,
    dst: imp.id
  });
  handledByEdgesCreated++;
}
```

#### Change 2E: After CALLS edge for external re-export branch, add HANDLED_BY

```typescript
// REG-545: Also create HANDLED_BY to the original IMPORT in the calling file
const shadowKeyExt = `${file}:${calledName}`;
if (!shadowedImportKeys.has(shadowKeyExt)) {
  await graph.addEdge({
    type: 'HANDLED_BY',
    src: callSite.id,
    dst: imp.id
  });
  handledByEdgesCreated++;
}
```

#### Change 2F: Update return value and final log

```typescript
logger.info('Complete', { edgesCreated, handledByEdgesCreated, skipped, time: `${totalTime}s` });

return createSuccessResult(
  { nodes: 0, edges: edgesCreated + handledByEdgesCreated },
  { callSitesProcessed, edgesCreated, handledByEdgesCreated, reExportsResolved, skipped, timeMs },
  errors
);
```

---

### Phase 3: Register ExternalCallResolver

#### Change 3A: Add to `builtinPlugins.ts`

File: `/Users/vadimr/grafema-worker-3/packages/cli/src/plugins/builtinPlugins.ts`

Add `ExternalCallResolver` to the import from `'@grafema/core'`.

Add registry entry after `FunctionCallResolver`:
```typescript
ExternalCallResolver: () => new ExternalCallResolver() as Plugin,
```

The plugin system respects `dependencies: ['FunctionCallResolver']` declared in ExternalCallResolver metadata to enforce execution order.

#### Change 3B: Add to `createTestOrchestrator.js`

File: `/Users/vadimr/grafema-worker-3/test/helpers/createTestOrchestrator.js`

Add imports:
```js
import { FunctionCallResolver } from '@grafema/core';
import { ExternalCallResolver } from '@grafema/core';
```

Add to enrichment block (after `CallbackCallResolver`):
```js
plugins.push(new FunctionCallResolver());
plugins.push(new ExternalCallResolver());
```

Order matters: FunctionCallResolver before ExternalCallResolver.

---

### Phase 4: Build and Test

```bash
pnpm build
node --test test/unit/FunctionCallResolver.test.js
node --test test/unit/ExternalCallResolver.test.js
node --test --test-concurrency=1 'test/unit/*.test.js'
```

---

## Exact File Changes Summary

| File | Change |
|------|--------|
| `FunctionCallResolver.ts` | Add `'HANDLED_BY'` to `creates.edges` and `produces` |
| `FunctionCallResolver.ts` | Add shadow index build (VARIABLE + CONSTANT query) |
| `FunctionCallResolver.ts` | Add `handledByEdgesCreated` counter |
| `FunctionCallResolver.ts` | Add HANDLED_BY edge after CALLS for direct function case |
| `FunctionCallResolver.ts` | Add HANDLED_BY edge after CALLS for external re-export case |
| `FunctionCallResolver.ts` | Update logger and return value |
| `builtinPlugins.ts` | Add `ExternalCallResolver` import and registry entry |
| `createTestOrchestrator.js` | Add `FunctionCallResolver` and `ExternalCallResolver` imports + instances |
| `FunctionCallResolver.test.js` | Add HANDLED_BY describe block (3 cases + metadata update) |

## Critical Files

- `/Users/vadimr/grafema-worker-3/packages/core/src/plugins/enrichment/FunctionCallResolver.ts`
- `/Users/vadimr/grafema-worker-3/packages/cli/src/plugins/builtinPlugins.ts`
- `/Users/vadimr/grafema-worker-3/test/helpers/createTestOrchestrator.js`
- `/Users/vadimr/grafema-worker-3/test/unit/FunctionCallResolver.test.js`
- `/Users/vadimr/grafema-worker-3/packages/core/src/plugins/enrichment/ExternalCallResolver.ts` (no code changes — verify only)
