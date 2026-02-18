## Dijkstra Correctness Review — REG-491

**Verdict:** APPROVE

**Functions reviewed:**
- `NewExpressionHandler.getHandlers() → NewExpression visitor` — APPROVE
- `GraphBuilder.build() → section 4.5 (CONSTRUCTOR_CALL buffering)` — APPROVE with note
- `JSASTAnalyzer.traverse_new → NewExpression visitor` — APPROVE with note
- `ConstructorCallInfo` interface in `types.ts` — APPROVE

---

### 1. `ConstructorCallInfo.parentScopeId?: string` (types.ts:341)

**Input universe for the field:**

| Value | Source | Correct? |
|-------|--------|----------|
| Non-empty string (FUNCTION scope id) | `ctx.getCurrentScopeId()` inside a function body | YES — CONTAINS edge created |
| Non-empty string (MODULE id) | `module.id` in traverse_new (module-level) | YES — CONTAINS edge created |
| `undefined` | Field absent — never set this way in implemented code | N/A — both code paths always set the field |
| Empty string `""` | Cannot occur — see analysis below | N/A |

**Can `parentScopeId` be empty string?**

- `ctx.getCurrentScopeId()` returns `scopeIdStack[scopeIdStack.length - 1]`. The stack is initialized with `parentScopeId` (which is a FUNCTION scope id, guaranteed non-empty by the callers that set it up from `findFunctionId` or existing scope ids). The stack is never emptied to length 0 during traversal. **Empty string: not possible.**
- `module.id` is set from `moduleId` (e.g., a UUID or file-path-based string). Constructed as a non-empty string by `JSASTAnalyzer`. **Empty string: not possible in practice.**

**Conclusion:** The `if (constructorCall.parentScopeId)` guard in GraphBuilder correctly distinguishes "field present and non-empty" from `undefined`. The empty-string false-negative cannot occur given current construction of these values.

---

### 2. `NewExpressionHandler.getHandlers() → NewExpression` (NewExpressionHandler.ts:20-88)

**Input enumeration — what can `ctx.getCurrentScopeId()` return at this call site?**

This handler runs inside `analyzeFunctionBody`. At the point a `NewExpression` is visited:

| Scenario | `getCurrentScopeId()` returns | Correct? |
|----------|------------------------------|----------|
| Constructor call at function-body top level | FUNCTION scope id | YES |
| Constructor call inside `if`/`for`/`while` block | Inner SCOPE id (pushed when scope opened) | YES — scope id is that inner scope's id, which is the correct immediate containing scope |
| Constructor call inside nested function (arrow, named) | Outer function's scope id at the point where nested fn was entered | This is handled correctly because `analyzeFunctionBody` is called recursively for nested functions; the inner function gets its own handler chain |
| Constructor call inside class method | FUNCTION scope id of the method | YES |

**All cases: `parentScopeId` is always set to a non-empty string. No path sets it to `undefined`.** APPROVE.

---

### 3. `GraphBuilder.build() → section 4.5` (GraphBuilder.ts:303-323)

**Guard: `if (constructorCall.parentScopeId)`**

Input table for `constructorCall.parentScopeId`:

| Value | Source | Guard behavior | Result |
|-------|--------|----------------|--------|
| Non-empty string | `getCurrentScopeId()` (in-function) | truthy → CONTAINS edge created | Correct |
| Non-empty string (module id) | `module.id` (module-level) | truthy → CONTAINS edge created | Correct |
| `undefined` | Field was not set (cannot happen — see above) | falsy → no edge | Safe fallback, no orphan edge |
| Empty string `""` | Cannot happen | falsy → no edge | Would be a silent skip, but this case is impossible given current producers |

**Issue: parentScopeId is stripped from the node before buffering.**

At line 304-313, the node is buffered as a plain object that excludes `parentScopeId`:
```ts
this._bufferNode({
  id: constructorCall.id,
  type: constructorCall.type,
  name: `new ${constructorCall.className}()`,
  className: constructorCall.className,
  isBuiltin: constructorCall.isBuiltin,
  file: constructorCall.file,
  line: constructorCall.line,
  column: constructorCall.column
} as GraphNode);
```

