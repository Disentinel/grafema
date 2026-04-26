# Joel Spolsky's Technical Plan: REG-145 - Pass Logger through PluginContext

## Overview

This document provides the detailed implementation specification for Phase 1 of REG-145. The goal is to establish the Logger infrastructure in the type system and wire it through the Orchestrator and CLI.

## Implementation Order

The changes must be implemented in this order due to dependencies:

1. **packages/types/src/plugins.ts** - Add Logger interface and LogLevel type (no dependencies)
2. **packages/core/src/Orchestrator.ts** - Accept logger, propagate to plugins, migrate console.log calls
3. **packages/cli/src/commands/analyze.ts** - Create logger from CLI flags, pass to Orchestrator
4. **packages/core/src/plugins/Plugin.ts** - Add helper method for logging with fallback

## Step 1: Update @grafema/types

**File:** `/Users/vadimr/grafema/packages/types/src/plugins.ts`

### 1.1 Add LogLevel type (after line 7, before PLUGIN_PHASES)

```typescript
// === LOG LEVEL ===
/**
 * Log level for controlling verbosity.
 * Levels are ordered by verbosity: silent < errors < warnings < info < debug
 */
export type LogLevel = 'silent' | 'errors' | 'warnings' | 'info' | 'debug';
```

### 1.2 Add Logger interface (after LogLevel, before PLUGIN_PHASES)

```typescript
// === LOGGER INTERFACE ===
/**
 * Logger interface for structured logging.
 * Plugins should use context.logger instead of console.log for controllable output.
 */
export interface Logger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  trace(message: string, context?: Record<string, unknown>): void;
}
```

### 1.3 Update PluginContext interface (line 34-49)

Add `logger?: Logger` field after `touchedFiles`:

```typescript
export interface PluginContext {
  manifest?: unknown;
  graph: GraphBackend;
  config?: OrchestratorConfig;
  phase?: PluginPhase;
  projectPath?: string;
  onProgress?: (info: Record<string, unknown>) => void;
  forceAnalysis?: boolean;
  workerCount?: number;
  /**
   * Set of file paths already processed ("touched") in this analysis run.
   * Used for idempotent re-analysis: first touch clears all nodes for that file,
   * subsequent touches are no-ops. Only populated when forceAnalysis=true.
   */
  touchedFiles?: Set<string>;
  /**
   * Logger instance for structured logging.
   * Use this instead of console.log for controllable verbosity via CLI flags.
   * May be undefined for backward compatibility - use optional chaining: context.logger?.info()
   */
  logger?: Logger;
}
```

### 1.4 Update OrchestratorConfig interface (lines 86-93)

Add `logLevel?: LogLevel` field:

```typescript
export interface OrchestratorConfig {
  projectPath: string;
  plugins?: string[];
  phases?: PluginPhase[];
  parallel?: boolean;
  maxWorkers?: number;
  verbose?: boolean;
  /**
   * Log level for controlling verbosity.
   * Defaults to 'info'. Use 'silent' to suppress all output, 'debug' for verbose.
   */
  logLevel?: LogLevel;
}
```

---

## Step 2: Update Orchestrator

**File:** `/Users/vadimr/grafema/packages/core/src/Orchestrator.ts`

### 2.1 Add import for Logger (after line 16)

```typescript
import type { GraphBackend, PluginPhase, Logger, LogLevel } from '@grafema/types';
import { ConsoleLogger, createLogger } from './logging/Logger.js';
```

### 2.2 Update OrchestratorOptions interface (lines 47-56)

Add `logger?: Logger` and `logLevel?: LogLevel` fields:

```typescript
export interface OrchestratorOptions {
  graph?: GraphBackend;
  plugins?: Plugin[];
  workerCount?: number;
  onProgress?: ProgressCallback;
  forceAnalysis?: boolean;
  serviceFilter?: string | null;
  indexOnly?: boolean;
  parallel?: ParallelConfig | null;
  /**
   * Logger instance for structured logging.
   * If not provided, a default ConsoleLogger will be created based on logLevel.
   */
  logger?: Logger;
  /**
   * Log level for the default logger. Ignored if logger is provided.
   * Defaults to 'info'.
   */
  logLevel?: LogLevel;
}
```

