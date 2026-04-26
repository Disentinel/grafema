# Phase 3: Resolution Plugins

## Goal

Cross-file resolution via Haskell plugins using the unified plugin protocol. Match imports to exports, resolve runtime globals.

## Prerequisites

- **Phase 1**: analyzer produces correct `FileAnalysis` with IMPORT_BINDING, ExportInfo, REFERENCE(resolved:false)
- **Phase 2 (2.6)**: orchestrator can run plugins via DAG

## Tasks

| Task | Title | Depends On | Status |
|------|-------|------------|--------|
| 3.1 | [grafema-common library](3.1-grafema-common.md) | — | Todo |
| 3.2 | [grafema-resolve skeleton](3.2-grafema-resolve-skeleton.md) | 3.1 | Todo |
| 3.3 | [JS import resolution](3.3-js-import-resolution.md) | 3.2 | Todo |
| 3.4 | [Runtime globals](3.4-runtime-globals.md) | 3.2 | Todo |

## Dependency Graph

```
3.1 ─── 3.2 ─┬─ 3.3
             └─ 3.4
```

## Success Criteria

1. `import { foo } from './bar'` produces IMPORTS_FROM edge linking to bar's foo export
2. `console.log()` resolves to runtime global definition
3. Unknown globals remain as REFERENCE(resolved:false)
4. Re-export chains are followed with cycle detection
