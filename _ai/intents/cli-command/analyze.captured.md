<!-- captured-at: 2026-04-27 -->
<!-- fixture: representative output (hand-curated; analyze is destructive — not auto-run) -->

## analyze-output
```
Discovering 547 source files (2 services)
Indexing                  ...  ✓ 547 modules
Parsing                   ...  ✓ 547 modules
Analyzing                 ...  ✓ 6 171 functions, 1 247 classes
Resolving                 ...  ✓ 8 905 cross-file edges
Enriching                 ...  ✓ 142 features, 119 behaviors, 112 contracts
Validating                ...  ✓ 0 critical, 14 warnings

Analysis complete in 84.2s
  Nodes: 434 363
  Edges: 796 076
  Library callbacks: 142 domain nodes (33 cli:command, 45 mcp:tool, 40 vscode:command, 24 package:export, 0 http:route)
  Contracts: 112 contracts (274 inputs, 34 outputs, 0 errors); 8 features lacked HANDLES edge
  Speced contracts: 112 (274 inputs); byCategory={"cli:command":35,"mcp:tool":40,"vscode:command":37}; missingExtractor=200, missingSpec=8
  Behaviors: 119 BEHAVIOR nodes, 0 SHARES_BEHAVIOR_WITH edges
  Manifest: .grafema/manifest.yaml
```

## force-rebuild-drops-cache
```
Clearing existing graph database (--clear)
  Removed 434 363 nodes, 796 076 edges
Discovering 547 source files (2 services)
Indexing ... [continues as full-analysis above]
```
