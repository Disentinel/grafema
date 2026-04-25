# DETAILED TECHNICAL SPECIFICATION — REG-78 Error Handling & Diagnostics

**Author:** Joel Spolsky (Implementation Planner)
**Date:** January 23, 2026
**Scope:** Phase 1 (Error Types & Diagnostics) + Phase 2 (CLI & Core Updates)

## 1. Architecture Review & Decisions

### 1.1 GrafemaError Hierarchy — APPROVED WITH ADJUSTMENTS

**Don's hierarchy is sound.** Minor adjustments:

```
GrafemaError (abstract base class)
├── ConfigError
├── FileAccessError
├── LanguageError
├── DatabaseError
├── PluginError
└── AnalysisError
```

**Decision:** Use a simple, flat hierarchy. No intermediate abstract classes. Each error is concrete and throwable.

### 1.2 Logger Approach — CUSTOM SIMPLE LOGGER

**Rationale:**
- Winston/Pino are overkill (12+ MB+ overhead, features we don't need)
- Current codebase has NO logging dependencies
- PluginContext is already passed everywhere
- Custom Logger is 200 lines, testable, zero overhead

**Decision:** Create custom Logger interface with 5 methods: `error()`, `warn()`, `info()`, `debug()`, `trace()`.

### 1.3 Diagnostic Collection Strategy — LIGHTWEIGHT

**Rationale:**
- PluginResult.errors[] already exists — we leverage it
- Each plugin collects its own errors
- Orchestrator aggregates and reports
- No separate DiagnosticCollector class needed for Phase 1

**Decision for Phase 1:** Leverage PluginResult.errors[]. Phase 2 adds DiagnosticCollector for real-time aggregation if needed.

### 1.4 OrchestratorConfig Extension — MINIMAL

**Current fields to add:**
```typescript
logLevel?: 'silent' | 'errors' | 'warnings' | 'info' | 'debug'
```

**Rationale:** `verbose` and `debug` are CLI concerns. Core config should only have `logLevel`. CLI translates `--verbose` → `logLevel: 'info'` and `--debug` → `logLevel: 'debug'`.

---

## 2. Phase 1: Error Types & Diagnostics (Week 1)

### 2.1 FILES TO CREATE

#### A. `packages/core/src/errors/GrafemaError.ts` (150 lines)

```typescript
// Base class with error code, severity, context, and recovery suggestion
export abstract class GrafemaError extends Error {
  abstract readonly code: string;
  abstract readonly severity: 'fatal' | 'error' | 'warning';
  readonly context: ErrorContext;
  readonly suggestion?: string;

  constructor(message: string, context: ErrorContext, suggestion?: string) { ... }
  toJSON(): {...}  // For diagnostics.log
}
```

**Concrete error classes to create in same file (one per export):**

1. **ConfigError** — config.json parsing, validation, missing required fields
   - Codes: `ERR_CONFIG_INVALID`, `ERR_CONFIG_MISSING_FIELD`
   - Severity: `fatal`

2. **FileAccessError** — unreadable files, missing git, permissions
   - Codes: `ERR_FILE_UNREADABLE`, `ERR_GIT_NOT_FOUND`, `ERR_GIT_ACCESS_DENIED`
   - Severity: `error` (most) / `fatal` (git-related)
   - Suggestion: "Run `git init`" or "Check file permissions"

3. **LanguageError** — unsupported file type, unparseable syntax
   - Codes: `ERR_UNSUPPORTED_LANG`, `ERR_PARSE_FAILURE`
   - Severity: `warning`
   - Suggestion: "Use RustAnalyzer plugin" or "File syntax is invalid"

4. **DatabaseError** — rfdb connection, corruption, lock
   - Codes: `ERR_DATABASE_LOCKED`, `ERR_DATABASE_CORRUPTED`
   - Severity: `fatal`
   - Suggestion: "Run `grafema analyze --clear`"

5. **PluginError** — plugin execution failed, dependency missing
   - Codes: `ERR_PLUGIN_FAILED`, `ERR_PLUGIN_DEPENDENCY_MISSING`
   - Severity: `error` / `fatal`
   - Suggestion: "Run `npm install`" or check plugin config

6. **AnalysisError** — internal analyzer failure, timeout
   - Codes: `ERR_ANALYSIS_TIMEOUT`, `ERR_ANALYSIS_INTERNAL`
   - Severity: `error` / `fatal`

#### B. `packages/core/src/logging/Logger.ts` (200 lines)

```typescript
export interface Logger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  trace(message: string, context?: Record<string, unknown>): void;
}

export class ConsoleLogger implements Logger {
  constructor(private logLevel: LogLevel = 'info') {}
  error(message: string, context?: Record<string, unknown>): void { ... }
  // ... etc
}

export type LogLevel = 'silent' | 'errors' | 'warnings' | 'info' | 'debug';

export function createLogger(level: LogLevel): Logger {
  return new ConsoleLogger(level);
}
```

**Design:**
- Respects `logLevel` setting
- Methods do nothing if below threshold (e.g., `info()` when `logLevel='errors'`)
- Context object optional, JSON stringified for display
- NO colors/formatting in core; let CLI handle that

#### C. `packages/types/src/plugins.ts` — EXTEND (20 lines)

**Add to PluginContext:**
```typescript
export interface PluginContext {
  // ... existing fields ...
  logger?: Logger;
}

export interface Logger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  trace(message: string, context?: Record<string, unknown>): void;
}
```

**Add to OrchestratorConfig:**
```typescript
export interface OrchestratorConfig {
  // ... existing ...
  logLevel?: 'silent' | 'errors' | 'warnings' | 'info' | 'debug';
}
```

### 2.2 FILES TO MODIFY

#### A. `packages/core/src/index.ts` (5 lines)

Export new error classes and Logger:
```typescript
export * from './errors/GrafemaError.js';
export * from './logging/Logger.js';
```

#### B. `packages/core/src/Orchestrator.ts` (30 lines)

1. Add logger field to constructor
2. Pass logger to PluginContext in phase execution
3. Create logger from logLevel in config

```typescript
export interface OrchestratorOptions {
  // ... existing ...
  logLevel?: LogLevel;
}

constructor(options: OrchestratorOptions = {}) {
  this.logger = createLogger(options.logLevel || 'info');
  // ... rest
}

async runPhase(plugins: Plugin[], phase: PluginPhase, context: Partial<PluginContext>) {
  context.logger = this.logger;
  // ... run plugins
}
```

### 2.3 TEST FILES TO CREATE

#### A. `test/unit/errors/GrafemaError.test.ts` (150 lines)

Test each error class:
- Constructor sets message, code, severity, context
- toJSON() returns expected structure
- Message formatting includes code
- Suggestion optional

#### B. `test/unit/logging/Logger.test.ts` (100 lines)

Test ConsoleLogger:
- Respects logLevel threshold
- Formats context as JSON
- error/warn/info/debug/trace all work
- Multiple contexts work

---

## 3. Phase 2: CLI & Core Updates (Week 2)

### 3.1 FILES TO CREATE

#### A. `packages/core/src/diagnostics/DiagnosticCollector.ts` (200 lines)

```typescript
export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  phase: PluginPhase;
  plugin: string;
  timestamp: number;
}

export class DiagnosticCollector {
  private diagnostics: Diagnostic[] = [];

  addFromPluginResult(phase: PluginPhase, plugin: string, result: PluginResult): void {
    // Extract errors[] from PluginResult, convert to Diagnostic[]
  }

  getByPhase(phase: PluginPhase): Diagnostic[] { ... }
  getByPlugin(plugin: string): Diagnostic[] { ... }
  getByCode(code: string): Diagnostic[] { ... }
  toDiagnosticsLog(): string { ... }  // JSON lines format
}
```

**Acceptance:** Collects errors from PluginResult, filters, reports

#### B. `packages/core/src/diagnostics/DiagnosticReporter.ts` (250 lines)

```typescript
export interface ReportOptions {
  format: 'text' | 'json' | 'csv';
  includeSummary: boolean;
  includeTrace: boolean;
}

export class DiagnosticReporter {
  constructor(private collector: DiagnosticCollector) {}

  report(options: ReportOptions): string {
    if (options.format === 'text') return this.textReport();
    if (options.format === 'json') return this.jsonReport();
    if (options.format === 'csv') return this.csvReport();
  }

  private textReport(): string {
    // Human-readable: "❌ ERR_PARSE_FAILURE (src/app.rs:12) unsupported-lang"
    //                  Suggestion: Use RustAnalyzer plugin
  }

  private jsonReport(): string {
    // [{"code":"ERR_PARSE_FAILURE", "file":"src/app.rs", "line":12, ...}]
  }

  summary(): string {
    // "Analyzed 450 files. Errors: 10, Warnings: 25, Skipped: 8"
  }
}
```

**Acceptance:** Formats diagnostics for CLI output

#### C. `packages/core/src/diagnostics/DiagnosticWriter.ts` (100 lines)

```typescript
export class DiagnosticWriter {
  async write(collector: DiagnosticCollector, grafemaDir: string): Promise<void> {
    // Write .grafema/diagnostics.log as JSON lines
    // Include timestamp, phase, code, message, suggestion
  }
}
```

**Acceptance:** Writes diagnostics.log in debug mode

### 3.2 CLI UPDATES — `packages/cli/src/commands/analyze.ts` (50 lines)

**Add to analyzeCommand:**

```typescript
.option('-v, --verbose', 'Show verbose logging (warnings + info)')
.option('--debug', 'Enable debug mode (trace logging + diagnostics.log)')
.option('--log-level <level>', 'Set log level: silent|errors|warnings|info|debug')
.option('--json-output', 'Format output as JSON')
```

**In action handler:**
```typescript
const logLevel = options.logLevel ||
  (options.debug ? 'debug' : options.verbose ? 'info' : 'warnings');

const orchestrator = new Orchestrator({
  ...options,
  logLevel,
});

// After orchestrator.run():
if (options.debug) {
  const writer = new DiagnosticWriter();
  await writer.write(diagnosticCollector, grafemaDir);
  console.log(`[Grafema] Diagnostics written to .grafema/diagnostics.log`);
}

// Always report summary
const reporter = new DiagnosticReporter(diagnosticCollector);
console.log(reporter.summary());
```

### 3.3 ORCHESTRATOR UPDATE — `packages/core/src/Orchestrator.ts` (100 lines)

```typescript
private diagnosticCollector: DiagnosticCollector;

constructor(options: OrchestratorOptions = {}) {
  // ... existing ...
  this.diagnosticCollector = new DiagnosticCollector();
  this.logger = createLogger(options.logLevel || 'info');
}

async runPhase(plugins: Plugin[], phase: PluginPhase, context: Partial<PluginContext>) {
  context.logger = this.logger;

  for (const plugin of plugins) {
    const result = await plugin.execute(context);
    this.diagnosticCollector.addFromPluginResult(phase, plugin.metadata.name, result);

    // Log plugin result summary
    if (!result.success && result.errors.length > 0) {
      this.logger.error(`Plugin ${plugin.metadata.name} failed`, {
        errors: result.errors.length,
        warnings: result.warnings.length
      });
    }
  }
}

getDiagnostics(): DiagnosticCollector {
  return this.diagnosticCollector;
}
```

### 3.4 TEST FILES TO CREATE

#### A. `test/unit/diagnostics/DiagnosticCollector.test.ts` (120 lines)

Test:
- Collects errors from PluginResult
- Filters by phase, plugin, code
- Formats as diagnostics log

#### B. `test/unit/diagnostics/DiagnosticReporter.test.ts` (150 lines)

Test:
- Text output formatting
- JSON output formatting
- Summary calculation
- Suggestion inclusion

#### C. `test/integration/error-handling.test.ts` (200 lines)

Test end-to-end:
- Plugin error → PluginResult.errors[] → DiagnosticCollector → DiagnosticReporter
- CLI --verbose shows warnings
- CLI --debug writes diagnostics.log
- Orchestrator logs via logger

---

## 4. IMPLEMENTATION ORDER (For Kent & Rob)

### Phase 1 (Week 1) — Sequential Order

1. **Kent writes tests first** (2 hours)
   - `test/unit/errors/GrafemaError.test.ts`
   - `test/unit/logging/Logger.test.ts`

2. **Rob implements** (4 hours)
   - `packages/core/src/errors/GrafemaError.ts`
   - `packages/core/src/logging/Logger.ts`
   - Update `packages/types/src/plugins.ts` (Logger + logLevel)
   - Update `packages/core/src/index.ts`

3. **Rob updates Orchestrator** (2 hours)
   - Add logger field + creation
   - Pass logger to PluginContext

4. **Kent runs tests** (30 min)
   - `npm test` — Phase 1 tests only

### Phase 2 (Week 2) — Sequential Order

1. **Kent writes tests** (3 hours)
   - `test/unit/diagnostics/DiagnosticCollector.test.ts`
   - `test/unit/diagnostics/DiagnosticReporter.test.ts`
   - `test/integration/error-handling.test.ts`

2. **Rob implements** (6 hours)
   - `packages/core/src/diagnostics/DiagnosticCollector.ts`
   - `packages/core/src/diagnostics/DiagnosticReporter.ts`
   - `packages/core/src/diagnostics/DiagnosticWriter.ts`

3. **Rob updates Orchestrator & CLI** (4 hours)
   - Orchestrator: add diagnosticCollector field
   - Orchestrator: log plugin errors
   - CLI: add --verbose, --debug, --log-level flags
   - CLI: write diagnostics.log, print summary

4. **Kent runs tests** (30 min)
   - Full test suite

---

## 5. SPECIFIC CODE PATTERNS & DECISIONS

### 5.1 Error Creation in Plugins

**OLD (avoid):**
```typescript
catch (e) {
  console.error('...');
  return [];
}
```

**NEW (required):**
```typescript
catch (e) {
  const error = new LanguageError(
    `Failed to parse ${filePath}: ${(e as Error).message}`,
    { filePath, phase: 'INDEXING', plugin: 'JSModuleIndexer' },
    'Ensure file syntax is valid or use specialized parser'
  );
  return createErrorResult(error);
}
```

### 5.2 Logger Usage in Plugins

**Example: JSModuleIndexer**

```typescript
async execute(context: PluginContext): Promise<PluginResult> {
  const { graph, logger } = context;
  const results = [];

  for (const file of files) {
    try {
      const deps = this.processFile(file);
      results.push(dep);
    } catch (e) {
      logger?.warn(`Failed to parse ${file}`, { error: (e as Error).message });
      results.push(new LanguageError(...));
    }
  }

  return createSuccessResult({ nodes: results.length, edges: 0 });
}
```

### 5.3 Backward Compatibility

**PluginResult.errors[]:**
- Already exists, we enhance its use
- Phase 1 plugins still return empty errors[] — OK for now
- Phase 2+ ALL plugins must populate errors[] and warnings[]

**Logger in PluginContext:**
- Optional field (default to no-op logger)
- Plugins check `if (logger)` before calling

**OrchestratorConfig:**
- `logLevel` is new, optional, default = 'warnings'
- Existing code continues to work

---

## 6. SUCCESS CRITERIA (For Linus)

### Phase 1 Completion
- [ ] GrafemaError hierarchy defined (6 concrete classes)
- [ ] Logger interface + ConsoleLogger implementation
- [ ] Logger passed through PluginContext (Orchestrator updated)
- [ ] Error code enum or constants defined
- [ ] Phase 1 tests pass (100% coverage of error/logger paths)
- [ ] TypeScript compilation succeeds, no warnings

### Phase 2 Completion
- [ ] DiagnosticCollector, Reporter, Writer implemented
- [ ] CLI: `--verbose`, `--debug`, `--log-level` flags work
- [ ] CLI: `grafema analyze --verbose` shows info+ logs
- [ ] CLI: `grafema analyze --debug` writes .grafema/diagnostics.log
- [ ] Orchestrator logs plugin errors (error count summary)
- [ ] Integration tests pass
- [ ] No silent failures in GitPlugin/JSModuleIndexer (both log errors)

---

## 7. RISK MITIGATION

### Risk: Breaking changes to PluginResult

**Mitigation:** PluginResult.errors[] already exists. We just use it more. No breaking change.

### Risk: Logger overhead in hot paths

**Mitigation:** Logger methods check logLevel first; no overhead for disabled levels. Lazy string evaluation.

### Risk: CLI output format changes

**Mitigation:** New flags (`--verbose`, `--debug`) are additive. Default behavior (quiet + errors only) unchanged.

### Risk: Scope creep

**Mitigation:** Phase 1 focused on types + logging. Phase 2 focused on diagnostics output. Recovery strategies (Phase 4) and retries deferred.

---

## 8. DETAILED TYPE SIGNATURES (For Rob)

### ErrorContext Type

```typescript
export interface ErrorContext {
  filePath?: string;
  lineNumber?: number;
  phase?: PluginPhase;
  plugin?: string;
  [key: string]: unknown;
}
```

### GrafemaError toJSON()

```typescript
{
  code: 'ERR_PARSE_FAILURE',
  severity: 'warning',
  message: 'Failed to parse src/app.rs: SyntaxError',
  context: { filePath: 'src/app.rs', plugin: 'JSModuleIndexer' },
  suggestion: 'Ensure valid syntax or use RustAnalyzer plugin'
}
```

### Diagnostic (in DiagnosticCollector)

```typescript
{
  code: 'ERR_PARSE_FAILURE',
  severity: 'warning',
  message: 'Failed to parse src/app.rs',
  file: 'src/app.rs',
  line: 0,
  phase: 'INDEXING',
  plugin: 'JSModuleIndexer',
  timestamp: 1674501234567
}
```

---

## 9. NEXT STEPS

1. **Don (Tech Lead):** Review this tech spec. Approve or iterate.
2. **Kent (Test Engineer):** Write Phase 1 tests (tomorrow).
3. **Rob (Implementation Engineer):** Implement Phase 1 (day 2-3).
4. **Kent runs tests**, code review cycle.
5. **Linus (Reviewer):** High-level review after Kent + Rob complete Phase 1.
6. **Repeat for Phase 2.**

---

**Specification Complete. Ready for Linus review and team execution.**
