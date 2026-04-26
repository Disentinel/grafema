# REG-535: PARAMETER nodes missing DERIVES_FROM to call-site arguments

## Problem

35 cases where data flow traces to a PARAMETER node and stops. PARAMETER is NOT a leaf type — it receives its value from the caller's argument.

Pattern: `VARIABLE:currentPath → ASSIGNED_FROM → PARAMETER:basePath → (dead end)`

## Examples

* `const currentPath = basePath` where basePath is a function parameter
* `const c = collections` where collections is a parameter
* `const filePath = file` where file is a parameter

## Expected

PARAMETER nodes should have DERIVES_FROM edges to the corresponding PASSES_ARGUMENT edges at each call site. Full chain:

```
VARIABLE:currentPath → PARAMETER:basePath → ARGUMENT@callsite → ... → LITERAL
```

## Leaf Types (for reference)

Only these are legitimate leaf types:

* LITERAL — hardcoded values
* net:stdio — user input
* db:query — database
* net:request — external HTTP/API
* fs:operation — file system
* event:listener — external events
* CLASS / FUNCTION — definitions

PARAMETER is an intermediate node, not a leaf.

## Where to Fix

Enrichment phase — cross-function data flow linking. Connect PARAMETER to call-site arguments via DERIVES_FROM.
