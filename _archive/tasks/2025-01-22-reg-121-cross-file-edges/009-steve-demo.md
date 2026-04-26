# Demo Report: REG-121 Cross-File Edges After Clear

**Demo Date:** 2025-01-22
**Status:** PARTIAL SUCCESS - Fix works, but CLI not configured to use it

## Summary

The fix for REG-121 (cross-file edges not recreated after graph.clear()) is **technically correct** - all 12 unit tests pass. However, the CLI does not include `ImportExportLinker` in its default plugins, so the fix is invisible to end users.

## Test Results

```
# tests 12
# pass 12
# fail 0
```

All tests passed:
- IMPORTS_FROM edges consistency (3 tests)
- MODULE -> IMPORTS -> MODULE edges for relative imports (3 tests)
- Complex multi-file scenarios (3 tests)
- Edge correctness verification (1 test)
- Re-export scenarios (2 tests)

## What Works

The `ImportExportLinker` plugin correctly:
1. Creates IMPORTS_FROM edges (IMPORT node -> EXPORT node)
2. Creates IMPORTS edges (MODULE -> MODULE)
3. Preserves edges after clear + re-analysis
4. Handles default imports, named imports, re-exports, circular imports, and export *

## What Does NOT Work

**The CLI does not use ImportExportLinker by default.**

Looking at `/Users/vadimr/grafema/packages/cli/src/commands/analyze.ts`:

```typescript
const DEFAULT_PLUGINS = {
  indexing: ['JSModuleIndexer'],
  analysis: [
    'JSASTAnalyzer',
    'ExpressRouteAnalyzer',
    // ... other analyzers
  ],
  enrichment: [
    'MethodCallResolver',
    'AliasTracker',
    'ValueDomainAnalyzer',
    'MountPointResolver',
    'PrefixEvaluator',
    'HTTPConnectionEnricher',
    // NOTE: ImportExportLinker is MISSING!
  ],
  validation: [
    // validators...
  ],
};
```

The `ImportExportLinker` is exported from `@grafema/core` but NOT included in the CLI's default plugin list.

## Demo Attempt

```bash
# Created demo project
mkdir -p /tmp/grafema-demo-reg121
echo '{"name":"demo","type":"module"}' > package.json
echo 'export function helper() { return 1; }' > utils.js
echo 'import { helper } from "./utils.js"; helper();' > index.js

# Ran analysis
grafema analyze /tmp/grafema-demo-reg121

# Result: 9 nodes, 8 edges
# But 0 IMPORTS_FROM edges, 0 IMPORTS edges!
```

The graph has MODULE, FUNCTION, IMPORT, EXPORT, CALL nodes, but no cross-file linking edges.

## Root Cause

The fix was implemented in `ImportExportLinker`, but this plugin is not registered in the CLI's default configuration.

## Required Fix

Add `ImportExportLinker` to the CLI's default enrichment plugins:

```typescript
// In packages/cli/src/commands/analyze.ts

import {
  // ... existing imports
  ImportExportLinker,  // ADD THIS
} from '@grafema/core';

const BUILTIN_PLUGINS = {
  // ...
  ImportExportLinker: () => new ImportExportLinker() as Plugin,  // ADD THIS
};

const DEFAULT_PLUGINS = {
  // ...
  enrichment: [
    'ImportExportLinker',  // ADD THIS (should be first, before other enrichment)
    'MethodCallResolver',
    'AliasTracker',
    // ...
  ],
};
```

## Verdict

**DEMO: FAILED**

The feature is technically implemented and tested, but the CLI does not expose it to users. This is a configuration gap that must be fixed before the task can be considered complete.

Would I show this on stage? No. The user runs `grafema analyze`, expects import/export relationships, and gets nothing. That's not delightful - that's confusing.

## Action Required

1. Add `ImportExportLinker` to CLI's default plugins
2. Rebuild CLI (`pnpm build`)
3. Re-run demo to verify IMPORTS_FROM edges appear
4. Only then can this task be marked complete
