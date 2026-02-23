---
name: grafema-new-collection-wire-up
description: |
  Debug Grafema analysis phase where new node type produces 0 nodes despite being
  correctly detected and built. Use when: (1) new DomainBuilder is registered in
  GraphBuilder and implemented correctly, (2) detectX() method populates the new
  collection in allCollections, (3) unit tests show "Expected N nodes, got 0" even
  though build succeeds, (4) analysis logs show nodesCreated > 0 but no nodes of
  the new type appear. Root cause: JSASTAnalyzer.analyzeModule() passes collections
  to graphBuilder.build() explicitly — new collections MUST be added to this call or
  the builder receives an empty/undefined array.
author: Claude Code
version: 1.0.0
date: 2026-02-22
---

# Grafema New Collection Wire-Up (graphBuilder.build() Pass-Through)

## Problem

A new `PROPERTY_ASSIGNMENT` (or similar) node type is added:
- `DomainBuilder` is implemented and registered in `GraphBuilder` ✓
- Detection logic in `JSASTAnalyzer.detectX()` correctly populates `allCollections.newType` ✓
- TypeScript compiles clean ✓
- Unit tests all fail: `Expected 3 NEW_TYPE nodes, got 0` ✗

## Context / Trigger Conditions

- Just implemented a new node type following the DomainBuilder pattern
- New builder is registered in `GraphBuilder` (constructor + `build()` call)
- Detection/visitor code populates `allCollections.newType` correctly
- Test fixture contains the target code pattern (e.g., `this.x = value`)
- `pnpm build` succeeds with no TS errors
- Analysis logs show `nodesCreated: N` but node types list doesn't include the new type
- 0 nodes of the new type in `backend.getAllNodes()`

## Root Cause

`JSASTAnalyzer.analyzeModule()` (packages/core/src/plugins/analysis/JSASTAnalyzer.ts)
collects everything into `allCollections` but then **explicitly passes individual fields**
to `graphBuilder.build()`. The call looks like:

```typescript
const result = await this.graphBuilder.build(module, graph, projectPath, {
  functions,
  scopes,
  variableDeclarations,
  callSites,
  // ... ~40 other explicit fields ...
  objectMutations,           // ← explicitly wired up
  propertyAccesses: allCollections.propertyAccesses || propertyAccesses,
  // YOUR NEW COLLECTION IS MISSING HERE → builder gets undefined → 0 nodes
});
```

If your new collection is not in this object literal, `PropertyAssignmentBuilder.buffer()`
receives `data.newType = undefined`, which destructures to `[]`, and creates 0 nodes.

## Diagnosis

```bash
# Find the graphBuilder.build() call in JSASTAnalyzer
grep -n "graphBuilder.build\|\.build(module" \
  packages/core/src/plugins/analysis/JSASTAnalyzer.ts

# Look at the object passed to build() — search for the line ~2244 in JSASTAnalyzer.ts
# and read the 60+ lines of the object literal
# Verify your new collection field is listed there
grep -n "propertyAssignments\|YOUR_NEW_FIELD" \
  packages/core/src/plugins/analysis/JSASTAnalyzer.ts
```

If your field name does NOT appear in the `graphBuilder.build()` call → root cause confirmed.

## Solution

Add your new collection to the object literal in the `graphBuilder.build()` call
in `JSASTAnalyzer.analyzeModule()` (around line 2244-2310):

```typescript
const result = await this.graphBuilder.build(module, graph, projectPath, {
  // ... existing fields ...
  objectMutations,
  propertyAccesses: allCollections.propertyAccesses || propertyAccesses,
  propertyAssignments: allCollections.propertyAssignments,  // ← ADD THIS
  hasTopLevelAwait
});
```

**Pattern for the value:**
- If populated via `allCollections` only (function-level AND module-level collections merge there):
  `allCollections.myNewType`
- If populated in a local array AND allCollections (common for module-level):
  `allCollections.myNewType || localMyNewTypeArray`
- If only populated in allCollections:
  `allCollections.myNewType`

## Verification

After adding the field and rebuilding (`pnpm build`), unit tests should pass:

```
# Before fix:
# Expected 3 PROPERTY_ASSIGNMENT nodes, got 0. All node types: ["SERVICE","CLASS",...]

# After fix:
ok 1 - should create PROPERTY_ASSIGNMENT nodes for each this.x = param in constructor
# tests 6
# pass 6
# fail 0
```

## Example: REG-554

`PropertyAssignmentBuilder` was correctly implemented and registered. Detection in
`detectObjectPropertyAssignment()` populated `allCollections.propertyAssignments` correctly.
But the `graphBuilder.build()` call (line ~2305) was missing `propertyAssignments:`.

Fix: one line added to the build() call object:
```typescript
propertyAssignments: allCollections.propertyAssignments,
```

Result: all 6 unit tests immediately passed.

## Notes

- The `graphBuilder.build()` object literal in `JSASTAnalyzer.ts` has ~40+ fields — it's
  easy to miss when adding a new one. This is the #1 gotcha when adding new DomainBuilders.
- Unlike enrichment plugins (which use a registry), DomainBuilders get data passed explicitly.
- The `ASTCollections` type in `ast/types.ts` defines all fields — if your field is in the
  type but missing from the `build()` call, this bug will occur.
- Distinguish from `grafema-enricher-not-registered`: that skill covers enrichment plugins
  not registered in `builtinPlugins.ts`. This skill covers analysis-phase DomainBuilders
  where data is not forwarded from `allCollections` to `graphBuilder.build()`.
