# REG-431: MCP config.ts missing several enrichment plugins from DEFAULT_CONFIG

## Issue

Pre-existing gap (not caused by REG-256): `packages/mcp/src/config.ts` BUILTIN_PLUGINS map is missing several enrichment plugins that are in `DEFAULT_CONFIG`:

* ClosureCaptureEnricher
* ExpressHandlerLinker
* ImportExportLinker
* CallbackCallResolver

This means MCP analysis may not include these enrichments when using the default config.

**File:** `packages/mcp/src/config.ts`

## Priority

Medium

## Labels

v0.2, Bug