### 2.3 Add logger property to class (after line 135)

```typescript
private logger: Logger;
```

### 2.4 Initialize logger in constructor (after line 155, before auto-add default discovery)

```typescript
// Initialize logger (use provided or create default)
this.logger = options.logger ?? createLogger(options.logLevel ?? 'info');
```

### 2.5 Update runPhase() to pass logger to PluginContext (lines 512-516)

Change from:

```typescript
const pluginContext: PluginContext = {
  ...context,
  onProgress: this.onProgress as unknown as PluginContext['onProgress'],
  forceAnalysis: this.forceAnalysis
};
```

To:

```typescript
const pluginContext: PluginContext = {
  ...context,
  onProgress: this.onProgress as unknown as PluginContext['onProgress'],
  forceAnalysis: this.forceAnalysis,
  logger: this.logger,
};
```

### 2.6 Migrate all console.log calls to this.logger

This is the bulk of the work. Here is the mapping for all 30 console.log calls:

| Line | Current Code | New Code |
|------|--------------|----------|
| 175 | `console.log('[Orchestrator] Clearing entire graph...')` | `this.logger.info('Clearing entire graph (forceAnalysis=true)')` |
| 177 | `console.log('[Orchestrator] Graph cleared successfully')` | `this.logger.info('Graph cleared successfully')` |
| 196 | `console.log(\`[Orchestrator] Discovery: ${svcCount} services...\`)` | `this.logger.info('Discovery complete', { services: svcCount, entrypoints: epCount })` |
| 210 | `console.log(\`[Orchestrator] Filtering: ${this.serviceFilter}...\`)` | `this.logger.info('Filtering services', { filter: this.serviceFilter, found: unitsToProcess.length, total: indexingUnits.length })` |
| 215-216 | `console.log(\`[Orchestrator] Processing ${unitsToProcess.length}...\`)` | `this.logger.info('Processing indexing units', { count: unitsToProcess.length, strategy: 'Phase-by-phase with DFS' })` |
| 265 | `console.log(\`[Orchestrator] INDEXING ${unit.name}: ${unitTime}s\`)` | `this.logger.debug('INDEXING complete', { unit: unit.name, duration: unitTime })` |
| 280 | `console.log(\`[Orchestrator] INDEXING phase total...\`)` | `this.logger.info('INDEXING phase complete', { duration: ((Date.now() - indexingStart) / 1000).toFixed(2) })` |
| 285-286 | `console.log(\`[Orchestrator] indexOnly mode...\`)` | `this.logger.info('indexOnly mode - skipping remaining phases', { duration: totalTime, units: unitsToProcess.length })` |
| 339 | `console.log(\`[Orchestrator] ANALYSIS ${unit.name}...\`)` | `this.logger.debug('ANALYSIS complete', { unit: unit.name, duration: unitTime })` |
| 356 | `console.log(\`[Orchestrator] ANALYSIS phase total...\`)` | `this.logger.info('ANALYSIS phase complete', { duration: ((Date.now() - analysisStart) / 1000).toFixed(2) })` |
| 364 | `console.log(\`[Orchestrator] ENRICHMENT phase...\`)` | `this.logger.info('ENRICHMENT phase complete', { duration: ((Date.now() - enrichmentStart) / 1000).toFixed(2) })` |
| 372 | `console.log(\`[Orchestrator] VALIDATION phase...\`)` | `this.logger.info('VALIDATION phase complete', { duration: ((Date.now() - validationStart) / 1000).toFixed(2) })` |
| 380 | `console.log(\`[Orchestrator] Total time...\`)` | `this.logger.info('Analysis complete', { duration: totalTime, units: unitsToProcess.length })` |
| 428 | `console.log(\`[Orchestrator] Built ${units.length}...\`)` | `this.logger.debug('Built indexing units', { total: units.length, services: units.filter(u => u.type === 'service').length, entrypoints: units.filter(u => u.type === 'entrypoint').length })` |
| 530 | `console.warn(\`[Orchestrator] Plugin ${plugin.metadata.name} reported failure\`)` | `this.logger.warn('Plugin reported failure', { plugin: plugin.metadata.name, errors: result.errors.length, warnings: result.warnings.length })` |
| 590-591 | `console.log(\`[Orchestrator] Starting queue-based...\`)` | `this.logger.info('Starting queue-based parallel analysis', { database: mainDbPath })` |
| 601 | `console.log(\`[Orchestrator] Analysis plugins...\`)` | `this.logger.debug('Analysis plugins configured', { plugins: analysisPlugins })` |
| 628 | `console.log(\`[Orchestrator] Queued ${moduleCount}...\`)` | `this.logger.info('Queued modules for analysis', { count: moduleCount })` |
| 640 | `console.error(\`[Orchestrator] Analysis failed...\`)` | `this.logger.error('Analysis failed', { file, error })` |
| 646-647 | `console.log(\`[Orchestrator] Queue complete...\`)` | `this.logger.info('Queue complete', { nodes: stats.nodesCreated, edges: stats.edgesCreated, succeeded: stats.tasksCompleted, failed: stats.tasksFailed })` |
| 670 | `console.log(\`[Orchestrator] Using existing RFDB...\`)` | `this.logger.info('Using existing RFDB server', { socketPath })` |
| 676 | `console.log(\`[Orchestrator] Stale socket...\`)` | `this.logger.debug('Stale socket found, removing')` |
| 689 | `console.log(\`[Orchestrator] RFDB server binary...\`)` | `this.logger.info('RFDB server binary not found, building')` |
| 697 | `console.log(\`[Orchestrator] Starting RFDB server...\`)` | `this.logger.info('Starting RFDB server', { binary: binaryPath, database: dbPath })` |
| 706 | `console.log(\`[rfdb-server] ${msg}\`)` | `this.logger.debug('rfdb-server output', { message: msg })` |
| 721 | `console.log(\`[Orchestrator] RFDB server started...\`)` | `this.logger.info('RFDB server started', { socketPath })` |
| 730 | `console.log(\`[Orchestrator] Leaving external...\`)` | `this.logger.debug('Leaving external RFDB server running')` |
| 738 | `console.log(\`[Orchestrator] RFDB server stopped\`)` | `this.logger.info('RFDB server stopped')` |

