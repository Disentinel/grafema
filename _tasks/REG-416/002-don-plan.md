# Don Melton - Tech Lead Analysis: REG-416

## Detect Aliased Parameter Invocation in HOFs

---

## 1. Current Architecture Summary

### REG-401 Foundation (on `task/REG-401` branch, PR #23, not yet merged)

REG-401 introduced a **forward registration** pattern for user-defined HOF detection:

**Analysis phase** (`JSASTAnalyzer.ts`, inside `analyzeFunction`):
- Builds `paramNameToIndex: Map<string, number>` from the function's AST params
- During traversal of the function body, when a `CallExpression` callee is an `Identifier` matching a parameter name, records that param index in `invokedParamIndexes: Set<number>`
- After traversal, stores `invokesParamIndexes: number[]` as metadata on the `FunctionInfo` object

**Enrichment phase** (`CallbackCallResolver.ts`, Step 4):
- Collects all FUNCTION nodes with `invokesParamIndexes` metadata as "user-defined HOFs"
- For each HOF: finds call sites via incoming CALLS edges
- For each call site: checks PASSES_ARGUMENT edges, matching `argIndex` against `invokesParamIndexes`
- If matched: resolves argument to FUNCTION node, creates callback CALLS edge

### The Limitation (REG-416)

The detection in the analysis phase uses **direct name matching**:

```js
if (t.isIdentifier(callNodeForParam.callee) && paramNameToIndex.size > 0) {
  const paramIndex = paramNameToIndex.get(callNodeForParam.callee.name);
  if (paramIndex !== undefined) {
    invokedParamIndexes.add(paramIndex);
  }
}
```

When the parameter is aliased before invocation:
```js
function apply(fn) {
  const f = fn;  // f is an alias of parameter fn
  f();           // callee.name is 'f', not 'fn' — not in paramNameToIndex
}
```

The callee name `f` does not appear in `paramNameToIndex`, so the param index is never recorded. No `invokesParamIndexes` metadata, no callback CALLS edge.

### Variable-to-Parameter Edge Creation

When `const f = fn` is processed inside a function body:

1. `trackVariableAssignment` records `{ variableId, sourceType: 'VARIABLE', sourceName: 'fn' }`
2. `GraphBuilder.bufferAssignmentEdges` (line 1641) looks up `fn`:
   - First in `variableDeclarations` — not found (fn is a parameter)
   - Then in `parameters` — found
   - Creates **`DERIVES_FROM`** edge (not `ASSIGNED_FROM`): `VARIABLE(f) --DERIVES_FROM--> PARAMETER(fn)`

This edge exists in the graph after analysis. The data flow path is already there.

### Existing AliasTracker

`AliasTracker.ts` handles a related but different problem: resolving aliased **method calls** (`const m = obj.method; m()` -> resolve to the method). It:
- Follows `ASSIGNED_FROM` edges from VARIABLE/CONSTANT to EXPRESSION nodes
- Only cares about `MemberExpression` sources (not parameters)
- Does NOT follow `DERIVES_FROM` edges at all

---

## 2. What Needs to Change

### Core Insight

This is a **pure analysis-phase change**. The enrichment phase (CallbackCallResolver Step 4) is already correct and generic — it works with any `invokesParamIndexes` metadata. We just need the analysis phase to detect aliased invocations and add the correct param indexes.

### Approach: Intra-procedural Alias Map in `analyzeFunction`

During the function body traversal, build a **local alias map** that tracks which variables are aliases of parameters. When a call expression's callee name is found in this alias map, record the corresponding param index.

**Specifically:**

1. **Build alias map during traversal**: When encountering `VariableDeclaration` like `const f = fn` where `fn` is in `paramNameToIndex`, add `f -> paramIndex` to a local alias map.

2. **Check alias map on call expressions**: The existing `paramNameToIndex.get(calleeName)` check should be extended to also check the alias map.

3. **Transitive aliases**: Support chains like `const f = fn; const g = f; g()` by checking both `paramNameToIndex` and the alias map when processing new variable declarations.

### Why Analysis Phase, Not Enrichment Phase

- **Performance**: No additional graph traversal needed. The alias map is built during the existing `funcPath.traverse()` that already visits every node.
- **Forward registration**: Matches Grafema's architecture — analyzer marks data, enricher queries it.
- **Simplicity**: No need to query DERIVES_FROM edges at enrichment time. The information is available during AST analysis.

---

## 3. Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Extend `analyzeFunction` to build alias map and check it on CallExpression |
| `test/unit/CallbackFunctionReference.test.js` | Add tests for aliased parameter invocation |

**No other files need changes.** The enrichment phase (CallbackCallResolver) works generically with `invokesParamIndexes` metadata.

### Detailed Changes in `JSASTAnalyzer.ts`

In the `analyzeFunction` method (around the REG-401 block):

