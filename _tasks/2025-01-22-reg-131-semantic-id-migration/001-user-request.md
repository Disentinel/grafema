# User Request: REG-131

## Complete Semantic ID Migration for Class Methods and Arrow Functions

### Context

From Steve Jobs demo review (REG-125, REG-126, REG-128): The semantic ID migration is incomplete. Class methods still use legacy `FUNCTION#` format while top-level functions use the new arrow-based format.

### Problem

Current output shows inconsistent ID formats:

```
[FUNCTION] processUser
  ID: index.js->global->FUNCTION->processUser     <-- CLEAN

[FUNCTION] getUser
  ID: FUNCTION#UserService.getUser#/private/tmp/steve-demo/index.js#8:2     <-- LEGACY
```

Expected:

```
ID: index.js->UserService->FUNCTION->getUser
```

### Scope

1. **Class methods** (ClassVisitor.ts lines ~246, ~307)
2. **Arrow functions in assignments**
3. **Anonymous functions**
4. **EXPRESSION nodes** (currently use colon format `/path:EXPRESSION:MemberExpression:2:44`)

### Files to Update

* `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`
* `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
* Possibly: `AnalysisWorker.ts`, `QueueWorker.ts`, `ASTWorker.ts`

### Acceptance Criteria

- [ ] All FUNCTION nodes use semantic ID format `{file}->{scope}->FUNCTION->{name}`
- [ ] Class methods: `index.js->ClassName->FUNCTION->methodName`
- [ ] No `FUNCTION#` patterns in query output
- [ ] EXPRESSION nodes have consistent format (or documented exception)

### Related

* REG-123 (Semantic IDs implementation)
* REG-125 (CLI semantic IDs - partial)
* REG-126 (MODULE semantic IDs - done)
