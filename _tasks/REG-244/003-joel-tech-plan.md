# Joel Spolsky's Technical Plan for REG-244

## Overview

This document expands Don's high-level plan into precise implementation specifications. The goal is to extract value tracing logic from two implementations (`trace.ts` and `ValueDomainAnalyzer.ts`) into a shared utility in `packages/core/src/queries/traceValues.ts`.

---

## 1. Type Definitions

All types go in `/packages/core/src/queries/types.ts`.

### 1.1 TracedValue

```typescript
/**
 * A single traced value from the graph.
 * Represents either a concrete value (from LITERAL) or an unknown value
 * (from PARAMETER, CALL, nondeterministic source, etc.)
 */
export interface TracedValue {
  /** The literal value (undefined if unknown) */
  value: unknown;
  /** Source location in the codebase */
  source: ValueSource;
  /** Whether value could not be determined statically */
  isUnknown: boolean;
  /** Why the value is unknown (for debugging/display) */
  reason?: UnknownReason;
}
```

### 1.2 ValueSource

```typescript
/**
 * Location of a value source in the graph
 */
export interface ValueSource {
  /** Node ID in the graph */
  id: string;
  /** File path */
  file: string;
  /** Line number (1-based) */
  line: number;
}
```

### 1.3 UnknownReason

```typescript
/**
 * Reason why a value could not be determined statically.
 * Used for debugging and user-facing messages.
 */
export type UnknownReason =
  | 'parameter'           // Function parameter (runtime input)
  | 'call_result'         // Return value from function call
  | 'nondeterministic'    // process.env, req.body, etc.
  | 'max_depth'           // Hit depth limit during traversal
  | 'no_sources';         // No ASSIGNED_FROM/DERIVES_FROM edges found
```

### 1.4 TraceValuesOptions

```typescript
/**
 * Options for traceValues()
 */
export interface TraceValuesOptions {
  /** Maximum traversal depth (default: 10) */
  maxDepth?: number;
  /** Follow DERIVES_FROM edges in addition to ASSIGNED_FROM (default: true) */
  followDerivesFrom?: boolean;
  /** Detect nondeterministic patterns like process.env (default: true) */
  detectNondeterministic?: boolean;
}
```

### 1.5 ValueSetResult

```typescript
/**
 * Aggregated result from tracing.
 * Convenience type for consumers who don't need individual sources.
 */
export interface ValueSetResult {
  /** All unique concrete values found */
  values: unknown[];
  /** Whether any path led to unknown value */
  hasUnknown: boolean;
}
```

### 1.6 TraceValuesGraphBackend

```typescript
/**
 * Minimal graph backend interface for traceValues().
 * Works with both RFDBServerBackend and internal Graph interface.
 */
export interface TraceValuesGraphBackend {
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

---

## 2. Implementation: traceValues.ts

Create `/packages/core/src/queries/traceValues.ts`.

### 2.1 Constants (move from ValueDomainAnalyzer)

```typescript
/**
 * Nondeterministic MemberExpression patterns.
 * object.property combinations that represent external/user input.
 */
export interface NondeterministicPattern {
  object: string;
  property: string;
}

export const NONDETERMINISTIC_PATTERNS: NondeterministicPattern[] = [
  // Environment variables
  { object: 'process', property: 'env' },
  // HTTP request data (Express.js patterns)
  { object: 'req', property: 'body' },
  { object: 'req', property: 'query' },
  { object: 'req', property: 'params' },
  { object: 'req', property: 'headers' },
  { object: 'req', property: 'cookies' },
  { object: 'request', property: 'body' },
  { object: 'request', property: 'query' },
  { object: 'request', property: 'params' },
  // Context patterns (Koa, etc.)
  { object: 'ctx', property: 'request' },
  { object: 'ctx', property: 'body' },
  { object: 'ctx', property: 'query' },
  { object: 'ctx', property: 'params' },
];

/**
 * Nondeterministic object prefixes.
 * Any property access on these is nondeterministic.
 */