---

## Step 3: Update CLI

**File:** `/Users/vadimr/grafema/packages/cli/src/commands/analyze.ts`

### 3.1 Add import for createLogger (after line 44)

```typescript
import { createLogger } from '@grafema/core';
import type { LogLevel } from '@grafema/types';
```

### 3.2 Add helper function to determine log level from CLI flags (after line 130, before analyzeCommand)

```typescript
/**
 * Determine log level from CLI options.
 * Priority: --log-level > --quiet > --verbose > default ('info')
 */
function getLogLevel(options: { quiet?: boolean; verbose?: boolean; logLevel?: string }): LogLevel {
  // Explicit --log-level takes precedence
  if (options.logLevel) {
    const validLevels: LogLevel[] = ['silent', 'errors', 'warnings', 'info', 'debug'];
    if (validLevels.includes(options.logLevel as LogLevel)) {
      return options.logLevel as LogLevel;
    }
  }

  // --quiet means silent
  if (options.quiet) {
    return 'silent';
  }

  // --verbose means debug
  if (options.verbose) {
    return 'debug';
  }

  // Default
  return 'info';
}
```

### 3.3 Update action handler to create and pass logger (lines 161-199)

After line 170 (after `const log = ...`), add:

```typescript
// Create logger based on CLI flags
const logLevel = getLogLevel(options);
const logger = createLogger(logLevel);
```

Update Orchestrator instantiation (lines 189-199):

```typescript
const orchestrator = new Orchestrator({
  graph: backend as unknown as import('@grafema/types').GraphBackend,
  plugins,
  serviceFilter: options.service || null,
  forceAnalysis: options.clear || false,
  logger,  // Pass the logger
  onProgress: (progress) => {
    if (options.verbose) {
      log(`[${progress.phase}] ${progress.message}`);
    }
  },
});
```

