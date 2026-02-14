# REG-401: Callback CALLS for user-defined HOFs via parameter invocation check

## Context

REG-400 introduced whitelist-based callback CALLS edge creation. Currently only known HOFs (forEach, map, setTimeout, etc.) get CALLS edges when a function is passed as callback.

User-defined HOFs like `function apply(fn) { fn(); }` do NOT get callback CALLS edges because `apply` is not in the whitelist.

## Goal

Add parameter invocation check: when a function reference is passed to a non-whitelisted function, verify whether the receiving function actually invokes the parameter.

## Approach

In enrichment phase (extend CallbackCallResolver or new plugin):

1. Find PASSES_ARGUMENT edges pointing to FUNCTION nodes where no callback CALLS edge exists
2. Find the receiving function via direct CALLS edge from the same call site
3. Check if any CALL node inside the receiving function's scope matches the parameter name at the argument index
4. If yes → create CALLS edge with `callType: 'callback'`

## Acceptance Criteria

* `function apply(fn) { fn(); } apply(handler)` → creates CALLS edge
* `function store(fn) { registry.push(fn); } store(handler)` → no CALLS edge
* Existing whitelist-based tests still pass
