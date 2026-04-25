# Rob Pike - Loop Handlers Extraction Report

## Task
Extract 5 loop handlers (ForStatement, ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement) into a single factory method.

## Implementation

### Factory Method Created

Added `createLoopScopeHandler()` private method at line 1247 in `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`:

```typescript
private createLoopScopeHandler(
  trackerScopeType: string,
  scopeType: string,
  parentScopeId: string,
  module: VisitorModule,
  scopes: ScopeInfo[],
  scopeCounterRef: CounterRef,
  scopeTracker: ScopeTracker | undefined
): { enter: (path: NodePath<t.Loop>) => void; exit: () => void } {
  return {
    enter: (path: NodePath<t.Loop>) => {
      const node = path.node;
      const scopeId = `SCOPE#${scopeType}#${module.file}#${node.loc!.start.line}:${scopeCounterRef.value++}`;
      const semanticId = this.generateSemanticId(scopeType, scopeTracker);
      scopes.push({
        id: scopeId,
        type: 'SCOPE',
        scopeType,
        semanticId,
        file: module.file,
        line: node.loc!.start.line,
        parentScopeId
      });

      if (scopeTracker) {
        scopeTracker.enterCountedScope(trackerScopeType);
      }
    },
    exit: () => {
      if (scopeTracker) {
        scopeTracker.exitScope();
      }
    }
  };
}
```

### Replaced Handlers

Replaced 134 lines of duplicated code with 5 factory calls:

```typescript
ForStatement: this.createLoopScopeHandler('for', 'for-loop', parentScopeId, module, scopes, scopeCounterRef, scopeTracker),
ForInStatement: this.createLoopScopeHandler('for-in', 'for-in-loop', parentScopeId, module, scopes, scopeCounterRef, scopeTracker),
ForOfStatement: this.createLoopScopeHandler('for-of', 'for-of-loop', parentScopeId, module, scopes, scopeCounterRef, scopeTracker),
WhileStatement: this.createLoopScopeHandler('while', 'while-loop', parentScopeId, module, scopes, scopeCounterRef, scopeTracker),
DoWhileStatement: this.createLoopScopeHandler('do-while', 'do-while-loop', parentScopeId, module, scopes, scopeCounterRef, scopeTracker),
```

### Mapping Table

| Statement | trackerScopeType | scopeType |
|-----------|------------------|-----------|
| ForStatement | 'for' | 'for-loop' |
| ForInStatement | 'for-in' | 'for-in-loop' |
| ForOfStatement | 'for-of' | 'for-of-loop' |
| WhileStatement | 'while' | 'while-loop' |
| DoWhileStatement | 'do-while' | 'do-while-loop' |

## Type Safety

Used `t.Loop` as the generic type for the path parameter. This is the Babel base type for all loop statements and covers:
- ForStatement
- ForInStatement
- ForOfStatement
- WhileStatement
- DoWhileStatement

All these node types have the same `loc` property needed for line number extraction.

## Verification

- Build passes: `npm run build` completes successfully
- No behavior change: pure refactoring, same logic extracted

## Lines Changed

- Before: ~134 lines for 5 loop handlers
- After: 36 lines for factory + 5 one-liner calls
- Net reduction: ~90 lines

## Location

File: `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
- Factory method: lines 1247-1283
- Handler calls: lines 1435-1439
