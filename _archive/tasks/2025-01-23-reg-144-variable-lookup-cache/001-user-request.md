# REG-144: Add variable lookup cache in GraphBuilder.bufferArrayMutationEdges

## Linear Issue

https://linear.app/reginaflow/issue/REG-144/add-variable-lookup-cache-in-graphbuilderbufferarraymutationedges

## Summary

Optimize linear search in `bufferArrayMutationEdges()` with Map-based lookup.

## Problem

From GraphBuilder.ts:

```typescript
const arrayVar = variableDeclarations.find(
  v => v.name === arrayName && v.file === file
);
```

This is O(n) for each mutation. With 1000 mutations and 100 variables, that's 100K comparisons.

## Solution

Add a lookup cache:

```typescript
// Build cache once
const varLookup = new Map<string, VariableDeclarationInfo>();
for (const v of variableDeclarations) {
  varLookup.set(`${v.file}:${v.name}`, v);
}

// O(1) lookup
const arrayVar = varLookup.get(`${file}:${arrayName}`);
```

## Acceptance Criteria

- [ ] Add Map-based lookup cache
- [ ] Benchmark shows improvement for large codebases
- [ ] All tests pass

## Context

From REG-127 code review. Low priority - only matters at scale.

## Lens Selection

This is a **Single Agent (Rob)** task:
- Well-understood optimization
- Clear requirements
- Single function scope
- <100 LOC expected
