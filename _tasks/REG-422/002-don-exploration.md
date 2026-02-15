# Don Melton — Exploration Report (REG-422)

## Key Findings

### File Size
- JSASTAnalyzer.ts: **6,203 lines** — confirmed

### analyzeFunctionBody Method
- **Lines 3501–4969** (1,469 lines)
- 4 params: `funcPath, parentScopeId, module, collections`
- Contains single `funcPath.traverse({...})` with 22+ visitor handlers inline

### Local Variables (Lines 3507–3763)
~73 const declarations in ~45-50 logical groups:
- Collection extractions (functions, scopes, variableDeclarations, callSites, etc.)
- Counter refs (8 counters)
- Object literal tracking (3 vars)
- Control flow (loops, branches, ifElseScopeMap)
- Try/catch/finally (6 vars + tryScopeMap)
- Promise/rejection tracking (4 vars)
- Tracking state (scopeIdStack, processedNodes, paramNameToIndex, etc.)
- controlFlowState object (loopCount, loopDepth, hasTryCatch, tryBlockDepth, branchCount, logicalOpCount)

### create*Handler Methods (6 total, ~855 lines)

| Method | Line | Params | ~Lines |
|--------|------|--------|--------|
| createLoopScopeHandler | 2144 | 12 | 240 |
| createTryStatementHandler | 2387 | 14 | 200 |
| createCatchClauseHandler | 2586 | 7 | 100 |
| createIfStatementHandler | 3184 | 12 | 180 |
| createConditionalExpressionHandler | 3362 | 8 | 80 |
| createBlockStatementHandler | 3446 | 4 | 55 |

### AnalyzerDelegate Candidates (~20 methods)
- handleVariableDeclaration, detectVariableReassignment, detectIndexedArrayAssignment
- detectObjectPropertyAssignment, extractReturnExpressionInfo, microTraceToErrorClass
- handleSwitchStatement, generateAnonymousName, generateSemanticId
- analyzeFunctionBody (recursive), collectUpdateExpression, countLogicalOperators
- handleCallExpression, collectCatchesFromInfo
- Plus 6 create*Handler methods

### Current Structure
- No `handlers/` directory exists yet
- No `VisitorHandlers` type defined (will need to create based on babel Visitor pattern)

### Tests
- **Snapshot tests**: 8 scenario files from REG-421 (GraphAsserter-based)
- **Unit tests**: 6+ files covering JSASTAnalyzer directly, 20+ integration tests
- Behavioral identity can be verified via snapshot tests

### Conclusion
Plan from REG-331 is accurate and confirmed. Ready for implementation.
