# Don Melton's Analysis: REG-145 - Pass Logger through PluginContext

## Executive Summary

The proposed implementation is **directionally correct** but requires refinement. The Logger infrastructure from REG-78 is well-designed and ready for integration. However, the scope is larger than the issue suggests - the Orchestrator itself has 30 `console.log()` calls that also need migration, not just plugins.

## Current State Analysis

### 1. Logger Infrastructure (REG-78) - COMPLETE

Location: `/Users/vadimr/grafema/packages/core/src/logging/Logger.ts`

- `Logger` interface with 5 methods: `error`, `warn`, `info`, `debug`, `trace`
- `ConsoleLogger` implementation respects log level thresholds
- `LogLevel` type: `'silent' | 'errors' | 'warnings' | 'info' | 'debug'`
- `createLogger(level)` factory function
- Already exported from `@grafema/core`
- Tests exist and already anticipate PluginContext integration (lines 607-651)

### 2. PluginContext Interface

Location: `/Users/vadimr/grafema/packages/types/src/plugins.ts` (lines 31-49)

Current fields:
- `manifest?: unknown`
- `graph: GraphBackend`
- `config?: OrchestratorConfig`
- `phase?: PluginPhase`
- `projectPath?: string`
- `onProgress?: (info: Record<string, unknown>) => void`
- `forceAnalysis?: boolean`
- `workerCount?: number`
- `touchedFiles?: Set<string>`

**Missing:** `logger?: Logger`

### 3. Console.log Usage - EXTENSIVE

| Component | `console.log` Count | Notes |
|-----------|---------------------|-------|
| Orchestrator | 30 | Timing, phase progress, server status |
| 35 plugins | ~50+ | Processing status, debug info |
| Other core files | ~130 | Various subsystems |
| **Total** | **258** | Across 48 files |

### 4. CLI --quiet Flag - NOT CONNECTED

Location: `/Users/vadimr/grafema/packages/cli/src/commands/analyze.ts`

The CLI has:
- `--quiet` flag (line 157)
- `--verbose` flag (line 158)
- `--log-level <level>` option (line 160) - **DECLARED BUT UNUSED!**

Current implementation creates a local `log` function but doesn't pass it to Orchestrator. Plugins bypass this entirely with direct `console.log()` calls.

## Architectural Decision: Logger as Required vs Optional

**Option A: Optional Logger (`logger?: Logger`)**
- Backward compatible
- Plugins can check `context.logger?.info()`
- Risk: plugins may still use `console.log` if they forget

**Option B: Required Logger (`logger: Logger`)**
- Forces migration of all plugins
- Cleaner API - no optional chaining
- Breaking change for any external plugins

**Recommendation: Option A (Optional) for Phase 1**

Reasoning:
1. Allows incremental migration
2. Default fallback can be `console.log` for backward compatibility
3. Can make required in future major version

## Refined Implementation Plan

### Phase 1: Infrastructure (types + core)

1. **Add Logger interface to `@grafema/types`** (not just PluginContext)

   Location: `/Users/vadimr/grafema/packages/types/src/plugins.ts`

   - Export `Logger` interface (copy from core, or create minimal interface)
   - Add `logger?: Logger` to `PluginContext`
   - Add `logLevel?: LogLevel` to `OrchestratorConfig`

2. **Update Orchestrator to accept and propagate Logger**

   Location: `/Users/vadimr/grafema/packages/core/src/Orchestrator.ts`

   - Add `logger?: Logger` to `OrchestratorOptions`
   - Create default logger in constructor based on config
   - Pass logger to `PluginContext` in `runPhase()`
   - Migrate Orchestrator's own `console.log()` calls to `this.logger.info()`

3. **Update CLI to create and pass Logger**

   Location: `/Users/vadimr/grafema/packages/cli/src/commands/analyze.ts`

   - Map CLI flags to LogLevel:
     - `--quiet` → `'silent'`
     - `--verbose` → `'debug'`
     - `--log-level <level>` → use as-is
     - default → `'info'`
   - Create logger: `const logger = createLogger(logLevel)`
   - Pass to Orchestrator: `new Orchestrator({ ..., logger })`

### Phase 2: Plugin Migration (can be separate PR)

4. **Create migration helper for plugins**

   Helper pattern in Plugin base class:
   ```typescript
   protected log(context: PluginContext): Logger {
     return context.logger ?? {
       error: console.error.bind(console),
       warn: console.warn.bind(console),
       info: console.log.bind(console),
       debug: console.debug.bind(console),
       trace: console.debug.bind(console),
     };
   }
   ```

