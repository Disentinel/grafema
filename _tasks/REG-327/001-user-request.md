# REG-327: JSASTAnalyzer: create nodes for function-local variables

## Problem

JSASTAnalyzer currently only creates VARIABLE/CONSTANT nodes for **module-level** declarations. Function-local variables are NOT in the graph.

From `VariableVisitor.ts`:

```typescript
VariableDeclaration: (path: NodePath) => {
  // Only module-level variables
  const functionParent = path.getFunctionParent();
  if (!functionParent) {
    // ... process variable
  }
}
```

## Impact

This is a **fundamental architectural gap** that blocks multiple features:

1. **REG-326 (Backend value tracing)** — Cannot trace `res.json(users)` when `users` is a local variable
2. **Any data flow analysis inside functions** — The most common pattern in real code

Example that CANNOT be analyzed:

```javascript
app.get('/users', async (req, res) => {
  const users = await db.all('SELECT * FROM users');  // NOT in graph
  res.json(users);  // Cannot trace back to db.all()
});
```

This pattern represents **90%+ of real-world Express handlers**.

## Why This Matters

Grafema's vision: "AI should query the graph, not read code."

If function-local variables aren't in the graph, AI must read code to understand data flow inside functions. This defeats the core purpose.

## Acceptance Criteria

- [ ] Function-local variables (const, let, var inside functions) create VARIABLE nodes
- [ ] These nodes have proper scope information (parentFunctionId or scopePath)
- [ ] ASSIGNED_FROM edges connect to their initializers
- [ ] Existing tests pass
- [ ] Data flow tracing works for `const x = fn(); res.json(x)` pattern

## Technical Considerations

1. **Node count increase**: Many more VARIABLE nodes. Need to assess performance impact.
2. **Scope resolution**: Local variables shadow outer scope. Scope path must be accurate.
3. **Temporary variables**: May want to filter out trivial cases (loop counters, etc.) — TBD

## Blocked Issues

* REG-326 (Backend value tracing: trace from res.json() to data source)
