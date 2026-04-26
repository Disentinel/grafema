# Don's Plan: Refactor analyze.ts (REG-435)

**Status:** Pure refactoring — zero behavioral changes
**Goal:** Extract BUILTIN_PLUGINS registry and command action function to reduce analyze.ts from 517 lines to <200 lines

---

## Current File Structure (analyze.ts — 517 lines)

### Lines 1-67: Imports
- commander, node built-ins (path, fs, url, node:module)
- ~40 plugin classes from @grafema/core
- Types from @grafema/types
- Local utility: ProgressRenderer

### Lines 68-84: Utility types and functions
- `NodeEdgeCountBackend` interface (lines 71-74)
- `fetchNodeEdgeCounts()` helper (lines 76-79)
- `exitWithCode()` helper (lines 81-83)

### Lines 85-132: BUILTIN_PLUGINS registry
- **48 lines** — maps plugin names to factory functions
- Covers all 30 built-in plugins (Discovery, Indexing, Analysis, Enrichment, Validation)
- Used by `createPlugins()` at line 229

### Lines 134-164: Plugin resolver registration
- `registerPluginResolver()` function (lines 147-164)
- Module-level flag `pluginResolverRegistered` (line 145)
- Called from `loadCustomPlugins()` at line 179

### Lines 166-215: Custom plugin loader
- `loadCustomPlugins()` async function
- Reads `.grafema/plugins/` directory
- Returns `Record<string, () => Plugin>` (same type as BUILTIN_PLUGINS)

### Lines 217-240: Plugin factory
- `createPlugins()` function
- Merges built-in and custom plugins based on config
- Iterates through phases: discovery, indexing, analysis, enrichment, validation

### Lines 242-259: Log level resolver
- `getLogLevel()` helper
- Determines log level from CLI options

### Lines 261-516: Command definition and action
- **256 lines total**
- Lines 261-287: Command setup (name, description, options, help text)
- Lines 288-516: Action function (**228 lines**)
  - Lines 289-310: Setup (paths, loggers, info/debug helpers)
  - Lines 312-339: Backend connection
  - Lines 341-367: Config loading, strict mode resolution
  - Lines 369-393: Progress renderer setup
  - Lines 395-407: Orchestrator creation
  - Lines 409-515: Execution with try/catch/finally
    - Success path: lines 411-457
    - Error path: lines 458-500
    - Finally block: lines 501-515

---

## Extraction Plan

### 1. Extract BUILTIN_PLUGINS Registry

**New file:** `packages/cli/src/plugins/builtinPlugins.ts`

**What moves:**
- Lines 85-132: BUILTIN_PLUGINS constant
- Import all 30 plugin classes from @grafema/core
- Import Plugin type from @grafema/core

**Exports:**
```typescript
export const BUILTIN_PLUGINS: Record<string, () => Plugin> = { ... };
```

**What stays in analyze.ts:**
- Nothing — this is a complete extraction

**Dependencies:**
- Imports: `type Plugin` from '@grafema/core' + all 30 plugin classes
- No dependencies on other analyze.ts code

**Usage sites:**
- `createPlugins()` at line 229 (will import from new file)
- No other files import BUILTIN_PLUGINS (grep confirmed)

---

### 2. Extract Command Action Function

**New file:** `packages/cli/src/commands/analyzeAction.ts`

**What moves:**
- Lines 288-516: Entire action function (228 lines)
- Lines 76-79: `fetchNodeEdgeCounts()` helper (used by action at line 386, 416)
- Lines 71-74: `NodeEdgeCountBackend` interface (used by helper)
- Lines 81-83: `exitWithCode()` helper (used by action at line 514)
- Lines 249-259: `getLogLevel()` helper (used by action at line 304)
- Lines 169-215: `loadCustomPlugins()` function (used by action at line 358)
- Lines 147-164: `registerPluginResolver()` function (called from loadCustomPlugins at line 179)
- Lines 145: `pluginResolverRegistered` flag (used by registerPluginResolver)
- Lines 217-240: `createPlugins()` function (used by action at line 359)

