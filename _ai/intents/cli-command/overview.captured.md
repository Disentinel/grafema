<!-- captured-at: 2026-04-27 -->
<!-- fixture: this repo (Grafema itself) -->

## overview-output
```

📊 Project Overview

Code Structure:
├─ Modules: 547
├─ Functions: 6171
├─ Classes: 71
├─ Variables: 982
└─ Call sites: 28505

External Interactions:
└─ External modules: 10

Graph Statistics:
├─ Total nodes: 443100
├─ Total edges: 808827
├─ Calls: 4089
├─ Contains: 228392
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
  "nodeCount": 443100,
  "edgeCount": 808827,
  "nodesByType": {
    "IMPORT_BINDING": 4415,
    "ISSUE": 26401,
    "CLASS": 71,
    "VARIABLE": 982,
    "CONSTANT": 5340,
    "CATCH_BLOCK": 156,
    "CONTRACT": 79,
    "ATTRIBUTE": 36,
    "TRY_BLOCK": 179,
    "INSTANCE": 216,
    "IMPL_BLOCK": 5,
    "CONSTRAINT": 8,
    "PROPERTY_SIGNATURE": 2367,
    "EXPORT_BINDING": 1555,
    "METRIC": 4998,
    "EXTERNAL_MODULE": 10,
    "RECORD_FIELD": 2012,
    "STRUCT": 19,
    "LET_BLOCK": 400,
    "FUNCTION": 6171,
    "mcp:tool": 40,
... (truncated, 90 more lines)
```
