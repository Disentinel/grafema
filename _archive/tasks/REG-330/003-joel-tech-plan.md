# Joel's Technical Plan: REG-330 Strict Mode Implementation

## Executive Summary

This document expands Don's high-level architecture into a step-by-step implementation plan. The goal is to add a `--strict` CLI flag and `strict` config option that causes Grafema to fail loudly when it encounters unresolved references during enrichment.

**Key design decision (from Don):** Collect ALL errors, then fail. This gives maximum value per analysis run.

---

## Part 1: Type Definitions

### 1.1 Extend PluginContext (packages/types/src/plugins.ts)

**File:** `/Users/vadimr/grafema-worker-6/packages/types/src/plugins.ts`

**Add to `PluginContext` interface** (around line 103, after `reportIssue`):

```typescript
/**
 * Strict mode flag. When true, enrichers should report unresolved
 * references as fatal errors instead of silently continuing.
 * Default: false (graceful degradation).
 */
strictMode?: boolean;
```

**Location:** Add after line 103 (after `reportIssue`)

---

### 1.2 Create StrictModeError Class (packages/core/src/errors/GrafemaError.ts)

**File:** `/Users/vadimr/grafema-worker-6/packages/core/src/errors/GrafemaError.ts`

**Add new error class** at end of file (after `ValidationError`, around line 209):

```typescript
/**
 * Strict mode error - reported when strictMode=true and an enricher
 * cannot resolve a reference.
 *
 * Unlike other errors, StrictModeError is used to collect issues that
 * would normally be silently skipped. All collected StrictModeErrors
 * cause analysis to fail after the ENRICHMENT phase completes.
 *
 * Severity: fatal (always)
 * Codes:
 * - STRICT_UNRESOLVED_METHOD: Method call cannot be resolved to definition
 * - STRICT_UNRESOLVED_CALL: Function call cannot be resolved to definition
 * - STRICT_UNRESOLVED_ARGUMENT: Argument cannot be linked to parameter
 * - STRICT_ALIAS_DEPTH_EXCEEDED: Alias chain too deep (potential cycle)
 * - STRICT_BROKEN_IMPORT: Import/re-export chain broken
 */
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

**Error codes to use:**
- `STRICT_UNRESOLVED_METHOD` - MethodCallResolver: method call has no target
- `STRICT_UNRESOLVED_CALL` - FunctionCallResolver: function call has no target
- `STRICT_UNRESOLVED_ARGUMENT` - ArgumentParameterLinker: call has no CALLS edge
- `STRICT_ALIAS_DEPTH_EXCEEDED` - AliasTracker: alias chain too deep
- `STRICT_BROKEN_IMPORT` - FunctionCallResolver: re-export chain broken

---

### 1.3 Export StrictModeError (packages/core/src/index.ts)

**File:** `/Users/vadimr/grafema-worker-6/packages/core/src/index.ts`

Find the exports from `./errors/GrafemaError.js` and add `StrictModeError`:

```typescript
export {
  GrafemaError,
  ConfigError,
  FileAccessError,
  LanguageError,
  DatabaseError,
  PluginError,
  AnalysisError,
  ValidationError,
  StrictModeError,  // ADD THIS
  type ErrorContext,
  type GrafemaErrorJSON,
} from './errors/GrafemaError.js';
```

---

## Part 2: Configuration

### 2.1 Extend GrafemaConfig (packages/core/src/config/ConfigLoader.ts)

**File:** `/Users/vadimr/grafema-worker-6/packages/core/src/config/ConfigLoader.ts`

**Add to `GrafemaConfig` interface** (after `exclude?: string[];` around line 62):

```typescript
/**
 * Enable strict mode for fail-fast debugging.
 * When true, analysis fails if enrichers cannot resolve references.
 * When false (default), graceful degradation with warnings.
 *
 * Can be overridden via CLI: --strict
 */
