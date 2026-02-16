# REG-482: Add plugin applicability filter (skip irrelevant plugins)

## Problem

All 16 ANALYSIS plugins execute for every service/module, even if not applicable:
- ExpressAnalyzer runs on projects without Express
- RustAnalyzer runs on pure JS projects
- DatabaseAnalyzer runs on projects without DB queries
- etc.

745 services × 16 plugins = 11,920 plugin executions, ~50-80% are no-ops.

## Fix

Add `isApplicable()` check to plugin interface:

```typescript
// ExpressAnalyzer: skip if no express dependency
if (!manifest.hasDependency('express')) return skip();

// RustAnalyzer: skip if no .rs files
if (!manifest.hasFileType('.rs')) return skip();
```

## Impact

Moderate — reduces constant factor but doesn't fix algorithmic complexity.
Most valuable AFTER Fix A (when running globally, this saves startup/teardown overhead).

This is a constant-factor optimization. Fix A and Fix D are the algorithmic wins. This is polish.
