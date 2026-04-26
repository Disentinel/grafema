# Joel Spolsky's Technical Plan: REG-122 - Audit and Replace Non-null loc Assertions

## Executive Summary

This plan expands Don's high-level analysis into a detailed, step-by-step implementation guide. The task is to create a centralized `location.ts` utility module and refactor 167 occurrences of `loc!` assertions across 15 files to use these utilities.

## Pattern Categories Found

**Pattern A: Direct line access (most common)**
```typescript
node.loc!.start.line
```

**Pattern B: Direct column access**
```typescript
node.loc!.start.column
```

**Pattern C: Both in object literal**
```typescript
{ line: node.loc!.start.line, column: node.loc!.start.column }
```

**Pattern D: In string template (ID generation)**
```typescript
`SCOPE#if#${module.file}#${ifNode.loc!.start.line}:${ifNode.loc!.start.column}:${counterId}`
```

## Detailed Implementation Plan

### Phase 1: Create Location Utility Module

**Step 1.1: Create location.ts**

File: `/packages/core/src/plugins/analysis/ast/utils/location.ts`

```typescript
/**
 * Location extraction utilities for AST nodes.
 *
 * Convention: 0:0 means "unknown location" when AST node lacks position data.
 */
import type { Node } from '@babel/types';

export const UNKNOWN_LOCATION = { line: 0, column: 0 } as const;

export interface NodeLocation {
  readonly line: number;
  readonly column: number;
}

export function getNodeLocation(node: Node | null | undefined): NodeLocation {
  return {
    line: node?.loc?.start?.line ?? 0,
    column: node?.loc?.start?.column ?? 0
  };
}

export function getLine(node: Node | null | undefined): number {
  return node?.loc?.start?.line ?? 0;
}

export function getColumn(node: Node | null | undefined): number {
  return node?.loc?.start?.column ?? 0;
}

export function getEndLocation(node: Node | null | undefined): NodeLocation {
  return {
    line: node?.loc?.end?.line ?? 0,
    column: node?.loc?.end?.column ?? 0
  };
}
```

**Step 1.2: Export from utils/index.ts**

### Phase 2: Write Unit Tests

File: `/test/unit/ast/utils/location.test.ts`

### Phase 3: Update ASTVisitor.getLoc()

Update to use new utility, mark as @deprecated in favor of direct imports.

### Phase 4: Refactor Files by Tier

**Tier 1: Core Visitors**
- FunctionVisitor.ts (7 occurrences)
- CallExpressionVisitor.ts (16 occurrences)
- ClassVisitor.ts (17 occurrences)
- ImportExportVisitor.ts (9 occurrences)
- TypeScriptVisitor.ts (6 occurrences)

**Tier 2: Main Analyzer**
- JSASTAnalyzer.ts (56 occurrences)

**Tier 3: Domain Analyzers**
- ExpressAnalyzer.ts (5)
- ExpressRouteAnalyzer.ts (9)
- FetchAnalyzer.ts (4)
- SocketIOAnalyzer.ts (6)
- ReactAnalyzer.ts (8)
- DatabaseAnalyzer.ts (1)
- SQLiteAnalyzer.ts (4)
- ServiceLayerAnalyzer.ts (4)

**Tier 4: Worker**
- ASTWorker.ts (15 occurrences)

### Phase 5: Verification

Run tests after each file, full suite before final commit.

## Execution Order

1. Create location.ts - no dependencies
2. Write unit tests - validates location.ts
3. Update ASTVisitor.getLoc() - uses location.ts
4. Refactor visitors
5. Refactor JSASTAnalyzer
6. Refactor domain analyzers
7. Refactor ASTWorker
8. Final verification

## Rollback Safety Points

Each tier can be committed separately:
- After Phase 1-2: location.ts exists, tests pass
- After Phase 3: ASTVisitor uses location.ts
- After Tier 1-4: Progressive refactoring

## NOT Doing (Scope Discipline)

- Not changing the fallback value (stays 0)
- Not adding logging for unknown locations
- Not creating a LocationNode class
- Not changing semantic ID generation logic