strict?: boolean;
```

**Update `mergeConfig` function** (around line 341, add before closing brace):

```typescript
strict: user.strict ?? defaults.strict,
```

**Update `DEFAULT_CONFIG`** (around line 69, add after `services: []`):

```typescript
strict: false, // Graceful degradation by default
```

---

### 2.2 Add CLI Flag (packages/cli/src/commands/analyze.ts)

**File:** `/Users/vadimr/grafema-worker-6/packages/cli/src/commands/analyze.ts`

**Add option** after `.option('--log-level <level>', ...)` (around line 141):

```typescript
.option('--strict', 'Enable strict mode (fail on unresolved references)')
```

**Update action handler signature** (line 151) to include `strict`:

```typescript
.action(async (path: string, options: { service?: string; entrypoint?: string; clear?: boolean; quiet?: boolean; verbose?: boolean; debug?: boolean; logLevel?: string; strict?: boolean }) => {
```

**Add strict mode resolution** after `const config = loadConfig(...)` (around line 176):

```typescript
// Resolve strict mode: CLI flag overrides config
const strictMode = options.strict ?? config.strict ?? false;
if (strictMode) {
  log('Strict mode enabled - analysis will fail on unresolved references');
}
```

**Pass to Orchestrator** (around line 200, add to constructor options):

```typescript
const orchestrator = new Orchestrator({
  graph: backend as unknown as import('@grafema/types').GraphBackend,
  plugins,
  serviceFilter: options.service || null,
  entrypoint: options.entrypoint,
  forceAnalysis: options.clear || false,
  logger,
  services: config.services.length > 0 ? config.services : undefined,
  strictMode, // ADD THIS
  onProgress: (progress) => {
    if (options.verbose) {
      log(`[${progress.phase}] ${progress.message}`);
    }
  },
});
```

**Update help text** (around line 142):

```typescript
.addHelpText('after', `
Examples:
  grafema analyze                Analyze current project
  grafema analyze ./my-project   Analyze specific directory
  grafema analyze --clear        Clear database and rebuild from scratch
  grafema analyze -s api         Analyze only "api" service (monorepo)
  grafema analyze -v             Verbose output with progress details
  grafema analyze --debug        Write diagnostics.log for debugging
  grafema analyze --strict       Fail on unresolved references (debugging)
`)
```

---

## Part 3: Orchestrator Integration

### 3.1 Update OrchestratorOptions (packages/core/src/Orchestrator.ts)

**File:** `/Users/vadimr/grafema-worker-6/packages/core/src/Orchestrator.ts`

**Add to `OrchestratorOptions` interface** (after `services?: ServiceDefinition[];` around line 70):

```typescript
/**
 * Enable strict mode for fail-fast debugging.
 * When true, enrichers report unresolved references as fatal errors.
 */
strictMode?: boolean;
```

**Add private field** (after `private configServices: ServiceDefinition[] | undefined;` around line 154):

```typescript
private strictMode: boolean;
```

**Initialize in constructor** (after `this.configServices = options.services;` around line 181):

```typescript
// Strict mode configuration
this.strictMode = options.strictMode ?? false;
```

### 3.2 Propagate strictMode to Plugin Context

**Update `runPhase` method** (around line 631, when building `pluginContext`):

```typescript
const pluginContext: PluginContext = {
  ...context,
  onProgress: this.onProgress as unknown as PluginContext['onProgress'],
  forceAnalysis: this.forceAnalysis,
  logger: this.logger,
  strictMode: this.strictMode, // ADD THIS
};
```

### 3.3 Add Phase Barrier After ENRICHMENT

**Add after ENRICHMENT phase completes** (around line 411, after `this.profiler.end('ENRICHMENT')`):

```typescript
// STRICT MODE BARRIER: Check for fatal errors after ENRICHMENT
if (this.strictMode) {
  const enrichmentDiagnostics = this.diagnosticCollector.getByPhase('ENRICHMENT');
  const strictErrors = enrichmentDiagnostics.filter(d => d.severity === 'fatal');

  if (strictErrors.length > 0) {
    this.logger.error(`Strict mode: ${strictErrors.length} unresolved reference(s) found`);
    for (const err of strictErrors) {
      this.logger.error(`  [${err.code}] ${err.message}`, {
        file: err.file,
        line: err.line,
        plugin: err.plugin,
      });
    }
    throw new Error(
      `Strict mode: ${strictErrors.length} unresolved reference(s) found during ENRICHMENT. ` +
      `Run without --strict for graceful degradation, or fix the underlying issues.`
    );
  }
}
```

---

## Part 4: Enricher Updates

Each enricher needs to:
1. Check `context.strictMode` flag
2. When an item cannot be resolved AND strictMode is true, create a `StrictModeError`
3. Push error to `errors` array (collected, not thrown)
4. Return errors in `PluginResult`

### 4.1 MethodCallResolver (packages/core/src/plugins/enrichment/MethodCallResolver.ts)

**File:** `/Users/vadimr/grafema-worker-6/packages/core/src/plugins/enrichment/MethodCallResolver.ts`

**Add import** at top:

```typescript
import { StrictModeError } from '../../errors/GrafemaError.js';
```

**Add errors array** at start of `execute()` (after `let unresolved = 0;`):

```typescript
const errors: Error[] = [];
```

**Update the unresolved handling** (around line 133, replace the existing `unresolved++` block):

```typescript
} else {
  unresolved++;

  // In strict mode, collect error for later reporting
  if (context.strictMode) {
    const error = new StrictModeError(
      `Cannot resolve method call: ${methodCall.object}.${methodCall.method}`,
      'STRICT_UNRESOLVED_METHOD',
      {
        filePath: methodCall.file,
        lineNumber: methodCall.line,
        phase: 'ENRICHMENT',
        plugin: 'MethodCallResolver',
        object: methodCall.object,
        method: methodCall.method,
      },
      `Check if class "${methodCall.object}" is imported and has method "${methodCall.method}"`
    );
    errors.push(error);
  }
}
```

**Update return statement** (around line 146):

```typescript
return createSuccessResult({ nodes: 0, edges: edgesCreated }, summary, errors);
```

---

### 4.2 FunctionCallResolver (packages/core/src/plugins/enrichment/FunctionCallResolver.ts)

**File:** `/Users/vadimr/grafema-worker-6/packages/core/src/plugins/enrichment/FunctionCallResolver.ts`

**Add import** at top:

```typescript
import { StrictModeError } from '../../errors/GrafemaError.js';
```

**Add errors array** at start of `execute()` (after skipped object declaration):

```typescript
const errors: Error[] = [];
```

**Update the skipped.reExportsBroken handling** (around line 205):

```typescript
if (!resolved) {
  skipped.reExportsBroken++;

  // In strict mode, collect error
  if (context.strictMode) {
    const error = new StrictModeError(
      `Cannot resolve re-export chain for: ${calledName}`,
      'STRICT_BROKEN_IMPORT',
      {
        filePath: file,
        lineNumber: callSite.line as number | undefined,
        phase: 'ENRICHMENT',
        plugin: 'FunctionCallResolver',
        calledFunction: calledName,
        importSource: imp.source,
      },
      `Check if the module "${imp.source}" exists and exports "${calledName}"`
    );
    errors.push(error);
  }
  continue;
}
```

**Update return statement** (around line 286):

```typescript
return createSuccessResult(
  { nodes: 0, edges: edgesCreated },
  {
    callSitesProcessed: callSitesToResolve.length,
    edgesCreated,
    reExportsResolved,
    skipped,
    timeMs: Date.now() - startTime
  },
  errors
);
```

---

### 4.3 ArgumentParameterLinker (packages/core/src/plugins/enrichment/ArgumentParameterLinker.ts)

**File:** `/Users/vadimr/grafema-worker-6/packages/core/src/plugins/enrichment/ArgumentParameterLinker.ts`

**Add import** at top:

```typescript
import { StrictModeError } from '../../errors/GrafemaError.js';
```

**Add errors array** at start of `execute()` (after `let noParams = 0;`):

```typescript
const errors: Error[] = [];
```

**Update the unresolvedCalls handling** (around lines 131-140):

```typescript
// 2. Get CALLS edge to find target function
const callsEdges = await graph.getOutgoingEdges(callNode.id, ['CALLS']);
if (callsEdges.length === 0) {
  unresolvedCalls++;

  // In strict mode, report unresolved calls that have arguments
  if (context.strictMode) {
    const error = new StrictModeError(
      `Call with arguments has no resolved target: ${callNode.name || callNode.id}`,
      'STRICT_UNRESOLVED_ARGUMENT',
      {
        filePath: callNode.file,
        lineNumber: callNode.line as number | undefined,
        phase: 'ENRICHMENT',
        plugin: 'ArgumentParameterLinker',
        callId: callNode.id,
      },
      `Ensure the called function is imported or defined`
    );
    errors.push(error);
  }
  continue;
}
```

**Update return statement** (around line 218):

```typescript
return createSuccessResult(
  { nodes: 0, edges: edgesCreated },
  {
    callsProcessed,
    edgesCreated,
    unresolvedCalls,
    noParams,
    timeMs: Date.now() - startTime
  },
  errors
);
```

---

### 4.4 AliasTracker (packages/core/src/plugins/enrichment/AliasTracker.ts)

**File:** `/Users/vadimr/grafema-worker-6/packages/core/src/plugins/enrichment/AliasTracker.ts`

**Add import** at top:

```typescript
import { StrictModeError } from '../../errors/GrafemaError.js';
```

**Add errors array** at start of `execute()` (after `let resolvedToMethod = 0;`):

```typescript
const errors: Error[] = [];
```

**Update depth exceeded handling** (around line 186-195):

```typescript
// Alert if depth exceeded
if (this.depthExceeded.length > 0) {
  logger.warn('Alias chains exceeded max depth', {
    count: this.depthExceeded.length,
    maxDepth: AliasTracker.MAX_DEPTH,
    examples: this.depthExceeded.slice(0, 5).map(info => ({
      file: info.file,
      name: info.name,
      chain: info.chain.join(' -> ')
    }))
  });

  // In strict mode, report as errors
  if (context.strictMode) {
    for (const info of this.depthExceeded) {
      const error = new StrictModeError(
        `Alias chain exceeded max depth (${info.depth}): ${info.name}`,
        'STRICT_ALIAS_DEPTH_EXCEEDED',
        {
          filePath: info.file,
          phase: 'ENRICHMENT',
          plugin: 'AliasTracker',
          aliasName: info.name,
          chainLength: info.depth,
        },
        `Possible circular alias reference. Chain: ${info.chain.slice(0, 3).join(' -> ')}...`
      );
      errors.push(error);
    }
  }
}
```

**Update return statement** (around line 199):

```typescript
return createSuccessResult({ nodes: 0, edges: edgesCreated }, summary, errors);
```

---

## Part 5: Tests

### 5.1 Create Strict Mode Test File

**File:** `/Users/vadimr/grafema-worker-6/test/unit/StrictMode.test.js`

```javascript
/**
 * Strict Mode Tests
 *
 * Tests the strict mode functionality that causes analysis to fail
 * when enrichers cannot resolve references.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
  RFDBServerBackend,
  MethodCallResolver,
  FunctionCallResolver,
  ArgumentParameterLinker,
  AliasTracker,
  StrictModeError
} from '@grafema/core';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Strict Mode', () => {
  let testCounter = 0;

  async function setupBackend() {
    const testDir = join(tmpdir(), `grafema-test-strict-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    const backend = new RFDBServerBackend({ dbPath: join(testDir, 'test.db') });
    await backend.connect();

    return { backend, testDir };
  }

  describe('MethodCallResolver', () => {
    it('should return no errors in normal mode for unresolved method', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'unknown-call',
          type: 'CALL',
          name: 'unknownObj.doSomething',
          file: 'app.js',
          line: 5,
          object: 'unknownObj',
          method: 'doSomething'
        });

        await backend.flush();

        // Normal mode - should not report errors
        const result = await resolver.execute({ graph: backend, strictMode: false });

        assert.strictEqual(result.errors.length, 0, 'No errors in normal mode');
        assert.strictEqual(result.metadata.unresolved, 1, 'Should track unresolved');
      } finally {
        await backend.close();
      }
    });

    it('should return StrictModeError when strictMode=true and method unresolved', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'unknown-call',
          type: 'CALL',
          name: 'unknownObj.doSomething',
          file: 'app.js',
          line: 5,
          object: 'unknownObj',
          method: 'doSomething'
        });

        await backend.flush();

        // Strict mode - should report error
        const result = await resolver.execute({ graph: backend, strictMode: true });

        assert.strictEqual(result.errors.length, 1, 'Should have one error');
        assert.ok(result.errors[0] instanceof StrictModeError, 'Error should be StrictModeError');
        assert.strictEqual(result.errors[0].code, 'STRICT_UNRESOLVED_METHOD');
        assert.ok(result.errors[0].message.includes('unknownObj.doSomething'));
      } finally {
        await backend.close();
      }
    });

    it('should NOT report error for external methods even in strict mode', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'console-call',
          type: 'CALL',
          name: 'console.log',
          file: 'app.js',
          line: 5,
          object: 'console',
          method: 'log'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend, strictMode: true });

        assert.strictEqual(result.errors.length, 0, 'No errors for external methods');
      } finally {
        await backend.close();
      }
    });
  });

  describe('ArgumentParameterLinker', () => {
    it('should return StrictModeError when call has no CALLS edge in strict mode', async () => {
      const { backend } = await setupBackend();

      try {
        const linker = new ArgumentParameterLinker();

        // Call with arguments but no CALLS edge
        await backend.addNode({
          id: 'unresolved-call',
          type: 'CALL',
          name: 'unknownFunc',
          file: 'app.js',
          line: 10
        });

        // Argument node
        await backend.addNode({
          id: 'arg-1',
          type: 'LITERAL',
          value: 'test',
          file: 'app.js',
          line: 10
        });

        // PASSES_ARGUMENT edge
        await backend.addEdge({
          src: 'unresolved-call',
          dst: 'arg-1',
          type: 'PASSES_ARGUMENT',
          argIndex: 0
        });

        await backend.flush();

        const result = await linker.execute({ graph: backend, strictMode: true });

        assert.strictEqual(result.errors.length, 1, 'Should have one error');
        assert.ok(result.errors[0] instanceof StrictModeError);
        assert.strictEqual(result.errors[0].code, 'STRICT_UNRESOLVED_ARGUMENT');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Error collection (not fail-fast)', () => {
    it('should collect multiple errors before returning', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Multiple unresolved calls
        await backend.addNodes([
          {
            id: 'unknown-call-1',
            type: 'CALL',
            name: 'obj1.method1',
            file: 'app.js',
            line: 5,
            object: 'obj1',
            method: 'method1'
          },
          {
            id: 'unknown-call-2',
            type: 'CALL',
            name: 'obj2.method2',
            file: 'app.js',
            line: 10,
            object: 'obj2',
            method: 'method2'
          },
          {
            id: 'unknown-call-3',
            type: 'CALL',
            name: 'obj3.method3',
            file: 'app.js',
            line: 15,
            object: 'obj3',
            method: 'method3'
          }
        ]);

        await backend.flush();

        const result = await resolver.execute({ graph: backend, strictMode: true });

        // All errors should be collected
        assert.strictEqual(result.errors.length, 3, 'Should collect all 3 errors');
        assert.strictEqual(result.metadata.unresolved, 3, 'Should track all 3 unresolved');
      } finally {
        await backend.close();
      }
    });
  });
});
```

---

### 5.2 Test StrictModeError Class

**File:** `/Users/vadimr/grafema-worker-6/test/unit/errors/StrictModeError.test.js`

```javascript
/**
 * StrictModeError Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StrictModeError, GrafemaError } from '@grafema/core';

describe('StrictModeError', () => {
  it('should extend GrafemaError', () => {
    const error = new StrictModeError(
      'Test message',
      'STRICT_TEST',
      { filePath: 'test.js', lineNumber: 10 }
    );

    assert.ok(error instanceof GrafemaError);
    assert.ok(error instanceof Error);
  });

  it('should have severity=fatal', () => {
    const error = new StrictModeError('Test', 'STRICT_TEST');
    assert.strictEqual(error.severity, 'fatal');
  });

  it('should store code and context', () => {
    const error = new StrictModeError(
      'Cannot resolve method',
      'STRICT_UNRESOLVED_METHOD',
      {
        filePath: 'service.js',
        lineNumber: 42,
        phase: 'ENRICHMENT',
        plugin: 'MethodCallResolver'
      },
      'Check if the class is imported'
    );

    assert.strictEqual(error.code, 'STRICT_UNRESOLVED_METHOD');
    assert.strictEqual(error.context.filePath, 'service.js');
    assert.strictEqual(error.context.lineNumber, 42);
    assert.strictEqual(error.suggestion, 'Check if the class is imported');
  });

  it('should serialize to JSON correctly', () => {
    const error = new StrictModeError(
      'Test message',
      'STRICT_TEST',
      { filePath: 'test.js' },
      'Fix suggestion'
    );

    const json = error.toJSON();

    assert.strictEqual(json.code, 'STRICT_TEST');
    assert.strictEqual(json.severity, 'fatal');
    assert.strictEqual(json.message, 'Test message');
    assert.strictEqual(json.suggestion, 'Fix suggestion');
  });
});
```

---

## Part 6: Implementation Order

**Phase 1: Types (no tests needed)**
1. Add `strictMode` to `PluginContext` interface
2. Create `StrictModeError` class
3. Export `StrictModeError` from core

**Phase 2: Config & CLI**
4. Add `strict` to `GrafemaConfig`
5. Add `--strict` CLI flag
6. Pass `strictMode` to Orchestrator

**Phase 3: Orchestrator**
7. Add `strictMode` to `OrchestratorOptions`
8. Propagate to plugin context
9. Add phase barrier after ENRICHMENT

**Phase 4: Enrichers (with tests)**
10. Update MethodCallResolver + tests
11. Update ArgumentParameterLinker + tests
12. Update FunctionCallResolver + tests
13. Update AliasTracker + tests

**Phase 5: Integration Test**
14. End-to-end test with CLI

---

## Edge Cases to Handle

1. **External methods** (console.log, Math.random): NOT errors, even in strict mode
2. **Methods with CALLS edge already**: Skip, not an error
3. **Empty graph**: No errors (nothing to resolve)
4. **Multiple errors same file**: All collected, not just first
5. **Mixed resolved/unresolved**: Only unresolved reported

---

## Error Message Format

All strict mode errors follow this format:

```
[STRICT_UNRESOLVED_METHOD] Cannot resolve method call: obj.method at file.js:42
  Suggestion: Check if class "obj" is imported and has method "method"
```

The DiagnosticReporter already handles formatting based on the error's `toJSON()` output.

---

## Exit Codes

- `0`: Success (no errors, maybe warnings)
- `1`: Fatal errors (strict mode violations, or other fatal errors)
- `2`: Analysis completed with non-fatal errors

Strict mode violations are fatal, so exit code is `1`.

---

## Verification Checklist

After implementation, verify:

1. [ ] `grafema analyze` works normally (strict=false by default)
2. [ ] `grafema analyze --strict` on clean codebase succeeds
3. [ ] `grafema analyze --strict` on codebase with unresolved methods fails
4. [ ] Error messages show file, line, and suggestion
5. [ ] All errors collected (not fail-fast)
6. [ ] Exit code is 1 when strict mode fails
7. [ ] `strict: true` in config.yaml works
8. [ ] CLI `--strict` overrides config file
9. [ ] External methods (console.log) NOT reported

---

## Questions Resolved

**Q1 (Don): Should strict mode affect VALIDATION phase?**
**A1:** No, only ENRICHMENT. Validators already have their own error severity.

**Q2 (Don): Should we add --strict-summary flag?**
**A2:** Not in scope. Use `--verbose` to see details.

**Q3 (Don): Priority order for enricher updates?**
**A3:** MethodCallResolver first (clearest), then FunctionCallResolver, ArgumentParameterLinker, AliasTracker.

---

**Ready for Kent to write tests and Rob to implement.**