1. After building `paramNameToIndex`, create `aliasToParamIndex: Map<string, number>`

2. In the existing `VariableDeclaration` handler (line 3749), add a check:
   ```
   When processing `const f = <init>`:
     If init is Identifier and (paramNameToIndex.has(init.name) || aliasToParamIndex.has(init.name)):
       aliasToParamIndex.set(f, paramIndex)
   ```

3. In the CallExpression handler (the REG-401 block), extend the lookup:
   ```
   const paramIndex = paramNameToIndex.get(calleeName) ?? aliasToParamIndex.get(calleeName);
   ```

**Scope safety**: The existing traversal already handles nested functions correctly via `path.skip()` in FunctionDeclaration/FunctionExpression/ArrowFunction handlers, so shadowed alias names in nested functions won't be falsely matched (same reasoning as REG-401).

---

## 4. Risk Assessment

| Risk | Level | Mitigation |
|------|-------|------------|
| Shadowed alias names in nested scopes | LOW | Nested functions call `path.skip()`, same as REG-401 |
| Transitive alias chains (a=fn, b=a, c=b) | LOW | Alias map is built during traversal; later declarations can look up earlier aliases |
| Re-assignment (`let f = fn; f = other; f()`) | LOW | `let` reassignment is a separate AST node (AssignmentExpression), not VariableDeclaration. We only track `const`/initial `let` declarations. Conservative but correct — no false positives |
| Destructuring (`const {f} = {f: fn}`) | N/A | Out of scope (REG-417 covers destructured/rest params) |
| `fn.call()`/`fn.apply()` pattern | N/A | Out of scope (REG-415) |
| Dependency on REG-401 | MEDIUM | This branch must be based on REG-401 branch, or REG-401 must be merged first |

**Overall risk: LOW.** This is a small, well-scoped extension to existing REG-401 logic. No new enrichment plugins, no new edge types, no architectural changes.

---

## 5. Approach Recommendation

### Prerequisite

REG-401 (PR #23) must be merged first, or this branch must be rebased on top of `task/REG-401`.

### Implementation Steps

1. **Write tests** for:
   - Direct alias: `function apply(fn) { const f = fn; f(); }` -> invokesParamIndexes includes 0
   - Transitive alias: `function apply(fn) { const f = fn; const g = f; g(); }` -> same
   - Mixed: `function exec(fn, logger) { const f = fn; f(); }` -> only param 0 invoked
   - Store pattern negative: `function store(fn) { const f = fn; arr.push(f); }` -> no param invoked
   - Nested function shadow: `function apply(fn) { const f = fn; function inner() { f(); } }` -> **should still detect** because `f()` in `inner` still invokes the alias (needs careful thought -- see below)

2. **Implement alias map** in `analyzeFunction`:
   - Add `aliasToParamIndex: Map<string, number>` next to `paramNameToIndex`
   - Hook into existing `VariableDeclaration` handler to populate alias map
   - Extend `CallExpression` handler to check alias map

3. **Run tests**, verify all existing tests pass.

### Edge Case: Nested Function Invoking Alias

```js
function apply(fn) {
  const f = fn;
  function inner() {
    f();  // Does this count as "apply invokes param fn"?
  }
  inner();
}
```

The existing REG-401 code skips nested functions (they call `path.skip()`). This means `f()` inside `inner()` would NOT be detected. This is **correct conservative behavior** — `apply` doesn't directly invoke `fn`, `inner` does. Whether `inner()` is actually called depends on control flow.

However, the simpler case:
```js
function apply(fn) {
  const f = fn;
  f();  // Direct invocation at apply's scope level
}
```
This is what REG-416 needs to handle, and the existing traversal handles it correctly because `f()` is at the same scope level.

### Complexity

- **Lines of code**: ~15-20 lines added to JSASTAnalyzer
- **New tests**: ~4-5 test cases
- **Estimated time**: Small task, 1-2 hours
- **Algorithm complexity**: O(1) per variable declaration, O(1) per call expression (map lookups)

---

## 6. Prior Art

Intra-procedural alias analysis is well-studied. Our approach is a simplified version of **local copy propagation** — tracking which local variables hold copies of parameters. This is standard in compiler optimizations and static analysis frameworks:

- [FAST/ODGen](http://yinzhicao.org/FAST/ODGen-FAST.pdf) — uses intra-procedural data flow graphs for JavaScript analysis
- [Practical Static Analysis of JavaScript Applications (Microsoft)](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/tr-7.pdf) — covers alias tracking in JS
- [Pixy: Precise Alias Analysis for Static Detection](https://sites.cs.ucsb.edu/~chris/research/doc/plas06_pixy2.pdf) — alias analysis for vulnerability detection

Our approach is simpler than full alias analysis because we only need to track parameter-to-variable aliases within a single function scope, which is a constant-time operation per declaration.