---

## Step 4: Update Plugin Base Class

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/Plugin.ts`

### 4.1 Add import for Logger (after line 17)

```typescript
import type { Logger } from '@grafema/types';
```

### 4.2 Add logging helper method (after line 73, before closing brace)

```typescript
/**
 * Get a logger from context with console fallback for backward compatibility.
 *
 * Usage in plugin:
 *   const logger = this.log(context);
 *   logger.info('Processing started', { files: 10 });
 *
 * @param context - Plugin context (may or may not have logger)
 * @returns Logger instance (context.logger or console fallback)
 */
protected log(context: PluginContext): Logger {
  if (context.logger) {
    return context.logger;
  }

  // Fallback to console for backward compatibility
  return {
    error: (msg: string, ctx?: Record<string, unknown>) =>
      console.error(`[ERROR] ${msg}`, ctx ? JSON.stringify(ctx) : ''),
    warn: (msg: string, ctx?: Record<string, unknown>) =>
      console.warn(`[WARN] ${msg}`, ctx ? JSON.stringify(ctx) : ''),
    info: (msg: string, ctx?: Record<string, unknown>) =>
      console.log(`[INFO] ${msg}`, ctx ? JSON.stringify(ctx) : ''),
    debug: (msg: string, ctx?: Record<string, unknown>) =>
      console.debug(`[DEBUG] ${msg}`, ctx ? JSON.stringify(ctx) : ''),
    trace: (msg: string, ctx?: Record<string, unknown>) =>
      console.debug(`[TRACE] ${msg}`, ctx ? JSON.stringify(ctx) : ''),
  };
}
```

---

## Edge Cases and Considerations

### 1. Worker Threads (Parallel Analysis)
Workers in `AnalysisQueue` run in separate processes. Logger cannot be serialized. Workers should either:
- Create their own silent logger
- Remain unchanged (parallel analysis is under a flag and can be updated in Phase 2)

**Decision:** Leave parallel analysis unchanged for Phase 1. Workers continue using console.log.

### 2. Discovery Phase Special Case
In `discover()` method (lines 435-487), plugins receive context without going through `runPhase()`. Need to ensure logger is passed:

```typescript
// Line 436-441
const context = {
  projectPath,
  graph: this.graph,
  config: this.config,
  phase: 'DISCOVERY',
  logger: this.logger,  // ADD THIS
};
```

### 3. Backward Compatibility
- Plugins that don't use logger continue to work (they just use console.log directly)
- The `log()` helper in Plugin base class provides console fallback
- No breaking changes to plugin API

### 4. Progress Callback vs Logger
- `onProgress` is for UI (spinner, progress bar) - user-facing
- `logger` is for diagnostics (debug, errors) - developer-facing
- Both are kept - different purposes

---

## Test Requirements

### New Tests to Add

**File:** `/Users/vadimr/grafema/test/unit/logging/LoggerIntegration.test.ts`

Tests for:
1. Logger is passed through context to plugins
2. Default logger created when not provided
3. logLevel option respected
4. CLI flag mapping (--quiet → silent, --verbose → debug, --log-level precedence)

### Existing Tests to Verify Still Pass

Run after implementation:

```bash
node --test test/unit/logging/Logger.test.ts
npm test
```

---

## Summary of Changes

| File | Lines Changed | Type |
|------|---------------|------|
| `packages/types/src/plugins.ts` | ~25 new lines | Add LogLevel, Logger, update interfaces |
| `packages/core/src/Orchestrator.ts` | ~35 modified lines | Add logger prop, init, propagate, migrate console.log |
| `packages/cli/src/commands/analyze.ts` | ~20 new lines | Add getLogLevel helper, create and pass logger |
| `packages/core/src/plugins/Plugin.ts` | ~25 new lines | Add log() helper method |
| `test/unit/logging/LoggerIntegration.test.ts` | ~100 new lines | New integration tests |

**Total:** ~205 lines changed/added
