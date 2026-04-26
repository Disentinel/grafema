# Linus Torvalds: Implementation Review

## Verdict
**APPROVED**

## Assessment

This is exactly what I asked for after the plan review. No bullshit, no extra complexity. Just the right thing, done right.

### What We Built

```
VARIABLE --ASSIGNED_FROM--> CONSTRUCTOR_CALL
```

Simple. Clean. Works.

### Implementation Quality

**1. They Actually Listened**

After my plan review, I said:
- Remove BUILTIN_JS singleton nodes → DONE
- Remove INVOKES edges → DONE
- Use `isBuiltin: boolean` field → DONE

No arguing, no "but what about...", no feature creep. They took the feedback and executed.

**2. Architecture is Correct**

The implementation follows the same pattern as METHOD_CALL and CALL_SITE:
- AST visitor creates node info during traversal
- GraphBuilder buffers the nodes
- Assignment edges point to the expression nodes

This is the right abstraction. A `new X()` expression IS a node in the graph, just like `obj.method()` or `func()`.

**3. Test Quality is Excellent**

18 comprehensive tests covering:
- Built-in constructors (Date, Map, Set, etc.)
- User-defined classes
- Multiple constructors in same file
- Edge cases (inside functions, arrow functions, class methods)
- Member expression callees (`new module.Class()`)
- Chained expressions (`new Builder().build()`)
- Integration with existing patterns

The tests communicate intent clearly. They verify actual graph structure, not implementation details.

**4. No Hacks**

I reviewed:
- `ConstructorCallNode.ts` - Clean contract, comprehensive built-in list, proper validation
- `JSASTAnalyzer.ts` - Dedicated visitor for NewExpression, creates node info
- `GraphBuilder.ts` - Buffers nodes, creates ASSIGNED_FROM edges by matching IDs
- `NodeFactory.ts` - Standard factory methods

No shortcuts. No "TODO: fix this later". No commented-out code. No type casts hiding design problems.

**5. Aligns with Project Vision**

"AI should query the graph, not read code."

Before this fix: AI has to read source code to find constructor assignments → Product gap.

After this fix: Query the graph → `VARIABLE --ASSIGNED_FROM--> CONSTRUCTOR_CALL` → Done.

This moves us toward the vision. Every `new X()` is now in the graph, queryable, traceable.

## Issues (None)

Kevlin noted one minor inconsistency in GraphBuilder (manually constructing node object instead of using factory return value). This is consistent with existing patterns in GraphBuilder, so it's a codebase-wide pattern, not a bug in this implementation.

The real fix would be refactoring how all nodes are buffered, but that's a separate task, not this PR's problem.

## What's Right About This

**No Premature Abstraction**

The implementation doesn't add INVOKES edges "just in case we need them later." It doesn't create BUILTIN_JS singletons "for semantic completeness."

It solves the actual problem: "Variables assigned from `new X()` don't have ASSIGNED_FROM edges."

That's it. Problem solved. Move on.

**Comprehensive Built-in List**

The `BUILTIN_CONSTRUCTORS` set includes:
- Core types (Date, Map, Set, Array, etc.)
- Error types (Error, TypeError, RangeError, etc.)
- Typed arrays (Int8Array, Uint8Array, etc.)
- Web APIs (URL, Headers, Request, Response, etc.)
- Modern features (Promise, Proxy, ReadableStream, etc.)

This is thorough without being pedantic. It covers real-world JavaScript, not textbook JavaScript.

**Handles Edge Cases**

The implementation correctly handles:
- Simple: `new Date()`
- With args: `new Database(config)`
- Member access: `new module.Database()`
- Inside functions: `function f() { const x = new Map(); }`
- Inside arrow functions: `const f = () => { const x = new Set(); }`
- Inside class methods: `class C { m() { const x = new Map(); } }`
- Chained: `new Builder().build()` (creates CONSTRUCTOR_CALL node even though result is immediately used)

No corner cases missed.

## Did We Forget Anything?

Let me check the original Linear issue acceptance criteria:

- ✅ `const date = new Date()` creates ASSIGNED_FROM edge
- ✅ `const map = new Map()` creates ASSIGNED_FROM edge
- ✅ `const db = new Database(config)` creates ASSIGNED_FROM edge to CONSTRUCTOR_CALL node (not CLASS, per simplified spec)
- ✅ Tests pass
- ⏸ Demo: "trace constructor-assigned variables" works (not run yet, but tests verify this)

One note: The acceptance criteria said "ASSIGNED_FROM edge to CLASS node" for user classes. We changed this during planning - ALL NewExpressions point to CONSTRUCTOR_CALL nodes, not CLASS nodes. This is the right decision (consistent model), but worth noting the deviation from original spec.

## Performance Considerations

The implementation adds:
- One AST traversal for NewExpression (alongside existing traversals)
- One node per `new X()` expression
- One edge per variable assigned from `new X()`

This is proportional to actual code structure. No N² algorithms, no duplicate traversals, no memory leaks.

## What's Next

1. **Run demo** - Steve Jobs should demo "trace constructor-assigned variables" before marking this complete
2. **Integration test** - Verify this works on a real codebase (not just unit tests)
3. **Update docs** - Document CONSTRUCTOR_CALL node type in graph schema

But the implementation itself? Done. Ship it.

## Summary

This is how you implement a feature:

1. Understand the problem (Don's analysis was correct)
2. Design the right abstraction (CONSTRUCTOR_CALL nodes)
3. Simplify (remove BUILTIN_JS, remove INVOKES)
4. Write tests first (TDD)
5. Implement cleanly (no hacks)
6. Verify (comprehensive tests)

No shortcuts. No clever code. No "temporary" hacks. Just the right thing, done right.

**Recommendation: APPROVED. Ready for demo and integration testing.**
