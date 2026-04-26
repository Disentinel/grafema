# Kent Tests Report: REG-559

## Test File

`test/unit/ArrowFunctionArgDedup.test.js`

## Test Results

**5 pass, 0 fail** (duration: ~2.5s)

## Test Cases

### Test 1: Basic dedup — `arr.map(x => x)` inside class method
- **Input:** Class `MyClass` with `run()` method containing `this.items.map(x => x)`
- **Assert:** Exactly 1 FUNCTION node for the `x => x` arrow
- **Result:** PASS

### Test 2: Original bug — `this.plugins.some(p => ...)`
- **Input:** Class `PluginManager` with `loadPlugins()` containing `this.plugins.some(p => p.metadata?.phase === 'DISCOVERY')`
- **Assert:** Exactly 1 FUNCTION node for `p => ...`; PASSES_ARGUMENT edge from `.some()` points to the single FUNCTION node
- **Result:** PASS

### Test 3: Module-level arrow still works (smoke test)
- **Input:** `const fn = x => x * 2;`
- **Assert:** Exactly 1 FUNCTION node named `fn`
- **Result:** PASS — FunctionVisitor correctly handles module-level arrows (no function parent)

### Test 4: Regression anchor — class field arrow (REG-562)
- **Input:** `class A { field = x => x; }`
- **Assert:** Exactly 2 FUNCTION nodes (named `field` from ClassVisitor + anonymous from FunctionVisitor)
- **Result:** PASS — documents pre-existing duplication that REG-559 does NOT fix (class fields have no function parent, so the guard doesn't skip them)

### Test 5: Default parameter arrow
- **Input:** `function outer(cb = x => x) { return cb(1); }`
- **Assert:** Exactly 1 anonymous FUNCTION node for the default parameter arrow
- **Result:** PASS — NestedFunctionHandler handles the default arrow; FunctionVisitor skips it via `getFunctionParent()` guard

## Architecture Notes

The REG-559 fix adds a `getFunctionParent()` guard to FunctionVisitor's `ArrowFunctionExpression` handler. This correctly deduplicates arrows nested inside function bodies (handled by NestedFunctionHandler). However, class field arrows (`field = x => x`) are NOT inside a function body, so the guard does not skip them — resulting in 2 FUNCTION nodes per class field arrow (REG-562).
