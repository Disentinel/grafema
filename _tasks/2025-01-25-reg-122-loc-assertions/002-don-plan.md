# Don Melton's Analysis: REG-122 - Audit and Replace Non-null loc Assertions

## Current State Analysis

Examined the codebase thoroughly and identified **167 occurrences** of `loc!` non-null assertions across 16+ files.

**Key Discovery: A utility already exists!**

In `ASTVisitor.ts` (lines 131-136), there's already a `getLoc()` method:

```typescript
protected getLoc(node: Node): LocationInfo {
  return {
    line: node.loc?.start?.line,
    column: node.loc?.start?.column
  };
}
```

**Problem:** This method returns `undefined` for missing locations, NOT the `0:0` fallback convention. And it's a protected method on `ASTVisitor`, not available to standalone analyzers.

## Pattern Categories Identified

**Category 1: Direct property access (most common)**
```typescript
node.loc!.start.line
node.loc!.start.column
```

**Category 2: In ID generation**
```typescript
const functionId = idGenerator.generateSimple('FUNCTION', node.id.name, module.file, node.loc!.start.line);
```

**Category 3: In location objects**
```typescript
{ line: classNode.loc!.start.line, column: classNode.loc!.start.column }
```

**Category 4: Inline in template strings**
```typescript
`SCOPE#if#${module.file}#${ifNode.loc!.start.line}:${ifNode.loc!.start.column}:${counterId}`
```

## The RIGHT Approach

**Do NOT just find-replace.** This would:
1. Repeat the same 20-character pattern 152+ times (violates DRY)
2. Not establish a clear, documented convention
3. Not provide a centralized place to change the fallback value if needed

**The RIGHT solution: Create a location utility module.**

## Proposed Architecture

Create `/packages/core/src/plugins/analysis/ast/utils/location.ts`:

```typescript
/**
 * Location extraction utilities for AST nodes.
 *
 * Convention: 0:0 means "unknown location" when AST node lacks position data.
 */
import type { Node, SourceLocation } from '@babel/types';

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
```

## Why This is RIGHT

1. **DRY**: Single source of truth for location extraction
2. **KISS**: Simple functions, obvious naming, clear documentation
3. **Documented Convention**: Comment clearly states 0:0 = unknown
4. **Flexible**: Can change fallback value in one place if needed
5. **Type-safe**: Returns concrete `number`, not `number | undefined`

## Files by Priority

**Tier 1: Core infrastructure**
- `ast/visitors/ASTVisitor.ts` - Update `getLoc()` to use new utility

**Tier 2: Heavy usage (most occurrences)**
- `JSASTAnalyzer.ts` - 56 occurrences
- `ast/visitors/CallExpressionVisitor.ts` - 27 occurrences
- `ast/visitors/ClassVisitor.ts` - 18 occurrences
- `ast/visitors/FunctionVisitor.ts` - 12 occurrences
- `ast/visitors/ImportExportVisitor.ts` - 12 occurrences
- `ast/visitors/TypeScriptVisitor.ts` - 6 occurrences

**Tier 3: Domain-specific analyzers**
- `ExpressAnalyzer.ts`, `ExpressRouteAnalyzer.ts`, `ReactAnalyzer.ts`
- `SocketIOAnalyzer.ts`, `FetchAnalyzer.ts`, `DatabaseAnalyzer.ts`
- `SQLiteAnalyzer.ts`, `ServiceLayerAnalyzer.ts`

**Tier 4: Worker files**
- `core/ASTWorker.ts` - 16 occurrences

## Execution Order

1. Create `location.ts` utility module
2. Write unit tests for the utility
3. Update `ASTVisitor.getLoc()` to use the utility
4. Refactor each file in tier order
5. Run full test suite after each file

## NOT Doing (Scope Discipline)

- Not changing the fallback value
- Not adding logging for unknown locations
- Not creating a LocationNode class
- Not changing semantic ID generation
