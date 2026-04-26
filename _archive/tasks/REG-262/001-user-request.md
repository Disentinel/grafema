# REG-262: Bug: Method calls on objects don't create usage edges (false positive dead code)

## Problem

When a method is called on an object (`obj.method()`), no edge is created showing that `obj` is used. This causes false positive "dead code" warnings.

## Example

```typescript
const date = new Date(dateString)
return date.toLocaleDateString('ru-RU', {...})
```

**Current edges for** `date`:

* Incoming: `DECLARES` (function declares variable)
* Outgoing: `INSTANCE_OF` (Date class), `ASSIGNED_FROM` (new Date())

**Missing:** No edge showing `date` is used by `date.toLocaleDateString()`

## Result

DataFlowValidator reports:

```
[ERR_NO_LEAF_NODE] Variable "date" does not trace to a leaf node
Chain: CONSTANT:date -> CONSTRUCTOR_CALL:new Date() -> (no assignment)
```

This is a **false positive** — `date` IS used.

## Solution

When analyzing `obj.method()` calls, create an edge:

* `obj --RECEIVER_OF--> methodCall` or
* `methodCall --USES--> obj`

This way DataFlowValidator sees that `obj` has downstream usage.

## Impact

High — false positives erode trust in Grafema validation.
