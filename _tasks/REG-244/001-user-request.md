# REG-244: Tech debt: Extract shared ValueTracer utility

## Problem

During REG-230 implementation, we discovered code duplication between:

* `packages/cli/src/commands/trace.ts` - `traceToLiterals()` function
* `packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts` - `traceValueSet()` function

Both functions trace ASSIGNED_FROM edges recursively to find literal values. The logic is nearly identical.

## Why This Happened

`ValueDomainAnalyzer.getValueSet()` requires file + variableName parameters for lookup, designed for the enrichment phase. For sink tracing (REG-230), we already have the node ID, so we implemented a direct-from-nodeId approach.

## Solution

Extract a shared ValueTracer utility:

```typescript
// packages/core/src/analysis/ValueTracer.ts
export async function traceNodeToLiterals(
  graph: GraphBackend,
  nodeId: string,
  options?: { maxDepth?: number }
): Promise<ValueWithSource[]>
```

Then both use cases import and use this utility.

## Acceptance Criteria

- [ ] Create `packages/core/src/analysis/ValueTracer.ts` with shared tracing logic
- [ ] Refactor ValueDomainAnalyzer to use ValueTracer
- [ ] Refactor trace.ts sink tracing to use ValueTracer
- [ ] Update REG-230 comment reference to point to this issue

## Related

* REG-230: Sink-based value domain query (where duplication was introduced)