export const NONDETERMINISTIC_OBJECTS: string[] = [
  'process.env',  // process.env.ANY_VAR
  'req.body',     // req.body.userId
  'req.query',    // req.query.filter
  'req.params',   // req.params.id
  'request.body',
  'ctx.request',
];
```

### 2.2 Main Function Signature

```typescript
/**
 * Trace a node to all its possible literal values.
 *
 * Starting from the given node, follows ASSIGNED_FROM (and optionally
 * DERIVES_FROM) edges backwards to find:
 * - LITERAL nodes: concrete values
 * - PARAMETER nodes: runtime inputs (unknown)
 * - CALL nodes: function return values (unknown)
 * - EXPRESSION nodes: checks for nondeterministic patterns
 *
 * @param backend - Graph backend for queries
 * @param nodeId - Starting node ID
 * @param options - Traversal options
 * @returns Array of traced values with sources
 *
 * @example
 * const values = await traceValues(backend, variableId);
 * for (const v of values) {
 *   if (v.isUnknown) {
 *     console.log(`Unknown from ${v.source.file}:${v.source.line} (${v.reason})`);
 *   } else {
 *     console.log(`Value: ${v.value} from ${v.source.file}:${v.source.line}`);
 *   }
 * }
 */
export async function traceValues(
  backend: TraceValuesGraphBackend,
  nodeId: string,
  options?: TraceValuesOptions
): Promise<TracedValue[]>
```

### 2.3 Algorithm (step-by-step)

```
traceValues(backend, nodeId, options):
  1. Initialize:
     - results: TracedValue[] = []
     - visited: Set<string> = new Set()
     - maxDepth = options?.maxDepth ?? 10
     - followDerivesFrom = options?.followDerivesFrom ?? true
     - detectNondeterministic = options?.detectNondeterministic ?? true

  2. Call internal recursive function:
     traceRecursive(nodeId, visited, depth=0)

  3. Return results

traceRecursive(nodeId, visited, depth):
  4. Cycle protection:
     - If visited.has(nodeId): return
     - visited.add(nodeId)

  5. Depth protection:
     - If depth > maxDepth:
       - Get node for source location
       - Push { value: undefined, source, isUnknown: true, reason: 'max_depth' }
       - Return

  6. Get node:
     - node = await backend.getNode(nodeId)
     - If !node: return
     - nodeType = node.type || node.nodeType

  7. Terminal: LITERAL
     - If nodeType === 'LITERAL':
       - Push { value: node.value, source: { id, file, line }, isUnknown: false }
       - Return

  8. Terminal: PARAMETER
     - If nodeType === 'PARAMETER':
       - Push { value: undefined, source, isUnknown: true, reason: 'parameter' }
       - Return

  9. Terminal: CALL (function return value)
     - If nodeType === 'CALL' || nodeType === 'METHOD_CALL':
       - Push { value: undefined, source, isUnknown: true, reason: 'call_result' }
       - Return

  10. Check nondeterministic EXPRESSION
      - If nodeType === 'EXPRESSION' && detectNondeterministic:
        - If isNondeterministicExpression(node):
          - Push { value: undefined, source, isUnknown: true, reason: 'nondeterministic' }
          - Return

  11. Get outgoing data flow edges:
      - edgeTypes = ['ASSIGNED_FROM']
      - If followDerivesFrom: edgeTypes.push('DERIVES_FROM')
      - edges = await backend.getOutgoingEdges(nodeId, edgeTypes)

  12. No edges case:
      - If edges.length === 0 && nodeType !== 'OBJECT_LITERAL':
        - Push { value: undefined, source, isUnknown: true, reason: 'no_sources' }
        - Return

  13. Recurse through sources:
      - For each edge in edges:
        - await traceRecursive(edge.dst, visited, depth + 1)
```

### 2.4 Helper: isNondeterministicExpression

```typescript
/**
 * Check if an EXPRESSION node represents a nondeterministic pattern.
 * E.g., process.env.VAR, req.body.userId, etc.
 */