**Exports:**
```typescript
export async function analyzeAction(
  path: string,
  options: {
    service?: string;
    entrypoint?: string;
    clear?: boolean;
    quiet?: boolean;
    verbose?: boolean;
    debug?: boolean;
    logLevel?: string;
    logFile?: string;
    strict?: boolean;
    autoStart?: boolean;
  }
): Promise<void>;
```

**Imports needed:**
```typescript
// Node built-ins
import { resolve, join } from 'path';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { register } from 'node:module';

// @grafema packages
import type { Plugin, GrafemaConfig } from '@grafema/core';
import {
  Orchestrator,
  RFDBServerBackend,
  DiagnosticReporter,
  DiagnosticWriter,
  createLogger,
  loadConfig,
  StrictModeFailure,
} from '@grafema/core';
import type { LogLevel } from '@grafema/types';

// Local
import { ProgressRenderer } from '../utils/progressRenderer.js';
import { BUILTIN_PLUGINS } from '../plugins/builtinPlugins.js';
```

**What stays in analyze.ts:**
- Command definition (lines 261-287)
- `.action()` call will import and use `analyzeAction`

**Dependencies:**
- All helper functions must move together (they form a dependency cluster)
- BUILTIN_PLUGINS will be imported from new plugins/builtinPlugins.ts
- ProgressRenderer imported from existing utils/

---

### 3. What Remains in analyze.ts

**New analyze.ts structure (~35 lines):**

```typescript
/**
 * Analyze command - Run project analysis via Orchestrator
 */

import { Command } from 'commander';
import { analyzeAction } from './analyzeAction.js';

export const analyzeCommand = new Command('analyze')
  .description('Run project analysis')
  .argument('[path]', 'Project path to analyze', '.')
  .option('-s, --service <name>', 'Analyze only a specific service')
  .option('-e, --entrypoint <path>', 'Override entrypoint (bypasses auto-detection)')
  .option('-c, --clear', 'Clear existing database before analysis')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-v, --verbose', 'Show verbose logging')
  .option('--debug', 'Enable debug mode (writes diagnostics.log)')
  .option('--log-level <level>', 'Set log level (silent, errors, warnings, info, debug)')
  .option('--log-file <path>', 'Write all log output to a file')
  .option('--strict', 'Enable strict mode (fail on unresolved references)')
  .option('--auto-start', 'Auto-start RFDB server if not running')
  .addHelpText('after', `
Examples:
  grafema analyze                Analyze current project
  grafema analyze ./my-project   Analyze specific directory
  grafema analyze --clear        Clear database and rebuild from scratch
  grafema analyze -s api         Analyze only "api" service (monorepo)
  grafema analyze -v             Verbose output with progress details
  grafema analyze --debug        Write diagnostics.log for debugging
  grafema analyze --log-file out.log  Write all logs to a file
  grafema analyze --strict       Fail on unresolved references (debugging)
  grafema analyze --auto-start   Auto-start server (useful for CI)

Note: Start the server first with: grafema server start
`)
  .action(analyzeAction);
```

**Line count estimate:** ~35 lines (imports + command definition)

---

## Public API Analysis

**Current exports from analyze.ts:**
- `analyzeCommand` (default export via commander pattern)
- `NodeEdgeCountBackend` (type export)
- `fetchNodeEdgeCounts()` (function export)
- `exitWithCode()` (function export)

**Import sites:**
```bash
$ grep -r "from.*analyze" packages/cli/src/
packages/cli/src/cli.ts:import { analyzeCommand } from './commands/analyze.js';
```

**Result:** Only `analyzeCommand` is imported externally. Other exports might be used in tests or are dead code.

**After refactoring:**
- `analyzeCommand` exported from analyze.ts (unchanged API)
- `NodeEdgeCountBackend`, `fetchNodeEdgeCounts`, `exitWithCode` exported from analyzeAction.ts (for testing)
- No breaking changes to public API

---

## Directory Structure

