# Integration Report - Phase 2 Diagnostic System Wiring

**Author:** Rob Pike (Implementation Engineer)
**Date:** January 23, 2026
**Status:** Complete

---

## Summary

Completed the integration of DiagnosticCollector, DiagnosticReporter, and DiagnosticWriter into the actual system. The Phase 2 components were created but not wired - this report documents the integration work.

---

## Changes Made

### 1. Orchestrator.ts (`/packages/core/src/Orchestrator.ts`)

**Added imports:**
```typescript
import { DiagnosticCollector } from './diagnostics/DiagnosticCollector.js';
import type { PluginPhase } from '@grafema/types';
```

**Added field:**
```typescript
private diagnosticCollector: DiagnosticCollector;
```

**Initialized in constructor:**
```typescript
this.diagnosticCollector = new DiagnosticCollector();
```

**Updated `runPhase()` method:**
- Wrapped plugin execution in try-catch
- After each plugin execution, calls `diagnosticCollector.addFromPluginResult()`
- Checks for fatal errors with `hasFatal()` - throws immediately to stop analysis
- Catches plugin exceptions and adds them as fatal diagnostics with code `ERR_PLUGIN_THREW`

**Added getter:**
```typescript
getDiagnostics(): DiagnosticCollector {
  return this.diagnosticCollector;
}
```

### 2. analyze.ts (`/packages/cli/src/commands/analyze.ts`)

**Added imports:**
```typescript
import { DiagnosticReporter, DiagnosticWriter } from '@grafema/core';
```

**Added CLI flags:**
```typescript
.option('-v, --verbose', 'Show verbose logging')
.option('--debug', 'Enable debug mode (writes diagnostics.log)')
.option('--log-level <level>', 'Set log level (debug, info, warn, error)', 'info')
```

**Wrapped orchestrator.run() in try-catch:**
- On success: retrieves diagnostics, prints summary, writes diagnostics.log in debug mode
- On failure: prints error report, writes diagnostics.log in debug mode

**Exit codes:**
| Code | Meaning | When |
|------|---------|------|
| 0 | Success | No errors (warnings OK) |
| 1 | Fatal | Analysis stopped early |
| 2 | Errors | Analysis completed but had errors |

---

## Testing

### Test 1: Simple project (no errors)
```bash
node packages/cli/dist/cli.js analyze test/fixtures/simple-project --clear --debug
```

**Result:**
- Analysis completed in 0.06s
- Nodes: 0, Edges: 0
- diagnostics.log created (empty - no errors)
- Exit code: 0

### Test 2: Large project (packages/core)
```bash
node packages/cli/dist/cli.js analyze packages/core --clear --debug -v
```

**Result:**
- Analysis completed (~90s for ~15k nodes)
- diagnostics.log created (empty - no errors)
- Progress messages shown in verbose mode
- Exit code: 0

### Test 3: Help command
```bash
node packages/cli/dist/cli.js analyze --help
```

**Result:**
```
Options:
  -s, --service <name>  Analyze only a specific service
  -c, --clear           Clear existing database before analysis
  -q, --quiet           Suppress progress output
  -v, --verbose         Show verbose logging
  --debug               Enable debug mode (writes diagnostics.log)
  --log-level <level>   Set log level (debug, info, warn, error) (default: "info")
```

---

## Design Decisions

### 1. Progress output controlled by --verbose
Changed default behavior to NOT show progress messages. Users must explicitly use `-v` to see progress. This matches Joel's spec and keeps normal output clean.

### 2. Fatal error re-throw protection
When a fatal error is detected and we throw, the catch block checks `hasFatal()` to avoid double-adding the error to the collector.

### 3. Exit code semantics
- Exit code 0: Total success
- Exit code 1: Fatal - something is fundamentally wrong
- Exit code 2: Completed with errors - usable output but issues detected

This follows common CLI conventions (0 = success, non-zero = problem, with severity encoded).

---

## Files Modified

1. `/Users/vadimr/grafema/packages/core/src/Orchestrator.ts`
2. `/Users/vadimr/grafema/packages/cli/src/commands/analyze.ts`

---

## Build Status

Build successful (`pnpm build` completed without errors).

---

## Next Steps

The integration is complete. Phase 2 is now fully wired. The system:
1. Collects errors from plugin execution
2. Stops on fatal errors immediately
3. Reports summary at end of analysis
4. Writes diagnostics.log in debug mode
5. Exits with appropriate code

Ready for Linus/Kevlin review.
