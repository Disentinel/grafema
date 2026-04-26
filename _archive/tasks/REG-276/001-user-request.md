# REG-276: Data flow: Handle complex expression returns (EXPRESSION type)

## Problem

REG-263 introduced RETURNS edges but skips complex expressions like:

```javascript
return a + b;
return condition ? x : y;
return obj.prop;
```

These should create EXPRESSION nodes with DERIVES_FROM edges to their sources, just like ASSIGNED_FROM does.

## Impact

* Functions with complex return expressions won't have RETURNS edges
* Data flow tracing incomplete for these cases

## Solution

1. Create EXPRESSION nodes for complex returns
2. Connect with DERIVES_FROM edges to source variables
3. Create RETURNS edge from EXPRESSION to function

## Related

* REG-263 (RETURNS edges MVP) - completed
