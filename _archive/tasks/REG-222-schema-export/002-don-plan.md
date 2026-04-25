# Don Melton: REG-222 Analysis

## Vision Alignment

**Verdict: Partially aligned, but original approach is wrong.**

The *goal* is correct: contract tracking, change detection, documentation. This aligns with Grafema's vision.

But the *proposed implementation* ("dogfooding via self-analysis") is architecturally incorrect. We don't need Grafema to analyze itself — the types are **statically defined**.

## Feasibility

### --graph mode

**Reality check:** There are NO `createNode`/`createEdge` functions to trace.

**Actual architecture:**
- Node types: `packages/types/src/nodes.ts` exports `NODE_TYPE` and `NAMESPACED_TYPE` const objects
- Edge types: `packages/types/src/edges.ts` exports `EDGE_TYPE` const object
- Nodes are created via `NodeFactory` static methods (`createService`, `createFunction`, etc.)

**Solution:** Just read and export the static type definitions. No graph traversal needed.

```typescript
import { NODE_TYPE, NAMESPACED_TYPE } from '@grafema/types';
import { EDGE_TYPE } from '@grafema/types';

// Export as JSON - that's it
```

### --interface mode

**For config schema extraction:**
- `GrafemaConfig` interface is in `packages/core/src/config/ConfigLoader.ts`
- Options:
  1. Use TypeScript Compiler API (`ts.createProgram()`) - most reliable
  2. Use existing Babel + TypeScriptVisitor infrastructure - already in codebase
  3. Parse AST manually with Babel - overkill

**Recommendation:** TypeScript Compiler API for accuracy, or simpler - just read the types package and generate from there.

## Architecture

### Where it lives
```
packages/cli/src/commands/schema.tsx  # New command
```

### Pattern to follow
- `packages/cli/src/commands/query.ts` - good reference for command structure
- `packages/cli/src/commands/analyze.ts` - for multi-step operations

### Key abstractions needed

```typescript
// packages/core/src/schema/
SchemaExporter.ts        # Main export logic
GraphSchemaExtractor.ts  # Extracts node/edge types from @grafema/types
InterfaceExtractor.ts    # Extracts TS interfaces (optional, may not be needed v1)
```

## Risks

1. **Over-engineering:** Original proposal wants "self-analysis" which is unnecessary complexity
2. **TypeScript parsing:** Interface extraction requires TS compiler, adds dependency
3. **Determinism:** Need stable key ordering for checksums

## Recommendation

**Go, but simplify scope for v1:**

### Phase 1 (REG-222)
- `grafema schema export --graph` - exports NODE_TYPE + EDGE_TYPE from @grafema/types
- JSON output with checksum
- Deterministic output (sorted keys)

### Phase 2 (future)
- `grafema schema export --interface` - if there's demand
- TypeScript interface extraction is complex, may not be worth it

### Why this is better

1. **Simpler:** No self-analysis, no graph traversal, no Babel parsing
2. **Faster:** Just imports and JSON.stringify
3. **Reliable:** Static types don't lie, runtime tracing can miss cases
4. **Honest:** We admit types are static, not dynamically discovered

## Next Steps

1. Joel to create detailed tech plan for Phase 1
2. Focus on `--graph` mode only
3. `--interface` moved to backlog if needed
