# REG-417: Support destructured/rest parameter invocation detection in HOFs

## Context

REG-401 added parameter invocation detection for user-defined HOFs. Currently only simple parameters are supported.

## Gap

Destructured and rest parameters are not detected:

```js
function apply({ fn }) { fn(); } // Destructured — no PARAMETER node created
function applyAll(...fns) { fns[0](); } // Rest — array access invocation
```

## Blockers

* Destructured parameters: PARAMETER nodes are not created for destructured params yet (see `createParameterNodes.ts` line 29). This must be fixed first.
* Rest parameters: invocation via array index access (`fns[0]()`) is a different call pattern from direct identifier invocation.

## Approach

1. First: create PARAMETER nodes for destructured params (separate issue)
2. Then: extend forward registration to match destructured param names
3. Rest params: likely requires separate analysis strategy