This is intentional — `parentScopeId` is metadata for edge creation, not stored on the CONSTRUCTOR_CALL node itself. The CONTAINS edge makes the relationship queryable via the graph. This matches the pattern used for other node types (FUNCTION nodes strip `parentScopeId` at line 210). **APPROVE — the design is consistent.**

---

### 4. `JSASTAnalyzer.traverse_new → NewExpression visitor` (JSASTAnalyzer.ts:1731-1768)

**`getFunctionParent()` — exhaustive input enumeration:**

The visitor is a top-level `traverse(ast, {...})` over the full file AST. For every `NewExpression` node encountered:

| AST location of `new Foo()` | `getFunctionParent()` returns | Guard behavior | Result |
|-----------------------------|------------------------------|----------------|--------|
| Module top level | `null` | null → falsy → proceeds | CONSTRUCTOR_CALL pushed with `parentScopeId: module.id`. Correct. |
| Inside `if`/`for`/`while` at module level (no enclosing function) | `null` | null → falsy → proceeds | CONSTRUCTOR_CALL pushed with `parentScopeId: module.id`. Correct — module scope is the nearest function-level container. |
| Inside a `function` declaration or expression | NodePath to that function | truthy → early return | Skipped. Handled by `NewExpressionHandler` in `analyzeFunctionBody`. Correct, no duplicate. |
| Inside an arrow function | NodePath to that arrow function | truthy → early return | Skipped. Handled by `NewExpressionHandler`. Correct. |
| Inside a class constructor or method | NodePath to that method | truthy → early return | Skipped. Handled by `NewExpressionHandler`. Correct. |
| Inside a getter/setter | NodePath to that getter/setter | truthy → early return | Skipped. Handled by `NewExpressionHandler`. Correct. |
| Inside a class field initializer at module level: `class A { x = new Foo() }` | See analysis below | — | See below. |

**Edge case: class field initializer (`class A { x = new Foo() }`)**

In Babel's AST, a class field initializer `x = new Foo()` is represented as a `ClassProperty` node. Babel's `getFunctionParent()` traverses up through the path ancestors looking for a `Function` node type. In Babel 7+, `ClassProperty` initializers are **not** wrapped in a synthetic function node in the AST (unlike some older spec behavior). Therefore, `getFunctionParent()` called on a `NewExpression` inside a class field initializer will **find the nearest enclosing function that contains the class declaration**, not a function within the class itself.

This means:
- If the class is declared at module level: `getFunctionParent()` returns `null` (no enclosing function) → the node falls through to the `constructorCalls.push(...)` with `parentScopeId: module.id`.
- If the class is declared inside a function: `getFunctionParent()` returns the enclosing function → early return → handled by `NewExpressionHandler` in `analyzeFunctionBody`.

**For the module-level class field case:** The constructor call gets `parentScopeId: module.id`, which creates `MODULE --CONTAINS--> CONSTRUCTOR_CALL`. This is a reasonable approximation — the class field initializer runs at construction time but its structural parent in the graph becomes the module. **This is the same behavior as any other module-level new expression, and is acceptable given the scope of this task (adding CONTAINS edges for module-level constructor calls).**

**Note:** There is no duplication risk for this case. The `processedConstructorCalls` Set (keyed by `constructor:new:${start}:${end}`) ensures each `NewExpression` is processed at most once in `traverse_new`. The `NewExpressionHandler` in `analyzeFunctionBody` uses a separate `ctx.processedCallSites` Set keyed by `constructor:new:${start}:${end}` (same format). Since `analyzeFunctionBody` is only called for actual function nodes, and `getFunctionParent()` for a module-level class field initializer returns `null` (so it is NOT passed to `analyzeFunctionBody`), there is **no duplication**.

---

### Summary

**Issues found:** None that cause incorrect behavior.

**Notes recorded:**
- Empty-string `parentScopeId` cannot occur given current value producers — the guard `if (constructorCall.parentScopeId)` is correct in practice. If a future code path ever sets `parentScopeId` to `""`, the guard would silently skip edge creation. Low risk, noted for awareness.
- Class field initializer `new Foo()` at module level gets `parentScopeId: module.id` — a reasonable and consistent approximation. No CONTAINS edge is lost; no CONTAINS edge is duplicated.

**Verdict:** APPROVE
