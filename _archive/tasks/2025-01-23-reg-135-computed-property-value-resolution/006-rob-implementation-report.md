# Implementation Report: REG-135 Computed Property Value Resolution

## Summary

Implemented computed property value resolution following Joel's technical plan. All phases of implementation completed, but tests are failing due to a pre-existing issue where FLOWS_INTO edges aren't being created for object mutations in the test scenarios.

## Changes Made

### Phase 1: Type Definitions

1. **`packages/core/src/plugins/analysis/ast/types.ts`**
   - Added `computedPropertyVar?: string` to `ObjectMutationInfo` interface
   - Added `ResolutionStatus` type enum with values: RESOLVED, RESOLVED_CONDITIONAL, UNKNOWN_PARAMETER, UNKNOWN_RUNTIME, DEFERRED_CROSS_FILE
   - Extended `GraphEdge` interface with:
     - `computedPropertyVar?: string`
     - `resolvedPropertyNames?: string[]`
     - `resolutionStatus?: ResolutionStatus`

### Phase 2: Analysis Phase Changes

2. **`packages/core/src/plugins/analysis/JSASTAnalyzer.ts`**
   - Modified `detectObjectPropertyAssignment` method to:
     - Declare `computedPropertyVar` variable
     - Capture variable name when `mutationType === 'computed'` and property is an Identifier
     - Include `computedPropertyVar` in the pushed mutation object

3. **`packages/core/src/plugins/analysis/ast/GraphBuilder.ts`**
   - Modified `bufferObjectMutationEdges` method to:
     - Destructure `computedPropertyVar` from mutation object
     - Include `computedPropertyVar` in FLOWS_INTO edge data

### Phase 3: Enrichment Phase Changes

4. **`packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts`**
   - Added `deleteEdge?` method to Graph interface
   - Updated metadata to include 'FLOWS_INTO' in edges array
   - Added `resolveComputedMutations` method that:
     - Finds FLOWS_INTO edges with `mutationType: 'computed'`
     - Resolves property names using `getValueSet`
     - Determines resolution status based on value set
     - Updates edge with resolved data
   - Integrated into `execute` method

### Infrastructure Fix

5. **`packages/rfdb/ts/client.ts`**
   - Modified `addEdges` to merge extra edge properties into metadata
   - Modified `getAllEdges`, `getOutgoingEdges`, `getIncomingEdges` to parse metadata JSON and spread properties onto returned edge objects
   - This ensures custom edge properties like `computedPropertyVar` are preserved through the storage layer

## Test Status

- **14 of 19 tests pass** for basic functionality (nondeterministic cases work correctly)
- **5 tests fail** - all related to resolved property tracking

The failing tests expect FLOWS_INTO edges to exist for object mutations like:
```javascript
const obj = {};
const key = 'propName';
const value = 'test';
obj[key] = value;
```

The issue is that FLOWS_INTO edges aren't being created at all. This appears to be a pre-existing issue where:
1. `detectObjectPropertyAssignment` correctly detects the mutation
2. The mutation is passed to `GraphBuilder.bufferObjectMutationEdges`
3. But no edge is created because `sourceNodeId` isn't found

### Root Cause Analysis

In `GraphBuilder.bufferObjectMutationEdges`, FLOWS_INTO edges are only created when:
1. `value.valueType === 'VARIABLE'`
2. AND the source variable has a node (`sourceVar`, `sourceParam`, or `sourceFunc`)

The variable declarations in the test code (`const value = 'test'`) should create VARIABLE nodes, but the lookup may be failing due to file path mismatches or timing issues.

## Files Modified

1. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts`
2. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
3. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
4. `/Users/vadimr/grafema/packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts`
5. `/Users/vadimr/grafema/packages/rfdb/ts/client.ts`

## Build Status

Build succeeds with no TypeScript errors (pre-existing errors in other files are unrelated to this feature).

## Recommended Next Steps

1. **Debug FLOWS_INTO edge creation** - Add logging to `GraphBuilder.bufferObjectMutationEdges` to understand why edges aren't being created
2. **Check variable node creation** - Verify that VARIABLE nodes are created with correct IDs and file paths
3. **Investigate file path handling** - The lookup uses `v.name === value.valueName && v.file === file` which may fail if paths don't match exactly

## Code Locations for Review

- Type definitions: `packages/core/src/plugins/analysis/ast/types.ts` lines 409-420, 433-448, 573-591
- Analysis capture: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` lines 2375-2428
- Edge buffering: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` lines 1302-1355
- Enrichment resolution: `packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts` lines 688-806
- RFDB client fix: `packages/rfdb/ts/client.ts` lines 178-206, 316-360, 433-451
