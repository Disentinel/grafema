# Don Melton's High-Level Plan for REG-244

## Analysis Summary

I've thoroughly analyzed both implementations:

**trace.ts `traceToLiterals()` (lines 599-666):**
- Entry point: `nodeId` (already resolved)
- Returns: Array of `{ value, source: ValueSource, isUnknown }`
- Edge types: Only `ASSIGNED_FROM`
- Terminal nodes: LITERAL (returns value), PARAMETER (marks unknown)
- Missing: Nondeterministic pattern detection for EXPRESSION nodes

**ValueDomainAnalyzer.ts `traceValueSet()` (lines 547-637):**
- Entry point: `NodeRecord` (already fetched)
- Returns: `{ values: unknown[], hasUnknown: boolean }`
- Edge types: `ASSIGNED_FROM` + `DERIVES_FROM`
- Terminal nodes: LITERAL, PARAMETER, CALL (all mark unknown)
- Has: Rich nondeterministic pattern detection (`process.env`, `req.body`, etc.)
- Missing: Source location tracking

## Design Decisions

### 1. Location: `packages/core/src/queries/traceValues.ts`

Rationale: The `queries/` directory already contains shared graph query utilities (`findCallsInFunction`, `findContainingFunction`). This is NOT analysis plugin code - it's a query utility that can be used by both plugins (enrichment phase) and CLI tools (runtime queries). Following the established pattern is correct.

### 2. API Design

```typescript
// Unified result type - includes source locations
export interface TracedValue {
  value: unknown;           // The literal value (or undefined if unknown)
  source: ValueSource;      // Where this value comes from
  isUnknown: boolean;       // Whether value could not be determined
  reason?: UnknownReason;   // Why it's unknown (for debugging/display)
}

export interface ValueSource {
  id: string;      // Node ID
  file: string;    // File path
  line: number;    // Line number
}

export type UnknownReason =
  | 'parameter'           // Function parameter (runtime input)
  | 'call_result'         // Return value from function call
  | 'nondeterministic'    // process.env, req.body, etc.
  | 'max_depth'           // Hit depth limit
  | 'no_sources';         // No ASSIGNED_FROM edges found

export interface TraceValuesOptions {
  maxDepth?: number;                    // Default: 10
  followDerivesFrom?: boolean;          // Default: true
  detectNondeterministic?: boolean;     // Default: true
}

// Main entry point - takes node ID (as in trace.ts)
export async function traceValues(
  backend: GraphBackend,
  nodeId: string,
  options?: TraceValuesOptions
): Promise<TracedValue[]>;

// Convenience for aggregated result (as in ValueDomainAnalyzer)
export interface ValueSetResult {
  values: unknown[];
  hasUnknown: boolean;
}

export function aggregateValues(traced: TracedValue[]): ValueSetResult;
```

### 3. Minimal Graph Interface

Following the pattern from `findCallsInFunction.ts`:

```typescript
interface GraphBackend {
  getNode(id: string): Promise<{
    id: string;
    type?: string;
    nodeType?: string;
    value?: unknown;
    file?: string;
    line?: number;
    expressionType?: string;
    object?: string;
    property?: string;
  } | null>;
  getOutgoingEdges(
    nodeId: string,
    edgeTypes: string[] | null
  ): Promise<Array<{ src: string; dst: string; type: string }>>;
}
```

This works with both `RFDBServerBackend` and the internal `Graph` interface in plugins.

### 4. Nondeterministic Pattern Detection

Move `NONDETERMINISTIC_PATTERNS` and `NONDETERMINISTIC_OBJECTS` from `ValueDomainAnalyzer` to the shared utility. This benefits trace.ts which currently lacks this detection.

### 5. Edge Following Strategy

- Default: Follow both `ASSIGNED_FROM` and `DERIVES_FROM`
- `DERIVES_FROM` is important for template literals and composite expressions
- Option to disable for backward compatibility if needed

## Implementation Strategy

### Phase 1: Create shared utility
1. Create `packages/core/src/queries/traceValues.ts`
2. Implement `traceValues()` with all features from both implementations
3. Implement `aggregateValues()` helper
4. Move nondeterministic patterns to this file
5. Add comprehensive JSDoc documentation
6. Export from `packages/core/src/queries/index.ts`
7. Export from `packages/core/src/index.ts`

### Phase 2: Refactor ValueDomainAnalyzer
1. Import `traceValues`, `aggregateValues` from queries
2. Replace `traceValueSet()` method with call to `traceValues()`
3. Keep `NONDETERMINISTIC_PATTERNS` as re-export for backward compatibility (if externally used)
4. Keep `MAX_DEPTH` as class constant, pass to `traceValues()`
5. Keep `getValueSet()` public API unchanged - it wraps `traceValues()`

### Phase 3: Refactor trace.ts
1. Import `traceValues` from `@grafema/core`
2. Replace `traceToLiterals()` with call to `traceValues()`
3. Update the comment referencing REG-244 to indicate resolution
4. Benefits: Now gets nondeterministic detection for free

### Phase 4: Update tests
1. Add unit tests for `traceValues()` in `test/unit/queries/traceValues.test.ts`
2. Verify existing ValueDomainAnalyzer tests still pass
3. Verify existing trace.ts tests still pass (if any)

## Backward Compatibility

- `ValueDomainAnalyzer.getValueSet()` API unchanged
- `ValueDomainAnalyzer.traceValueSet()` kept as private, delegates to shared
- trace.ts `traceToLiterals()` becomes private, delegates to shared
- Both consumers get richer results (source locations, nondeterministic detection)

## Risk Assessment

**Low risk:**
- This is a pure refactoring - behavior should be identical
- Well-defined interfaces on both sides
- Clear test coverage requirements

**Considerations:**
- Ensure `DERIVES_FROM` edges don't change behavior for trace.ts (currently doesn't follow them)
  - Solution: Make it opt-in with default true, or verify trace.ts handles them correctly

## Files to Modify

1. **Create:** `packages/core/src/queries/traceValues.ts` - New shared utility
2. **Modify:** `packages/core/src/queries/index.ts` - Export new utility
3. **Modify:** `packages/core/src/queries/types.ts` - Add new types
4. **Modify:** `packages/core/src/index.ts` - Export new utility
5. **Modify:** `packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts` - Use shared utility
6. **Modify:** `packages/cli/src/commands/trace.ts` - Use shared utility
7. **Create:** `test/unit/queries/traceValues.test.ts` - Unit tests

## Critical Files for Implementation

- `packages/core/src/queries/findCallsInFunction.ts` - Pattern to follow for interface design
- `packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts` - Source of nondeterministic patterns and traceValueSet logic
- `packages/cli/src/commands/trace.ts` - Source of traceToLiterals logic with source locations
- `packages/core/src/queries/types.ts` - Where to add new types
- `packages/core/src/queries/index.ts` - Export point
