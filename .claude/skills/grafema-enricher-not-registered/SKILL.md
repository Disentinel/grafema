---
name: grafema-enricher-not-registered
description: |
  Debug Grafema enrichment plugins that produce near-zero results despite being correctly
  implemented. Use when: (1) a plugin's edge/node count is suspiciously low (0 or 1) in
  production despite code looking correct, (2) unit tests for the plugin pass but production
  graph doesn't have expected edges, (3) a recently discovered plugin that "should be running"
  but its effects aren't visible in the graph, (4) HANDLED_BY, CALLS, or similar edges are
  missing after analysis despite resolver code existing. Root cause: plugin implemented in
  packages/core but not registered in builtinPlugins.ts (production) and/or
  createTestOrchestrator.js (integration tests).
author: Claude Code
version: 1.0.0
date: 2026-02-21
---

# Grafema Enricher Plugin Not Registered

## Problem

A Grafema enrichment plugin is implemented, exported, and has passing unit tests — but
produces near-zero results in production analysis. For example: `ExternalCallResolver`
was fully implemented to create `HANDLED_BY` edges, but only 1 such edge existed in the
entire Grafema codebase after analysis (from a different code path).

## Context / Trigger Conditions

- Plugin's edge count is 0 or suspiciously low after `grafema analyze`
- Unit tests for the plugin pass (plugin is instantiated and run directly in tests)
- `grafema analyze --verbose` output does not show the plugin running
- You find a plugin file in `packages/core/src/plugins/enrichment/` that is not in `builtinPlugins.ts`
- Integration tests don't cover the plugin's behavior (no snapshots reflect its edges)

## Root Cause

Grafema has **two separate plugin registries** that must both be updated:

1. **`packages/cli/src/plugins/builtinPlugins.ts`** — Production pipeline registry.
   If a plugin is missing here, it NEVER runs in `grafema analyze`. The plugin may be
   exported from `packages/core/src/index.ts` but that doesn't make it run automatically.

2. **`test/helpers/createTestOrchestrator.js`** — Integration test helper registry.
   If missing here, integration tests and snapshot tests won't cover the plugin's behavior.

Unit tests typically instantiate the plugin directly (`new MyResolver()`) and bypass
both registries — so unit tests pass even when the plugin is never registered.

## Diagnosis

```bash
# Check if plugin is in production registry
grep -n "ExternalCallResolver\|FunctionCallResolver\|MyPlugin" \
  packages/cli/src/plugins/builtinPlugins.ts

# Check if plugin is in test orchestrator
grep -n "ExternalCallResolver\|FunctionCallResolver\|MyPlugin" \
  test/helpers/createTestOrchestrator.js

# Check if it's exported from core index
grep -n "ExternalCallResolver\|MyPlugin" packages/core/src/index.ts
```

A plugin that appears in `packages/core/src/index.ts` but NOT in `builtinPlugins.ts`
is a confirmed "implemented but never runs" situation.

## Solution

### Step 1: Add to `builtinPlugins.ts`

```typescript
// packages/cli/src/plugins/builtinPlugins.ts

// Add to imports from '@grafema/core':
import {
  // ... existing imports ...
  ExternalCallResolver,  // ADD THIS
} from '@grafema/core';

// Add to BUILTIN_PLUGINS registry (respect dependency order):
const BUILTIN_PLUGINS = {
  // ... existing entries ...
  FunctionCallResolver: () => new FunctionCallResolver() as Plugin,
  ExternalCallResolver: () => new ExternalCallResolver() as Plugin,  // AFTER its dependencies
};
```

The plugin system respects `metadata.dependencies` for execution ordering, but the
plugin must be in the registry to be instantiated at all.

### Step 2: Add to `createTestOrchestrator.js`

```javascript
// test/helpers/createTestOrchestrator.js

import { FunctionCallResolver } from '@grafema/core';
import { ExternalCallResolver } from '@grafema/core';

// Inside the enrichment block (if (!options.skipEnrichment)):
plugins.push(new FunctionCallResolver());
plugins.push(new ExternalCallResolver());  // After dependencies
```

**Order matters**: If Plugin B declares `dependencies: ['PluginA']`, push A before B.

### Step 3: Build and run full test suite

```bash
pnpm build
node --test --test-concurrency=1 'test/unit/*.test.js'
```

Integration test snapshots will update to reflect the new edges — verify the new
edges look correct before committing.

## Verification

After registration:
```
# grafema analyze --verbose should now show the plugin running:
[INFO] ExternalCallResolver: Complete { edgesCreated: 847, handledByEdgesCreated: 312 }

# Before (plugin not registered):
# ExternalCallResolver: (no output — never ran)
```

## Example: REG-545

`ExternalCallResolver` creates `HANDLED_BY` (CALL → IMPORT) edges for external imports.
It was correctly implemented and exported, but missing from `builtinPlugins.ts`.

Result before fix:
- `HANDLED_BY` edges: **1** (from Express route analysis, not import resolution)

Result after adding to `builtinPlugins.ts` + `createTestOrchestrator.js`:
- `HANDLED_BY` edges: hundreds, correctly linking call sites to their import declarations

## Notes

- **Always check both registries** when a plugin produces suspiciously low output
- Plugin order in `createTestOrchestrator.js` matters for plugins with dependencies
- After adding to `createTestOrchestrator.js`, update snapshot files to reflect new edges
- A plugin being exported from `packages/core/src/index.ts` does NOT mean it runs — exports
  only make the plugin available for import, not registered in any pipeline
- The `metadata.dependencies` declaration is used for ordering but only among registered plugins;
  unregistered plugins are simply never instantiated
