# REG-124: Profiling Results — Jammers Project

**Date:** 2026-02-08
**Project:** Jammers (153 source files, 43 modules)
**Command:** `NAVI_PROFILE=1 grafema analyze /Users/vadimr/jammers --clear --auto-start`

## Results

### Total: 101.8 seconds

| Phase | Time | % |
|-------|------|---|
| ANALYSIS | 87.7s | **86%** |
| VALIDATION | 9.9s | 10% |
| ENRICHMENT | 3.6s | 3.5% |
| INDEXING | 0.5s | 0.5% |
| DISCOVERY | 0.006s | ~0% |

### JSASTAnalyzer Breakdown (inside ANALYSIS)

| Section | Time | Count | Avg |
|---------|------|-------|-----|
| graph_build | 1337ms | 83 | 16.1ms |
| traverse_imports | 426ms | 86 | 4.9ms |
| traverse_functions | 227ms | 86 | 2.6ms |
| babel_parse | 134ms | 86 | 1.6ms |
| traverse_classes | 103ms | 86 | 1.2ms |
| traverse_ifs | 88ms | 86 | 1.0ms |
| traverse_calls | 85ms | 86 | 1.0ms |
| traverse_assignments | 80ms | 86 | 0.9ms |
| traverse_new | 75ms | 86 | 0.9ms |
| traverse_variables | 74ms | 86 | 0.9ms |
| traverse_updates | 74ms | 86 | 0.9ms |
| traverse_typescript | 73ms | 86 | 0.8ms |
| traverse_callbacks | 72ms | 86 | 0.8ms |
| file_read | 8ms | 86 | 0.1ms |
| **TOTAL** | **2856ms** | | |

### Key Finding

**JSASTAnalyzer = 2.9s out of 87.7s ANALYSIS phase (3.3%)**

The remaining **84.8s (96.7%)** is spent in other analysis plugins (Express, SocketIO, Database, HttpRequest, DI, RouteResponse analyzers) — almost entirely on **IPC calls to RFDB**.

### Graph Size

- Nodes created: 12,523
- Edges created: 34,808
- Total graph operations: ~47,000+

### Bottleneck Analysis

```
Each IPC call:
  JS: JSON.stringify(data)     ~0.01ms
  JS: socket.write(buffer)     ~0.1ms
  Rust: read socket            ~0.1ms
  Rust: parse JSON             ~0.01ms
  Rust: execute operation       ~0.001ms
  Rust: serialize response     ~0.01ms
  Rust: write socket           ~0.1ms
  JS: read socket              ~0.1ms
  JS: JSON.parse(response)     ~0.01ms
  Total per call:              ~0.5-2ms

  × 47,000 operations = 23-94 seconds in IPC overhead
```

**Babel parsing (134ms total) is NOT the bottleneck.** Switching to Swc would save ~100ms.

**IPC serialization/deserialization is the bottleneck.** Eliminating it via in-memory graph could save 50-80 seconds.
