# REG-416: Detect aliased parameter invocation in HOFs

## Context

REG-401 added parameter invocation detection for user-defined HOFs. Currently only direct parameter name invocation is detected.

## Gap

When a HOF aliases a parameter before invoking it:

```js
function apply(fn) {
  const f = fn;
  f(); // Not detected as parameter invocation
}
apply(handler); // No callback CALLS edge created
```

The callee name `f` doesn't match parameter name `fn`.

## Approach

Requires intra-procedural data flow analysis: track ASSIGNED_FROM edges from VARIABLE `f` back to PARAMETER `fn`, then recognize `f()` as invoking parameter index 0. This may be better handled as a general data flow enhancement rather than HOF-specific logic.