```
packages/cli/src/
├── commands/
│   ├── analyze.ts          (~35 lines) — command definition only
│   ├── analyzeAction.ts    (NEW, ~260 lines) — action + helpers
│   └── ... (other commands)
├── plugins/
│   ├── builtinPlugins.ts   (NEW, ~60 lines) — BUILTIN_PLUGINS registry
│   └── pluginResolver.js   (existing)
└── utils/
    └── progressRenderer.ts (existing)
```

---

## Risk Assessment

**Risk Level:** LOW (pure structural refactoring)

**Risks:**
1. **Import cycles:** analyzeAction.ts imports from plugins/builtinPlugins.ts, which imports from @grafema/core
   - **Mitigation:** No cycle — this is one-way dependency
2. **Export visibility:** Currently exported helpers (fetchNodeEdgeCounts, exitWithCode) move to new file
   - **Mitigation:** Export from analyzeAction.ts if needed for tests
3. **Module resolution:** New files must be properly resolved by TypeScript/Node ESM
   - **Mitigation:** Use `.js` extensions in imports (existing pattern in codebase)
4. **Test breakage:** If tests import from analyze.ts directly
   - **Mitigation:** Check test imports before refactoring (none found via grep)

---

## Implementation Steps

**CRITICAL: TDD discipline — tests FIRST**

### Step 1: Write Tests (Kent)
1. Lock current behavior with integration test:
   - Import `analyzeCommand` from analyze.ts
   - Mock backend, orchestrator
   - Test that command action executes without errors
   - Snapshot test for help text
2. Lock helper functions:
   - Unit test for `fetchNodeEdgeCounts()`
   - Unit test for `exitWithCode()`
   - Unit test for `getLogLevel()`
   - Unit test for `createPlugins()` with BUILTIN_PLUGINS
   - Unit test for `loadCustomPlugins()`
   - Unit test for `registerPluginResolver()`

### Step 2: Extract BUILTIN_PLUGINS (Rob)
1. Create `packages/cli/src/plugins/builtinPlugins.ts`
2. Move lines 85-132 + imports for 30 plugin classes
3. Export `BUILTIN_PLUGINS`
4. Update analyze.ts import: `import { BUILTIN_PLUGINS } from '../plugins/builtinPlugins.js';`
5. Run tests — must pass

### Step 3: Extract analyzeAction (Rob)
1. Create `packages/cli/src/commands/analyzeAction.ts`
2. Move action function + all helper functions + types
3. Add imports (see "Imports needed" above)
4. Export `analyzeAction` + test-only exports (helpers, types)
5. Update analyze.ts to import and use `analyzeAction`
6. Run tests — must pass

### Step 4: Cleanup (Rob)
1. Remove unused imports from analyze.ts
2. Verify line counts:
   - analyze.ts: ~35 lines
   - analyzeAction.ts: ~260 lines
   - builtinPlugins.ts: ~60 lines
3. Run full test suite

### Step 5: Commit
- Single atomic commit: "refactor(cli): extract BUILTIN_PLUGINS and analyzeAction from analyze.ts (REG-435)"
- Tests must pass before commit

---

## Expected Results

**Before:**
- `analyze.ts`: 517 lines (CRITICAL threshold exceeded)

**After:**
- `analyze.ts`: ~35 lines (command definition only)
- `analyzeAction.ts`: ~260 lines (action + helpers)
- `builtinPlugins.ts`: ~60 lines (plugin registry)
- **Total:** ~355 lines (same logic, better structure)

**Benefits:**
- File size under 300-line threshold
- Single Responsibility: analyze.ts defines command, analyzeAction.ts implements it
- Plugin registry isolated and reusable
- Easier to test (helpers can be unit tested independently)

---

## Notes

- This is **pure refactoring** — no behavioral changes
- Tests lock current behavior BEFORE extraction
- All moved code retains exact same logic
- Import paths use `.js` extension (ESM + TypeScript pattern in this codebase)
- No changes to public API (`analyzeCommand` export unchanged)
- `packages/cli/src/config/` directory does NOT exist — no need to coordinate with config module

**Complexity estimate:** 2-3 hours (including test writing)

**Dependency on other tasks:** None — standalone refactoring
