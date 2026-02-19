# REG-446: Deduplicate analysis-worker.ts builtinPlugins registry

## Source
Linear issue REG-446

## Request
`packages/mcp/src/analysis-worker.ts` maintains its own copy of the plugin registry (`builtinPlugins` map, lines 163-191), separate from `packages/mcp/src/config.ts:BUILTIN_PLUGINS` and `packages/cli/src/plugins/builtinPlugins.ts`.

**Problem:** DRY violation. The worker's registry is already out of sync — it's missing ~11 plugins that the other registries have.

**Solution:** Import `BUILTIN_PLUGINS` from `config.ts` instead of maintaining a separate copy. The worker already imports from `@grafema/core` — it can import the registry from the sibling config module.

## Acceptance Criteria
- Worker uses shared `BUILTIN_PLUGINS` from config.ts instead of its own copy
- No duplicate registry in analysis-worker.ts
- All tests pass
- Build succeeds
