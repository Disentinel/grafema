# BLOCKER RESOLUTION — REG-78 Error Handling

**Author:** Joel Spolsky (Implementation Planner)
**Date:** January 23, 2026
**Status:** Resolving Linus's blocking concerns

---

## Blocking Concern #1: PluginResult.errors[] Type

### Current State (from packages/types/src/plugins.ts:52-61)

```typescript
export interface PluginResult {
  success: boolean;
  created: { nodes: number; edges: number };
  errors: Error[];      // ← Native JavaScript Error type
  warnings: string[];   // ← Plain strings
  metadata?: Record<string, unknown>;
}
```

### Decision: GrafemaError extends Error

**Approach:** GrafemaError will extend JavaScript's native `Error` class.

**Why this works:**
1. **Type-safe:** `GrafemaError extends Error` → any `GrafemaError` is valid in `Error[]`
2. **Backward compatible:** Existing code returning `new Error('message')` still works
3. **Progressive enhancement:** DiagnosticCollector checks `instanceof GrafemaError` for rich info

**Implementation:**

```typescript
// packages/core/src/errors/GrafemaError.ts
export abstract class GrafemaError extends Error {
  abstract readonly code: string;
  abstract readonly severity: 'fatal' | 'error' | 'warning';
  readonly context: ErrorContext;
  readonly suggestion?: string;

  constructor(message: string, context: ErrorContext = {}, suggestion?: string) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
    this.suggestion = suggestion;
  }
}
```

**In DiagnosticCollector:**

```typescript
addFromPluginResult(phase: PluginPhase, plugin: string, result: PluginResult): void {
  for (const error of result.errors) {
    if (error instanceof GrafemaError) {
      // Rich diagnostic with code, severity, context, suggestion
      this.add({
        code: error.code,
        severity: error.severity,
        message: error.message,
        context: error.context,
        suggestion: error.suggestion,
        phase,
        plugin,
      });
    } else {
      // Plain Error - treat as generic error
      this.add({
        code: 'ERR_UNKNOWN',
        severity: 'error',
        message: error.message,
        phase,
        plugin,
      });
    }
  }
}
```

**No changes to PluginResult needed.** Existing `Error[]` type is fine.

---

## Blocking Concern #2: Orchestrator vs CLI Responsibility

### Current State (from Orchestrator.ts)

Looking at `runPhase()` (lines 487-521):

```typescript
async runPhase(phaseName: string, context: ...): Promise<void> {
  for (const plugin of phasePlugins) {
    await plugin.execute(pluginContext);  // ← Result IGNORED!
  }
}
```

**Current behavior:**
- Orchestrator doesn't check `result.success`
- Orchestrator doesn't collect `result.errors[]`
- If a plugin throws, Orchestrator crashes (no catch)
- Silent failures everywhere

### Decision: Orchestrator Collects + Stops on Fatal; CLI Reports

**Responsibility split:**

| Concern | Owner | Reason |
|---------|-------|--------|
| Collect diagnostics | Orchestrator | Has access to phase/plugin context |
| Stop on fatal | Orchestrator | Must halt analysis immediately |
| Format/report | CLI | Presentation concern (text/json/etc) |
| Exit code | CLI | Process control is CLI's domain |

**Implementation:**

#### 1. Orchestrator.runPhase() — Collect and Throw on Fatal

```typescript
async runPhase(phaseName: string, context: ...): Promise<void> {
  for (const plugin of phasePlugins) {
    try {
      const result = await plugin.execute(pluginContext);

      // Collect errors into diagnostics
      this.diagnosticCollector.addFromPluginResult(
        phaseName as PluginPhase,
        plugin.metadata.name,
        result
      );

      // Log plugin completion
      if (!result.success) {
        this.logger.warn(`Plugin ${plugin.metadata.name} reported failure`, {
          errors: result.errors.length,
          warnings: result.warnings.length,
        });
      }

      // Check for fatal errors - STOP immediately
      if (this.diagnosticCollector.hasFatal()) {
        const fatal = this.diagnosticCollector.getByFatal()[0];
        throw new Error(`Fatal error in ${plugin.metadata.name}: ${fatal.message}`);
      }
    } catch (e) {
      // Plugin threw an exception (not just returned errors)
      const error = e instanceof Error ? e : new Error(String(e));
      this.diagnosticCollector.add({
        code: 'ERR_PLUGIN_THREW',
        severity: 'fatal',
        message: error.message,
        phase: phaseName as PluginPhase,
        plugin: plugin.metadata.name,
      });
      throw error;  // Re-throw to stop analysis
    }
  }
}
```

#### 2. CLI — Catch, Report, Exit

```typescript
// In analyze.ts action handler
try {
  const manifest = await orchestrator.run(projectPath);
  const diagnostics = orchestrator.getDiagnostics();

  // Report summary
  const reporter = new DiagnosticReporter(diagnostics);
  console.log(reporter.summary());

  // Write diagnostics.log in debug mode
  if (options.debug) {
    const writer = new DiagnosticWriter();
    await writer.write(diagnostics, grafemaDir);
  }

  // Exit code based on severity
  if (diagnostics.hasFatal()) {
    process.exit(1);
  } else if (diagnostics.hasErrors()) {
    process.exit(2);  // Completed with errors
  } else {
    process.exit(0);  // Success (maybe warnings)
  }
} catch (e) {
  // Orchestrator threw (fatal error stopped analysis)
  const diagnostics = orchestrator.getDiagnostics();
  const reporter = new DiagnosticReporter(diagnostics);
  console.error(reporter.report({ format: 'text', includeSummary: true }));
  process.exit(1);
}
```

#### 3. Exit Codes

| Code | Meaning | When |
|------|---------|------|
| 0 | Success | No errors (warnings OK) |
| 1 | Fatal | Analysis stopped early |
| 2 | Errors | Analysis completed but had errors |

---

## Summary of Decisions

### Q1: What is PluginResult.errors type?
**A:** `Error[]` (native JavaScript). GrafemaError extends Error. No type changes needed.

### Q2: Does Orchestrator.run() throw on fatal errors?
**A:** Yes. Orchestrator throws immediately when a fatal error is detected.

### Q3: How does CLI know exit code?
**A:** CLI checks `diagnostics.hasFatal()`, `diagnostics.hasErrors()` to determine exit code (1, 2, or 0).

### Q4: What happens if ConsoleLogger throws?
**A:** Logger methods wrap in try-catch, fallback to `console.log()`.

---

## Updated Implementation Order

No changes to Phase 1/Phase 2 structure. Just clarifications:

**Phase 1:**
1. GrafemaError extends Error (backward compatible)
2. Logger with try-catch fallback
3. No changes to PluginResult type

**Phase 2:**
1. DiagnosticCollector with `hasFatal()`, `hasErrors()` methods
2. Orchestrator.runPhase() collects + throws on fatal
3. CLI catches, reports, exits with correct code

---

**Blockers resolved. Ready for Kent to write tests.**
