# REG-139: Centralize ID generation - extract IdGenerator service

## Linear Issue

https://linear.app/reginaflow/issue/REG-139/centralize-id-generation-extract-idgenerator-service

## Summary

Extract duplicated ID generation pattern into centralized `ast/IdGenerator.ts` service.

## Problem

The legacy fallback ID pattern is duplicated **18+ times** across:

- JSASTAnalyzer.ts (11 instances)
- CallExpressionVisitor.ts (4 instances)
- FunctionVisitor.ts (2 instances)
- VariableVisitor.ts (1 instance)

Pattern repeated everywhere:

```typescript
const legacyId = `${nodeType}#${name}#${file}#${line}:${col}:${counter++}`;
const id = scopeTracker
  ? computeSemanticId(nodeType, name, scopeTracker.getContext())
  : legacyId;
```

## Solution

Create `packages/core/src/plugins/analysis/ast/IdGenerator.ts`:

```typescript
export class IdGenerator {
  constructor(private scopeTracker?: ScopeTracker) {}

  generateNodeId(
    nodeType: string,
    name: string,
    file: string,
    line: number,
    column: number,
    counterRef: { value: number },
    options?: { discriminator?: boolean; discriminatorKey?: string }
  ): string {
    const legacyId = `${nodeType}#${name}#${file}#${line}:${column}:${counterRef.value++}`;

    if (!this.scopeTracker) return legacyId;

    const discriminator = options?.discriminator
      ? this.scopeTracker.getItemCounter(options.discriminatorKey ?? `${nodeType}:${name}`)
      : undefined;

    return computeSemanticId(nodeType, name, this.scopeTracker.getContext(), { discriminator });
  }
}
```

## Acceptance Criteria

- [ ] Create IdGenerator class
- [ ] Replace all 18 instances with IdGenerator calls
- [ ] All existing tests pass
- [ ] No behavior change (pure refactoring)

## Context

From REG-127 code review.

## Lens Selection

This is a **Mini-MLA** task:
- Touches multiple files (4 files, 18+ instances)
- Pure refactoring (behavior must be preserved)
- Clear boundaries (ID generation only)
