# REG-350: CLI: Show current phase during analysis

## Problem

During analysis of large codebases (4000+ modules, 1.5M+ nodes), user has no visibility into:

* Which phase is running (discovery / indexing / analysis / enrichment / validation)
* Progress within each phase
* Estimated time remaining

## Current behavior

Only shows final "Analysis complete" message. No intermediate progress.

## Requested

Show phase transitions:

```
[1/5] Discovery... 12 services found
[2/5] Indexing... 4047/4047 modules
[3/5] Analysis... 4047/4047 modules
[4/5] Enrichment... ImportExportLinker, MethodCallResolver, ...\n[5/5] Validation... 3 plugins
Analysis complete in 234.56s
```

## Priority

High for large codebase UX - users think CLI is frozen.

## Labels

- v0.2
- Improvement