function isNondeterministicExpression(node: {
  expressionType?: string;
  object?: string;
  property?: string;
}): boolean {
  if (node.expressionType !== 'MemberExpression') {
    return false;
  }

  const object = node.object;
  const property = node.property;

  if (!object || !property) {
    return false;
  }

  // Check exact patterns (object.property)
  for (const pattern of NONDETERMINISTIC_PATTERNS) {
    if (object === pattern.object && property === pattern.property) {
      return true;
    }
  }

  // Check if object is a known nondeterministic prefix
  for (const prefix of NONDETERMINISTIC_OBJECTS) {
    if (object === prefix || object.startsWith(prefix + '.')) {
      return true;
    }
  }

  return false;
}
```

### 2.5 Helper: aggregateValues

```typescript
/**
 * Aggregate traced values into a simplified result.
 * Useful for consumers who don't need source locations.
 *
 * @param traced - Array of traced values
 * @returns Aggregated result with unique values and hasUnknown flag
 */
export function aggregateValues(traced: TracedValue[]): ValueSetResult {
  const valueSet = new Set<unknown>();
  let hasUnknown = false;

  for (const t of traced) {
    if (t.isUnknown) {
      hasUnknown = true;
    } else if (t.value !== undefined && t.value !== null) {
      valueSet.add(t.value);
    }
  }

  return {
    values: Array.from(valueSet),
    hasUnknown,
  };
}
```

---

## 3. Edge Cases to Handle

| Case | Behavior |
|------|----------|
| Cycle (A -> B -> A) | `visited` set prevents infinite loop |
| Deep chains | `maxDepth` limit, returns `reason: 'max_depth'` |
| Node not found | Silent skip (node deleted from graph) |
| No ASSIGNED_FROM edges | Returns `reason: 'no_sources'` |
| OBJECT_LITERAL without edges | Does NOT mark as unknown (valid empty object) |
| Multiple ASSIGNED_FROM edges | Traces all branches (conditional assignment) |
| DERIVES_FROM + ASSIGNED_FROM | Traces both when `followDerivesFrom: true` |

---

## 4. Refactoring: ValueDomainAnalyzer

File: `/packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts`

### 4.1 Add imports

```typescript
import {
  traceValues,
  aggregateValues,
  NONDETERMINISTIC_PATTERNS,
  NONDETERMINISTIC_OBJECTS,
  type TraceValuesGraphBackend,
} from '../../queries/traceValues.js';
```

### 4.2 Remove duplicated constants

Delete these class statics (lines 121-148):
- `NONDETERMINISTIC_PATTERNS`
- `NONDETERMINISTIC_OBJECTS`

Replace with re-exports if needed for backward compatibility:
```typescript
// Re-export for backward compatibility (if any external code uses these)
export { NONDETERMINISTIC_PATTERNS, NONDETERMINISTIC_OBJECTS } from '../../queries/traceValues.js';
```

### 4.3 Remove isNondeterministicExpression method

Delete method at lines 513-542. No longer needed - logic is in shared utility.

### 4.4 Modify traceValueSet method

Replace the entire `traceValueSet` method (lines 547-637) with delegation to shared utility.

---

## 5. Refactoring: trace.ts

File: `/packages/cli/src/commands/trace.ts`

### 5.1 Add imports

```typescript
import {
  traceValues,
  type TracedValue,
  type ValueSource,
} from '@grafema/core';
```

### 5.2 Remove local ValueSource interface

Delete interface at lines 51-55. Now imported from @grafema/core.

### 5.3 Replace traceToLiterals function

Replace the entire `traceToLiterals` function (lines 599-666) with delegation to shared utility.

### 5.4 Update comment (REG-244 reference)

Find any comment referencing REG-244 duplication and update to indicate resolution:
```typescript
// Value tracing uses shared utility from @grafema/core (REG-244)
```

---

## 6. Export Configuration

### 6.1 Update queries/index.ts

Add:
```typescript
export { traceValues, aggregateValues } from './traceValues.js';
export {
  NONDETERMINISTIC_PATTERNS,
  NONDETERMINISTIC_OBJECTS,
} from './traceValues.js';
export type {
  TracedValue,
  ValueSource,
  UnknownReason,
  TraceValuesOptions,
  ValueSetResult,
  TraceValuesGraphBackend,
  NondeterministicPattern,
} from './types.js';
```

### 6.2 Update queries/types.ts

Add all new types from Section 1.

### 6.3 Update core/index.ts

Add to exports around line 268:
```typescript
export { traceValues, aggregateValues, NONDETERMINISTIC_PATTERNS, NONDETERMINISTIC_OBJECTS } from './queries/index.js';
export type { TracedValue, ValueSource, UnknownReason, TraceValuesOptions, ValueSetResult, TraceValuesGraphBackend, NondeterministicPattern } from './queries/index.js';
```

---

## 7. Test Plan

Create `/test/unit/queries/traceValues.test.ts`

### 7.1 Test Categories

**Basic Tracing Tests:**
- `should return literal value for LITERAL node`
- `should trace through ASSIGNED_FROM to LITERAL`
- `should trace through multiple ASSIGNED_FROM edges` (conditional)
- `should follow DERIVES_FROM edges`

**Terminal Node Tests:**
- `should mark PARAMETER as unknown with reason`
- `should mark CALL as unknown with reason`
- `should mark METHOD_CALL as unknown`
- `should mark nodes without edges as unknown`

**Nondeterministic Pattern Tests:**
- `should detect process.env access`
- `should detect req.body access`
- `should detect req.query access`
- `should detect ctx.request access`
- `should NOT mark regular MemberExpression as nondeterministic`
- `should detect nested nondeterministic (process.env.VAR)`

**Cycle Detection Tests:**
- `should handle self-cycle (A -> A)`
- `should handle mutual cycle (A -> B -> A)`
- `should handle longer cycles (A -> B -> C -> A)`

**Depth Limit Tests:**
- `should stop at maxDepth and mark as unknown`
- `should respect custom maxDepth option`
- `should trace fully when depth is sufficient`

**Options Tests:**
- `should NOT follow DERIVES_FROM when followDerivesFrom=false`
- `should NOT detect nondeterministic when detectNondeterministic=false`

**aggregateValues Tests:**
- `should deduplicate values`
- `should set hasUnknown if any trace is unknown`
- `should return empty values for all-unknown traces`
- `should filter null and undefined values`

**Source Location Tests:**
- `should include correct source for each traced value`
- `should include node ID in source`

---

## 8. Files Checklist

### Create (2 files):
| File | Purpose |
|------|---------|
| `packages/core/src/queries/traceValues.ts` | Shared utility implementation |
| `test/unit/queries/traceValues.test.ts` | Unit tests |

### Modify (5 files):
| File | Changes |
|------|---------|
| `packages/core/src/queries/types.ts` | Add TracedValue, ValueSource, UnknownReason, TraceValuesOptions, ValueSetResult, TraceValuesGraphBackend, NondeterministicPattern |
| `packages/core/src/queries/index.ts` | Export traceValues, aggregateValues, constants, and types |
| `packages/core/src/index.ts` | Export new utilities and types from queries |
| `packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts` | Import shared utility, remove duplicated code, delegate to traceValues |
| `packages/cli/src/commands/trace.ts` | Import from @grafema/core, replace traceToLiterals |

---

## 9. Implementation Order

1. **types.ts** - Add all type definitions first
2. **traceValues.ts** - Implement shared utility
3. **queries/index.ts** - Export new utilities
4. **core/index.ts** - Export from main package
5. **traceValues.test.ts** - Write tests (TDD)
6. **ValueDomainAnalyzer.ts** - Refactor to use shared utility
7. **trace.ts** - Refactor to use shared utility
8. Run all tests to verify no regression

---

## 10. Backward Compatibility Notes

- `ValueDomainAnalyzer.getValueSet()` API unchanged
- `ValueDomainAnalyzer.traceValueSet()` signature unchanged (private, but kept)
- `trace.ts` `traceToLiterals()` signature unchanged (private)
- New features (DERIVES_FROM, nondeterministic detection) enabled by default
- Both consumers get richer results without API changes
