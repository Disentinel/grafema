# REG-400: Callback-as-argument function references not resolved to CALLS edges

## Problem

When a function is passed as a callback argument (not inline), Grafema does not create a `CALLS` edge to the function. This means `grafema impact` reports 0 callers for functions that are extensively called via higher-order patterns.

## Example (from SWE-bench preactjs__preact-3345)

```js
// Definition at hooks/src/index.js:345
function invokeCleanup(hook) {
  const comp = currentComponent;
  if (typeof hook._cleanup == 'function') hook._cleanup();
  currentComponent = comp;
}

// 4 call sites via forEach:
hooks._pendingEffects.forEach(invokeCleanup);   // line 37
component._renderCallbacks.forEach(invokeCleanup); // line 56
c.__hooks._list.forEach(invokeCleanup);          // line 78
component.__hooks._pendingEffects.forEach(invokeCleanup); // line 290
```

`grafema impact "invokeCleanup"` → 0 callers, 0 affected, risk: LOW

## Root Cause

In `CallExpressionVisitor.ts`, when processing arguments:
- `Identifier` args → `targetType = 'VARIABLE'`, creates `PASSES_ARGUMENT` → `VARIABLE`
- But there's no resolution step from `VARIABLE(invokeCleanup)` → `FUNCTION(invokeCleanup)`
- And no `CALLS` edge is created

Meanwhile, `forEach` is in `BUILTIN_PROTOTYPE_METHODS` and skipped entirely by MethodCallResolver.

## Impact

Affects ALL higher-order function patterns in JS:
- `array.forEach(fn)`, `array.map(fn)`, `array.filter(fn)`, `array.reduce(fn)`
- `Promise.then(fn)`, `Promise.catch(fn)`
- `setTimeout(fn)`, `setInterval(fn)`
- `addEventListener('click', fn)`
- Custom HOFs: `registerPlugin(fn)`, `subscribe(fn)`

## Proposed Fix

Level 1 (Minimal): Resolve `Identifier` args that match `FUNCTION` nodes in scope → create `CALLS` edge
Level 2 (Full): Track "callable" arguments through HOF semantics

## Discovered Via

SWE-bench A/B test #2 (preactjs__preact-3345)
