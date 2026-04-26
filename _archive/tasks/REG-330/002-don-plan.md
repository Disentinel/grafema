# Don Melton's High-Level Plan: REG-330 Strict Mode

## Executive Summary

This is the RIGHT feature for Grafema. Silent failures are antithetical to the project's vision: "AI should query the graph, not read code." If the graph silently degrades, we're lying to users about what we know.

Strict mode is not just a debugging tool - it's an honesty mechanism.

## Analysis of Current State

### Configuration Architecture

**Config file:** `.grafema/config.yaml` (or `.grafema/config.json` deprecated)

```
packages/core/src/config/ConfigLoader.ts
```

The `GrafemaConfig` interface defines:
- `plugins` (by phase)
- `services` (explicit service definitions)
- `include`/`exclude` (glob patterns)

**Gap:** No boolean flags for analysis behavior. Will need to extend `GrafemaConfig`.

### CLI Flag Architecture

```
packages/cli/src/commands/analyze.ts
```

Current flags:
- `--quiet`, `--verbose`, `--debug`
- `--log-level <level>`
- `--clear`, `--service`, `--entrypoint`

Flags are passed to `Orchestrator` via `OrchestratorOptions`.

**Pattern:** CLI flags override config file values. This is correct - we follow the same pattern.

### Context Propagation

```
packages/types/src/plugins.ts - PluginContext interface
packages/core/src/Orchestrator.ts - creates and passes context
```

`PluginContext` already includes:
- `logger` (Logger interface)
- `forceAnalysis` (boolean flag)
- `reportIssue` (for VALIDATION phase)

**Pattern:** Boolean flags are added to `PluginContext` and propagated to all plugins.

### Error Infrastructure

```
packages/core/src/errors/GrafemaError.ts - error hierarchy
packages/core/src/diagnostics/DiagnosticCollector.ts - collects diagnostics
```

Existing error classes:
- `ConfigError` (fatal)
- `FileAccessError` (error)
- `LanguageError` (warning)
- `ValidationError` (configurable severity)

**Decision:** Create new `StrictModeError` class with severity 'fatal'.

### Places That Silently Fail

I identified the following graceful degradation points:

#### 1. MethodCallResolver (priority 50)
```
packages/core/src/plugins/enrichment/MethodCallResolver.ts
Line 133: unresolved++ (silent continue)
```
- Method call cannot be resolved to a METHOD or FUNCTION
- Currently: increments counter, continues
- Strict mode: should throw

