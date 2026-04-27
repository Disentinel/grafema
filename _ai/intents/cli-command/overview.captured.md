<!-- captured-at: 2026-04-27 -->
<!-- fixture: this repo (Grafema itself) -->

## overview-output
```

📊 Project Overview

Code Structure:
├─ Modules: 567
├─ Functions: 6352
├─ Classes: 90
├─ Variables: 1056
└─ Call sites: 29505

External Interactions:
└─ External modules: 10

Graph Statistics:
├─ Total nodes: 261761
├─ Total edges: 519144
├─ Calls: 11053
├─ Contains: 237182
└─ Imports: 0

Next steps:
→ grafema query "function <name>"   Search for a function
→ grafema trace "<var> from <fn>"   Trace data flow
→ grafema impact "<target>"         Analyze change impact
→ grafema explore                   Interactive navigation
```

## json-output-for-scripting
```
{
  "nodeCount": 261761,
  "edgeCount": 519144,
  "nodesByType": {
    "VARIANT": 65,
    "CONSTANT": 5929,
    "DO_BLOCK": 1362,
    "PATTERN": 4693,
    "RECORD_FIELD": 2012,
    "CONSTRUCTOR": 1174,
    "CONTRACT": 111,
    "INSTANCE": 216,
    "cli:command": 35,
    "TYPE_ALIAS": 89,
    "ENUM": 10,
    "GUARANTEE": 51,
    "METHOD_SIGNATURE": 225,
    "EFFECT": 164,
    "LITERAL": 18946,
    "EXTERNAL_FUNCTION": 99,
    "ATTRIBUTE": 36,
    "CASE": 254,
    "MODULE": 567,
    "METRIC": 5190,
    "CONSTRAINT": 8,
... (truncated, 95 more lines)
```
