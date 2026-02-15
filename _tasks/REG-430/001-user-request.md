## REG-430: Clean up dead HTTPConnectionEnricher import in analysis-worker.ts

`packages/mcp/src/analysis-worker.ts` imports and registers `HTTPConnectionEnricher` in its `builtinPlugins` map, but since REG-256 it's no longer in `DEFAULT_CONFIG`. The import is dead code unless a user explicitly references it in their config.

Options:

1. Remove the import entirely (breaking for users with custom configs referencing it)
2. Keep it but add a deprecation warning when instantiated
3. Leave as-is (current state, harmless)

**File:** `packages/mcp/src/analysis-worker.ts`, line 35