#### 2. ArgumentParameterLinker (priority 45)
```
packages/core/src/plugins/enrichment/ArgumentParameterLinker.ts
Line 131-132: unresolvedCalls++; continue
Line 139-140: unresolvedCalls++; continue
```
- Call has no CALLS edge (can't link arguments)
- Target function not found
- Currently: increments counter, skips
- Strict mode: should throw

#### 3. FunctionCallResolver (priority 80)
```
packages/core/src/plugins/enrichment/FunctionCallResolver.ts
Lines 170-179, 205, etc.: skipped.* counters
```
- Missing import, missing IMPORTS_FROM edge, broken re-export chain
- Currently: increments various skip counters
- Strict mode: should throw

#### 4. AliasTracker (priority 60)
```
packages/core/src/plugins/enrichment/AliasTracker.ts
Line 186-194: logger.warn('Alias chains exceeded max depth')
Line 258-265: depth exceeded handling
```
- Alias chain exceeds MAX_DEPTH
- Cannot resolve aliased method call
- Currently: warns and continues
- Strict mode: should throw

#### 5. ImportExportLinker (priority 90)
Need to check this file for unresolved imports.

#### 6. CallResolverValidator (VALIDATION phase)
```
packages/core/src/plugins/validation/CallResolverValidator.ts
Lines 96-99: warnings.push() for unresolved
```
- Already detects unresolved calls
- Creates ValidationError with 'warning' severity
- Strict mode: could upgrade severity to 'fatal'

#### 7. DataFlowValidator (VALIDATION phase)
```
packages/core/src/plugins/validation/DataFlowValidator.ts
Lines 103-116, 143-156: errors.push() for missing assignments
```
- Missing ASSIGNED_FROM edges
- No path to leaf node
- Currently: warning severity
- Strict mode: could upgrade to fatal

## Architecture Decision: Fail-First vs Collect-All

**Question:** Should strict mode fail on FIRST error, or collect ALL errors then fail?

**Answer:** COLLECT ALL, then fail.

Rationale:
1. A single analysis run should reveal ALL product gaps, not just the first one
2. More useful for dogfooding - one run shows complete picture
3. Consistent with how validators already work (collect then report)
4. Implementation is simpler - reuse existing DiagnosticCollector

**Mechanism:**
1. Strict mode changes HOW errors are classified, not WHEN
2. Enrichers report issues to DiagnosticCollector with severity='fatal' in strict mode
3. After ENRICHMENT phase, Orchestrator checks `hasFatal()` and stops

## Architecture Design

### 1. Config Schema Extension

```typescript
// GrafemaConfig in ConfigLoader.ts
export interface GrafemaConfig {
  plugins: {...};
  services: ServiceDefinition[];
  include?: string[];
  exclude?: string[];
  strict?: boolean;  // NEW: enable strict mode
}
```

### 2. CLI Flag

```typescript
// analyze.ts
.option('--strict', 'Enable strict mode (fail on unresolved references)')
```

### 3. Context Extension

```typescript
// PluginContext in types/plugins.ts
export interface PluginContext {
  // ... existing fields
  strictMode?: boolean;  // NEW: strict mode flag
}
```

### 4. Error Class

```typescript
// GrafemaError.ts
export class StrictModeError extends GrafemaError {
  readonly code: string;
  readonly severity = 'fatal' as const;

  constructor(
    message: string,
    code: string,
    context: ErrorContext = {},
    suggestion?: string
  ) {
    super(message, context, suggestion);
    this.code = code;
  }
}
```

Error codes:
- `STRICT_UNRESOLVED_CALL` - function call cannot be resolved
- `STRICT_UNRESOLVED_METHOD` - method call cannot be resolved
- `STRICT_MISSING_ASSIGNMENT` - variable has no ASSIGNED_FROM
- `STRICT_ALIAS_DEPTH_EXCEEDED` - alias chain too deep
- `STRICT_BROKEN_IMPORT` - import cannot be resolved

### 5. Enricher Pattern

```typescript
// Example: MethodCallResolver
if (!targetMethod) {
  unresolved++;

  if (context.strictMode) {
    const error = new StrictModeError(
      `Cannot resolve method call ${methodCall.object}.${methodCall.method} at ${methodCall.file}:${methodCall.line}`,
      'STRICT_UNRESOLVED_METHOD',
      {
        filePath: methodCall.file,
        lineNumber: methodCall.line,
        phase: 'ENRICHMENT',
        plugin: 'MethodCallResolver',
        object: methodCall.object,
        method: methodCall.method,
      },
      'Check if the class is imported and the method exists'
    );
    errors.push(error);  // Collect, don't throw
  }
}
```

### 6. Orchestrator Integration

```typescript
// After ENRICHMENT phase in Orchestrator.run()
if (this.strictMode) {
  const enrichmentDiagnostics = this.diagnosticCollector.getByPhase('ENRICHMENT');
  const strictErrors = enrichmentDiagnostics.filter(d => d.severity === 'fatal');

  if (strictErrors.length > 0) {
    // Log all strict mode errors
    for (const err of strictErrors) {
      this.logger.error(`[STRICT] ${err.message}`, { code: err.code, file: err.file, line: err.line });
    }
    throw new Error(`Strict mode: ${strictErrors.length} unresolved references found. Analysis stopped.`);
  }
}
```

## Scope Definition

### In Scope

1. `strict` config option in `GrafemaConfig`
2. `--strict` CLI flag for `grafema analyze`
3. `strictMode` in `PluginContext`
4. `StrictModeError` class
5. Strict mode handling in these enrichers:
   - MethodCallResolver
   - ArgumentParameterLinker
   - FunctionCallResolver
   - AliasTracker
6. Orchestrator phase barrier (fail after ENRICHMENT if strict errors)
7. Clear error output with file/line/context

### Out of Scope (Future)

1. Strict mode for INDEXING phase errors (parse failures, etc.)
2. Strict mode for VALIDATION phase (already has error severity)
3. Per-file or per-plugin strict mode overrides
4. Whitelisting known unresolvable patterns

## Risk Assessment

### Low Risk
- Config/CLI changes - additive, backward compatible
- Error class - follows existing pattern
- Context propagation - well-established pattern

### Medium Risk
- Enricher changes - need careful review that we don't break normal flow
- Test coverage - need tests for strict mode paths

### Technical Debt
- None created - this is debt PAYMENT (finding hidden failures)

## Implementation Order

1. **Types first:** Add `strictMode` to `PluginContext` (packages/types)
2. **Error class:** Add `StrictModeError` to GrafemaError.ts
3. **Config:** Extend `GrafemaConfig` with `strict` option
4. **CLI:** Add `--strict` flag to analyze command
5. **Orchestrator:** Propagate `strictMode` to context, add phase barrier
6. **Enrichers:** Update one at a time with strict mode handling
   - Start with MethodCallResolver (clearest failure mode)
   - Then FunctionCallResolver
   - Then ArgumentParameterLinker
   - Then AliasTracker
7. **Tests:** For each enricher, test strict mode failure

## Validation Criteria

This implementation is RIGHT if:

1. Running `grafema analyze --strict` on a codebase with unresolvable patterns FAILS loudly
2. Error messages clearly indicate WHAT couldn't be resolved and WHERE
3. All unresolved items are collected before failing (not just first)
4. Normal mode (`strict: false`) behavior is UNCHANGED
5. Exit code is non-zero when strict mode finds errors
6. Dogfooding: Running strict mode on Grafema itself reveals real product gaps

## Questions for Joel

1. Should strict mode affect VALIDATION phase validators, or just ENRICHMENT?
2. Should we add a `--strict-summary` flag to show count without failing?
3. Priority order for enricher updates?

---

**Verdict:** This plan is architecturally sound. Strict mode is a first-class feature that aligns with Grafema's vision of being an honest tool. The collect-all-then-fail approach gives maximum value per analysis run.

Ready for Joel's technical expansion.
