## Uncle Bob — Code Quality Review

**Verdict:** REJECT

**File sizes:** OK — BranchHandler.ts is 411 lines (well under 500), JSASTAnalyzer.ts was already large (4283 lines, pre-existing), other files fine.

**Method quality:** OK — `createSwitchCaseVisitor()` is 71 lines, at the upper edge but acceptable given it mirrors the two-phase (enter/exit) structure of `createLoopHandler`. The internal logic is not complex.

**Patterns & naming:** REJECT — one critical ordering bug vs. established pattern.

---

### Issue: `enterCountedScope` / `generateSemanticId` ordering inverted relative to all other handlers

In every other handler in this codebase the ordering inside `enter` is:

```
generateSemanticId(...)   // uses current (parent) scope context
scopeIdStack.push(...)
enterCountedScope(...)    // now step INTO the new scope
```

Evidence from `createIfStatementVisitor` (BranchHandler.ts, lines 138, 156, 161):
```typescript
const ifSemanticId = analyzer.generateSemanticId('if_statement', ctx.scopeTracker); // before entering
// ...push to scopes...
ctx.scopeIdStack.push(ifScopeId);
ctx.scopeTracker.enterCountedScope('if');   // enter AFTER
```

Evidence from `createLoopHandler` (LoopHandler.ts, lines 267, 281, 286):
```typescript
const semanticId = analyzer.generateSemanticId(scopeType, ctx.scopeTracker); // before entering
// ...push to scopes...
ctx.scopeIdStack.push(scopeId);
ctx.scopeTracker.enterCountedScope(trackerScopeType);  // enter AFTER
```

But in `createSwitchCaseVisitor` (BranchHandler.ts, diff lines starting at `enter:`):
```typescript
ctx.scopeTracker.enterCountedScope(scopeLabel);   // WRONG: enters scope FIRST
// ...
const semanticId = analyzer.generateSemanticId(scopeType, ctx.scopeTracker); // now inside wrong scope
// ...
ctx.scopeIdStack.push(scopeId);
```

`generateSemanticId` calls `scopeTracker.getScopePath()` and `scopeTracker.getItemCounter(...)`. When called after `enterCountedScope`, the scope path includes the new scope rather than the parent scope. The `semanticId` is therefore generated from inside the new scope context, not the parent — which is the opposite of what every other handler does. This will produce incorrect `semanticId` values for switch-case SCOPE nodes.

The fix is to reorder: generate `scopeId` and `semanticId` first (in parent scope context), push to scopes, push to `scopeIdStack`, then call `enterCountedScope`.

---

**Everything else is clean:**

- `switchCaseScopeMap: Map<t.SwitchCase, string>` — clear name, correct type, inline comment confirms intent.
- `createSwitchCaseVisitor()` — follows the private factory method naming convention exactly (`createLoopHandler`, `createIfStatementVisitor`, `createBlockStatementVisitor`).
- `switch-case` / `default-case` scope type strings — consistent with existing kebab-case values (`for-loop`, `for-in-loop`, etc.).
- The `isEmpty` guard in JSASTAnalyzer preventing map population for empty cases — correct.
- The `switchCaseScopeMap.delete(caseNode)` cleanup in exit — correct, mirrors `ifElseScopeMap.delete`.
- `AnalyzerDelegate` parameter is `optional` (`?`) — correct, backward compatible.
- Test names are descriptive and intent-communicating. The two `describe` groups ("Case body SCOPE creation" and "Connectivity — zero disconnected nodes") clearly separate structural tests from the connectivity regression guard.
