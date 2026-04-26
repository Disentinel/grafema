# Rob Pike Implementation Report: ClosureCaptureEnricher (REG-269)

## Summary

Successfully implemented the `ClosureCaptureEnricher` plugin for tracking transitive closure captures (depth > 1).

## Files Created/Modified

### Created
- `/packages/core/src/plugins/enrichment/ClosureCaptureEnricher.ts` - Main plugin implementation

### Modified
- `/packages/core/src/index.ts` - Added export for the new plugin
- `/packages/core/src/config/ConfigLoader.ts` - Added plugin to default enrichment list
- `/test/unit/ClosureCaptureEnricher.test.js` - Fixed test expectation for depth=1 edge handling

## Implementation Details

### Plugin Structure

The plugin follows existing enrichment plugin patterns (AliasTracker, MethodCallResolver):

```typescript
export class ClosureCaptureEnricher extends Plugin {
  static MAX_DEPTH = 10;

  get metadata(): PluginMetadata {
    return {
      name: 'ClosureCaptureEnricher',
      phase: 'ENRICHMENT',
      priority: 40,  // Runs after ImportExportLinker (90)
      creates: { nodes: [], edges: ['CAPTURES'] },
      dependencies: ['JSASTAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    // 1. Build scope index
    // 2. Build variables-by-scope index (VARIABLE, CONSTANT, PARAMETER)
    // 3. Find all closure scopes
    // 4. Build existing CAPTURES edge set
    // 5. For each closure, walk scope chain and create depth > 1 edges
  }
}
```

### Key Design Decisions

1. **Uses `BaseNodeRecord` not `NodeRecord`** - Matches other enrichment plugins

2. **PARAMETER node handling** - PARAMETERs have `parentFunctionId`, not `parentScopeId`. Resolved via HAS_SCOPE edge lookup to map parameters to their function's scope.

3. **Depth=1 edges skipped** - JSASTAnalyzer already creates depth=1 CAPTURES edges. This enricher only handles depth > 1.

4. **All scopes counted** - The scope chain walk includes all scopes (function, closure, block), not just closures. This matches JavaScript semantics where `if/for/while` blocks create their own lexical scopes.

5. **Cycle protection** - Uses visited set to prevent infinite loops in malformed scope chains.

6. **MAX_DEPTH limit** - Stops at depth 10 to prevent performance issues with deeply nested code.

### Edge Creation

For each closure scope:
- Walk up the scope chain via `parentScopeId`
- Track depth (1 = immediate parent, 2 = grandparent, etc.)
- Skip depth=1 (already handled by JSASTAnalyzer)
- For depth > 1, create CAPTURES edge with `metadata: { depth: N }`

## Test Fix

The original test "should not create duplicate CAPTURES edges" had incorrect expectations. It used a 2-level setup (outer -> inner) which only has depth=1 captures. The enricher correctly does nothing for depth=1 (by design).

Fixed by using a 3-level setup (outer -> inner -> deepest) with a pre-existing depth=2 edge to properly test the duplicate detection logic.

## Test Results

All 19 tests pass:
- Transitive captures: 3 tests
- No duplicates: 2 tests
- MAX_DEPTH limit: 1 test
- Edge cases: 3 tests
- CONSTANT nodes: 2 tests
- PARAMETER nodes: 2 tests
- Control flow scopes: 2 tests
- Plugin metadata: 1 test
- Result reporting: 1 test

## Build Status

Build passes with no TypeScript errors.

## Known Limitations

1. **Depth=1 inconsistency** - JSASTAnalyzer creates depth=1 edges without `metadata.depth`. This enricher creates depth > 1 edges with `metadata.depth`. Queries need to handle both cases:
   - `CAPTURES edge with metadata.depth > 1` → transitive captures
   - `CAPTURES edge without metadata.depth` → immediate captures (depth=1)

   This is documented as a known limitation per the plan revision (005-plan-revision.md).

2. **No actual variable reference tracking** - The enricher creates CAPTURES edges for ALL variables in ancestor scopes, not just those actually used by the closure. This is the same behavior as JSASTAnalyzer for depth=1.

## Summary Statistics

Example run with 3-level nesting:
```
closuresProcessed: 2
capturesCreated: 1  (depth=2 edge)
existingCapturesSkipped: 0
```

Example run with 15-level nesting (MAX_DEPTH test):
```
closuresProcessed: 14
capturesCreated: 9  (limited by MAX_DEPTH=10)
```
