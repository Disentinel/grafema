# User Request: REG-153

## Issue: Use semantic IDs for PARAMETER nodes instead of legacy format

**Source:** https://linear.app/reginaflow/issue/REG-153/use-semantic-ids-for-parameter-nodes-instead-of-legacy-format

## Context

Both FunctionVisitor and ClassVisitor create PARAMETER nodes using legacy line-based IDs:

```typescript
const paramId = `PARAMETER#${param.name}#${file}#${line}:${index}`;
```

## Problem

Line-based IDs are unstable - adding a comment above a function changes all parameter IDs. This makes:

* Graph diffs noisy
* Incremental analysis harder
* IDs less queryable

## Current State

* `IdGenerator.ts` has `generateLegacy()` method with comment "Used for: PARAMETER"
* But neither FunctionVisitor nor ClassVisitor use it
* `ParameterInfo` interface has optional `semanticId` field that's never populated

## Expected

Use semantic IDs for parameters, similar to functions:

```typescript
const semanticId = computeSemanticId('PARAMETER', param.name, scopeTracker.getContext());
```

## Investigation Needed

1. Why doesn't FunctionVisitor use IdGenerator for parameters?
2. Is there a technical reason or just historical oversight?
3. Are there any consumers that depend on the current ID format?

## Related

* REG-134: Created shared `createParameterNodes()` utility
* Linus review flagged this as tech debt during REG-134 implementation
