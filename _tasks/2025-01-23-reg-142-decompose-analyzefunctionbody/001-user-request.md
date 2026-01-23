# REG-142: Decompose analyzeFunctionBody into focused handler methods

## Summary

Break down 750+ line `analyzeFunctionBody` method into smaller, focused handlers.

## Problem

`JSASTAnalyzer.analyzeFunctionBody()` is ~750 lines handling 17 different concerns:

1. VariableDeclaration handling
2. AssignmentExpression detection
3. ForStatement scope
4. ForInStatement scope
5. ForOfStatement scope
6. WhileStatement scope
7. DoWhileStatement scope
8. TryStatement with catch/finally (200+ lines nested)
9. SwitchStatement handling
10. FunctionExpression creation
11. ArrowFunctionExpression creation
12. UpdateExpression tracking
13. IfStatement with conditional scopes
14. BlockStatement scope switching
15. CallExpression handling
16. MemberExpression calls
17. NewExpression calls

This violates Single Responsibility Principle and makes the code hard to test and maintain.

## Solution

Extract handlers:

```typescript
analyzeFunctionBody(...): void {
  funcPath.traverse({
    VariableDeclaration: (p) => this.handleVariableDeclaration(p, ctx),
    TryStatement: (p) => this.handleTryStatement(p, ctx),
    ForStatement: this.createLoopScopeHandler('for', ctx),
    CallExpression: (p) => this.handleCallExpression(p, ctx),
    // ... etc
  });
}

private handleVariableDeclaration(...) { /* 60-70 lines */ }
private handleTryStatement(...) { /* 150-200 lines */ }
private createLoopScopeHandler(type, ctx) { /* reusable for all loops */ }
```

## Acceptance Criteria

- [ ] Extract at least 5 handler methods
- [ ] Each method < 150 lines
- [ ] No behavior change (refactoring only)
- [ ] All tests pass

## Context

From REG-127 code review. Lower priority than IdGenerator extraction.
