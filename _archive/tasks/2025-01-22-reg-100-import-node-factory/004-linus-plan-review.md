# Linus Torvalds - Plan Review: REG-100

## Verdict: APPROVED WITH REQUIRED CHANGES

Both Don and Joel did solid work. The analysis is correct, the plan is sound, but there are a few things that need fixing before implementation.

## Analysis

### What's Right

**1. Semantic IDs are the correct decision.**

The move from `IMPORT#name#file#line` to `file:IMPORT:source:name` is exactly right. Line numbers in IDs are stupid - they change every time someone adds a comment or blank line. Semantic IDs are stable, queryable, and align perfectly with Grafema's vision that AI should query the graph, not read code.

**2. Worker migration scope is correctly identified.**

Don correctly identified that GraphBuilder is already migrated and three workers need updates. Joel's detailed plan covers all of them.

**3. The test fix is correct.**

The test at line 361-365 expects `line=0` to throw, but every other node type uses `line === undefined` check. The test is wrong, not the code. Joel's fix is correct.

**4. Implementation order makes sense.**

Starting with the test fix, then ASTWorker (most self-contained), then QueueWorker, then AnalysisWorker - this is a sensible progression.

### Concerns

**1. The test has the WRONG INPUTS, not just wrong expectations.**

Current failing test:
```javascript
it('should throw when line is missing', () => {
  NodeFactory.createImport('React', '/file.js', 0, 0, 'react');  // line=0
});
```

Joel proposes:
```javascript
it('should throw when line is undefined', () => {
  NodeFactory.createImport('React', '/file.js', undefined, 0, 'react');
});
```

This is correct. But the test name should also clarify that `0` is VALID for line. Consider adding a test that explicitly documents `line=0` is accepted:

```javascript
it('should accept line=0 as valid (unlike undefined)', () => {
  const node = NodeFactory.createImport('React', '/file.js', 0, 0, 'react');
  assert.strictEqual(node.line, 0);
});
```

**2. column=0 when unavailable - this is NOT a hack, this is documented behavior.**

Looking at ImportNode.ts line 39:
```typescript
* @param column - Column position (pass 0 if unavailable - JSASTAnalyzer limitation)
```

This is explicitly documented as expected behavior. The JSDoc says "pass 0 if unavailable". This is fine. It's not a hack, it's a pragmatic decision that's properly documented.

**3. line=1 as fallback in QueueWorker - this IS a smell.**

Joel proposes changing:
```typescript
node.loc?.start.line || 0  // OLD
node.loc?.start.line || 1  // NEW
```

The reasoning is "1 is more sensible for 1-indexed line numbers." But here's the problem: if `node.loc` doesn't exist, we don't KNOW what line this import is on. Using `1` is just a different lie than using `0`.

The REAL question is: why would `node.loc` ever be undefined for an import statement? If the AST was parsed correctly, location info should exist. If it doesn't exist, that's a bug upstream that we're papering over.

**However**, this is out of scope for REG-100. The current code uses `|| 0`, and changing it to `|| 1` is arguably better (since line numbers start at 1). Let's not block on this. But note it as tech debt.

**4. ASTWorker has a duplicate ImportNode interface that should be removed.**

Joel correctly identified this. The local interface at lines 42-50 of ASTWorker.ts should be deleted and replaced with the import from `./nodes/ImportNode.js`. This is cleanup that should happen as part of the migration.

### Required Changes

1. **Test fix must also add a positive test for `line=0`** to document that it's valid. The current test only checks that undefined throws - it should also verify 0 is accepted.

2. **Add a comment in QueueWorker explaining the fallback.**
   ```typescript
   // Fallback to line 1 if location unavailable (shouldn't happen for valid AST)
   node.loc?.start.line || 1
   ```

That's it. Everything else is fine.

## Alignment with Project Vision

**This is exactly what we should be doing.**

Grafema's thesis: "AI should query the graph, not read code."

Semantic IDs make this possible. With old IDs like `IMPORT#React#/app.js#5`, an AI agent would need to know the exact line number to query an import. That's useless - line numbers change constantly.

With semantic IDs like `/app.js:IMPORT:react:React`, the AI can ask "what does React import from 'react'?" without knowing anything about line numbers. This is the right abstraction.

The workers are generating nodes that will be queried by AI. They MUST use semantic IDs. This migration is necessary, not optional.

## What We're NOT Forgetting

REG-100 acceptance criteria:
- [x] ImportNode has static `create()` method with validation - DONE
- [x] NodeFactory.createImport() exists - DONE
- [ ] No inline IMPORT object literals in codebase - THIS IS WHAT WE'RE FIXING
- [ ] Tests pass - ONE TEST NEEDS FIX

The plan addresses all acceptance criteria.

## Approval Conditions

1. Joel's plan is approved for implementation with these additions:
   - Add positive test for `line=0` being valid
   - Add comment explaining the `|| 1` fallback in QueueWorker

2. After implementation, grep for `IMPORT#` should return zero matches in `packages/core/src/`.

3. After implementation, grep for `type: 'IMPORT'` should only match `ImportNode.ts` and type definitions.

**Go ahead and implement.**
