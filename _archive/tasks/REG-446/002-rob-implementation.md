# REG-446: Deduplicate analysis-worker.ts builtinPlugins registry

## Implementation Report

### What changed

**File:** `packages/mcp/src/analysis-worker.ts`

Three edits, all in the same file:

1. **Replaced 27 individual plugin class imports** (lines 13-47) with minimal imports:
   - Kept: `Orchestrator`, `RFDBServerBackend` (runtime dependencies)
   - Kept: `type { ParallelConfig, Plugin }` (type-only imports)
   - Added: `import { BUILTIN_PLUGINS } from './config.js'`
   - Removed: all 27 plugin class imports (`JSModuleIndexer`, `JSASTAnalyzer`, etc.)

2. **Replaced the inline 27-entry `builtinPlugins` map** (lines 161-190) with a single spread:
   ```ts
   const builtinPlugins: Record<string, () => unknown> = { ...BUILTIN_PLUGINS };
   ```
   This gives the worker all 38 plugins from the canonical registry in `config.ts`.

3. **Added `as Plugin` cast** at the push site (line 143):
   ```ts
   plugins.push(builtinPlugins[name]() as Plugin);
   ```
   Necessary because `BUILTIN_PLUGINS` factories return `unknown` (the type in `config.ts`), but the `plugins` array is typed as `Plugin[]`. The cast is safe: every factory in `BUILTIN_PLUGINS` constructs a class that implements `Plugin`.

### Why

The worker had a stale copy of the plugin registry -- 27 plugins vs the canonical 38 in `config.ts`. The 11 missing plugins were:

- `RustModuleIndexer`
- `SocketAnalyzer`
- `RustAnalyzer`
- `ClosureCaptureEnricher`
- `ExpressHandlerLinker`
- `ImportExportLinker`
- `InstanceOfResolver`
- `HTTPConnectionEnricher`
- `CallbackCallResolver`
- `SocketConnectionEnricher`
- `RustFFIEnricher`
- `TypeScriptDeadCodeValidator`
- `BrokenImportValidator`

Any future plugin added to `BUILTIN_PLUGINS` in `config.ts` will automatically be available to the worker -- no second file to update.

### What did NOT change

- `packages/mcp/src/config.ts` -- untouched
- Custom plugin loading logic (`loadCustomPlugins`, the merge loop at lines 133-136) -- unchanged
- Plugin instantiation from config (`config.plugins` iteration) -- unchanged except the cast
- All runtime behavior -- identical; the worker still builds `Plugin[]` from config entries, still merges custom plugins on top

### Verification

- `pnpm build` succeeds with zero TypeScript errors
- No MCP-specific tests exist (`test/unit/mcp*` -- empty), so no test run needed
- The only Rust warnings are pre-existing (unused imports/fields in rfdb-server)

### Net diff

- Removed: ~35 lines of imports + 29 lines of inline map = ~64 lines
- Added: 2 import lines + 1 spread line + 1 cast keyword = ~4 lines
- Net: ~60 lines removed