5. **Migrate plugins incrementally**

   Priority order (by `console.log` count):
   1. JSModuleIndexer (11 calls) - highest impact
   2. IncrementalAnalysisPlugin (15 calls)
   3. JSASTAnalyzer (7 calls)
   4. Validators (many files, few calls each)
   5. Enrichment plugins
   6. Discovery plugins

## Type Location Decision

**Question:** Should `Logger` interface live in `@grafema/types` or stay in `@grafema/core`?

**Current state:** Logger is in `@grafema/core`

**Problem:** `@grafema/types` cannot import from `@grafema/core` (types should be dependency-free)

**Solution:** Create minimal `Logger` interface in `@grafema/types`:

```typescript
// packages/types/src/plugins.ts
export interface Logger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  trace(message: string, context?: Record<string, unknown>): void;
}
```

`@grafema/core`'s `ConsoleLogger` implements this interface (structural typing).

## Edge Cases & Considerations

1. **Worker threads (parallel analysis):**
   - Workers run in separate processes
   - Logger cannot be serialized/passed to workers
   - Workers should create their own logger or use silent logger
   - Current `AnalysisQueue` already handles this separately

2. **MCP server logging:**
   - `/Users/vadimr/grafema/packages/mcp/src/state.ts` has its own logger
   - Should align with same interface for consistency

3. **Progress callback vs Logger:**
   - `onProgress` callback is for UI updates (spinner, progress bar)
   - Logger is for debugging/diagnostic output
   - Keep both - different purposes

4. **Log prefix convention:**
   - Current: `[Orchestrator]`, `[JSModuleIndexer]`, etc.
   - Should continue this pattern in logger calls
   - Consider: `logger.info('Phase complete', { plugin: this.metadata.name })`

## What the Proposed Implementation Gets Right

1. Adding `logger: Logger` to PluginContext - correct location
2. Creating logger in Orchestrator - correct ownership
3. Passing logger in runPhase() - correct propagation point
4. Updating plugins to use context.logger - correct usage pattern

## What the Proposed Implementation Misses

1. **Logger interface location:** Should be in `@grafema/types`, not imported from core
2. **OrchestratorConfig update:** Need `logLevel` field
3. **CLI integration:** Need to wire --quiet/--verbose/--log-level to logger creation
4. **Orchestrator's own logging:** 30 console.log calls need migration too
5. **Default logger:** Need fallback for backward compatibility
6. **Worker thread handling:** Parallel analysis has special requirements

## Files Requiring Changes

| File | Change Type | Priority |
|------|-------------|----------|
| `packages/types/src/plugins.ts` | Add Logger interface + update PluginContext | 1 |
| `packages/core/src/Orchestrator.ts` | Accept logger, propagate, migrate own logs | 1 |
| `packages/cli/src/commands/analyze.ts` | Create logger from flags, pass to Orchestrator | 1 |
| `packages/core/src/plugins/Plugin.ts` | Add helper method for logging | 2 |
| 35 plugin files | Migrate console.log to context.logger | 3 |

## Testing Strategy

1. **Unit tests for Logger integration:**
   - Verify logger is passed through context
   - Verify log level is respected
   - Verify silent mode suppresses all output

2. **Integration test:**
   - Run `grafema analyze --quiet` on test project
   - Verify no output to stdout
   - Run with `--verbose`
   - Verify detailed output

3. **Backward compatibility:**
   - Ensure existing plugins work without logger
   - Verify default fallback behavior

## Conclusion

The proposed implementation is **RIGHT in direction** but **incomplete in scope**. The real work is:

1. **Small:** Add logger to types and wire through Orchestrator (1-2 hours)
2. **Medium:** Migrate Orchestrator's 30 console.log calls (2-3 hours)
3. **Large:** Migrate 35 plugins with 50+ console.log calls (separate task/PR)

**Recommendation:** Split into two tasks:
- REG-145: Infrastructure (types, Orchestrator, CLI wiring) - this PR
- REG-XXX: Plugin migration - follow-up PR

This allows shipping the infrastructure quickly while giving time for thorough plugin migration.

## Critical Files for Implementation

1. `/Users/vadimr/grafema/packages/types/src/plugins.ts` - Add Logger interface and update PluginContext
2. `/Users/vadimr/grafema/packages/core/src/Orchestrator.ts` - Accept logger option, propagate to plugins, migrate own console.log calls
3. `/Users/vadimr/grafema/packages/cli/src/commands/analyze.ts` - Create logger from CLI flags and pass to Orchestrator
4. `/Users/vadimr/grafema/packages/core/src/plugins/Plugin.ts` - Add helper method for logging with fallback
5. `/Users/vadimr/grafema/packages/core/src/logging/Logger.ts` - Reference implementation (no changes needed, already correct)
