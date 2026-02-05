# Joel Spolsky - Technical Specification: REG-332 Improve Strict Mode Error UX

**Date:** 2026-02-05
**Status:** Technical Spec
**Based On:** Don's plan `_tasks/REG-332/002-don-plan.md`

---

## Executive Summary

This specification expands Don's high-level plan into implementable steps. The work is organized into 4 phases corresponding to the 4 issues identified:

1. **Phase 1:** Deduplicate error messages (Issue 1)
2. **Phase 2:** Show resolution chain (Issue 3) - infrastructure for Phase 3
3. **Phase 3:** Context-aware suggestions (Issue 2)
4. **Phase 4:** grafema-ignore escape hatch (Issue 4)

**Total estimated effort:** 19-27 hours

---

## Phase 1: Deduplicate Error Messages

**Goal:** Eliminate the current duplication where the same error is printed twice.

### Root Cause Analysis

The duplication occurs in this flow:

```
1. MethodCallResolver creates StrictModeError
2. DiagnosticCollector.addFromPluginResult() stores it
3. Orchestrator.runPhase() line 732 throws: new Error("Fatal error in X: message")
4. analyze.ts line 398 prints: error.message
5. analyze.ts line 404 prints: reporter.report() which includes same diagnostic
```

Result: Same message appears twice with different formatting.

### Solution: StrictModeFailure Error Class

Create a new error class that carries the diagnostic without embedding it in the message.

#### File: `packages/core/src/errors/GrafemaError.ts`

**Add new class after `StrictModeError` (after line 239):**

```typescript
/**
 * StrictModeFailure - thrown when strict mode stops analysis due to fatal errors.
 *
 * Unlike other errors, this carries a reference to the fatal diagnostic(s)
 * rather than duplicating the message. The CLI formats output from
 * the diagnostic, not from error.message.
 *
 * This prevents the duplication issue where both error.message and
 * DiagnosticReporter show the same error.
 */
export class StrictModeFailure extends Error {
  /** The fatal diagnostics that caused the failure */
  readonly diagnostics: Diagnostic[];
  /** Error count for summary */
  readonly count: number;

  constructor(diagnostics: Diagnostic[]) {
    // Keep message minimal - CLI will format from diagnostics
    super(`Strict mode: ${diagnostics.length} unresolved reference(s) found`);
    this.name = 'StrictModeFailure';
    this.diagnostics = diagnostics;
    this.count = diagnostics.length;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
```

**Add import at top of file (after line 16):**

```typescript
import type { Diagnostic } from '../diagnostics/DiagnosticCollector.js';
```

#### File: `packages/core/src/Orchestrator.ts`

**Replace lines 423-442** (the strict mode barrier) with:

```typescript
    // STRICT MODE BARRIER: Check for fatal errors after ENRICHMENT (REG-330)
    if (this.strictMode) {
      const enrichmentDiagnostics = this.diagnosticCollector.getByPhase('ENRICHMENT');
      const strictErrors = enrichmentDiagnostics.filter(d => d.severity === 'fatal');

      if (strictErrors.length > 0) {
        this.logger.error(`Strict mode: ${strictErrors.length} unresolved reference(s) found`);
        // Throw StrictModeFailure with diagnostics - CLI will format
        throw new StrictModeFailure(strictErrors);
      }
    }
```

**Add import at top of file:**

```typescript
import { StrictModeFailure } from './errors/GrafemaError.js';
```

#### File: `packages/cli/src/commands/analyze.ts`

**Replace lines 385-415** (the catch block) with:

```typescript
    } catch (e) {
      // Stop stats polling on error
      if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
      }

      const diagnostics = orchestrator.getDiagnostics();
      const reporter = new DiagnosticReporter(diagnostics);

      // Clear progress line in interactive mode
      if (renderer && process.stdout.isTTY) {
        process.stdout.write('\r\x1b[K');
      }

      // Check if this is a strict mode failure (structured output)
      if (e instanceof StrictModeFailure) {
        // Format ONLY from diagnostics, not from error.message
        console.error('');
        console.error(`Strict mode: ${e.count} unresolved reference(s) found during ENRICHMENT.`);
        console.error('');
        console.error(reporter.formatStrict(e.diagnostics));
        console.error('');
        console.error('Run without --strict for graceful degradation, or fix the underlying issues.');
      } else {
        // Generic error handling (non-strict)
        const error = e instanceof Error ? e : new Error(String(e));
        console.error('');
        console.error(`Analysis failed: ${error.message}`);
        console.error('');
        console.error('Run with --debug for detailed diagnostics');

        if (diagnostics.count() > 0) {
          console.error('');
          console.error(reporter.report({ format: 'text', includeSummary: true }));
        }
      }

      // Write diagnostics.log in debug mode even on failure
      if (options.debug) {
        const writer = new DiagnosticWriter();
        await writer.write(diagnostics, grafemaDir);
        console.error(`Diagnostics written to ${writer.getLogPath(grafemaDir)}`);
      }

      exitCode = 1;
    }
```

**Add import:**

```typescript
import { StrictModeFailure } from '@grafema/core';
```

#### File: `packages/core/src/diagnostics/DiagnosticReporter.ts`

**Add new method for strict mode formatting (after line 200):**

```typescript
  /**
   * Format strict mode errors with enhanced context.
   * Shows resolution chain and context-aware suggestions.
   *
   * @param diagnostics - The fatal diagnostics from strict mode
   * @returns Formatted string for CLI output
   */
  formatStrict(diagnostics: Diagnostic[]): string {
    const lines: string[] = [];

    for (const diag of diagnostics) {
      // Header: CODE file:line
      const location = diag.file
        ? diag.line
          ? `${diag.file}:${diag.line}`
          : diag.file
        : '';
      lines.push(`${diag.code} ${location}`);
      lines.push('');

      // Message
      lines.push(`  ${diag.message}`);

      // Suggestion (if present)
      if (diag.suggestion) {
        lines.push('');
        lines.push(`  Suggestion: ${diag.suggestion}`);
      }

      lines.push('');
      lines.push('---');
      lines.push('');
    }

    // Remove trailing separator
    if (lines.length > 0) {
      lines.splice(-3);
    }

    return lines.join('\n');
  }
```

### Complexity Analysis

- **Time:** O(n) where n = number of diagnostics
- **Space:** O(n) for storing diagnostics array
- No additional iterations over graph nodes

### Test Specifications for Phase 1

**File:** `test/unit/errors/StrictModeFailure.test.ts`

```typescript
describe('StrictModeFailure', () => {
  it('should store diagnostics array', () => {
    const diagnostics = [createDiagnostic({ code: 'STRICT_UNRESOLVED_METHOD' })];
    const error = new StrictModeFailure(diagnostics);
    assert.strictEqual(error.diagnostics.length, 1);
    assert.strictEqual(error.count, 1);
  });

  it('should have minimal message (no duplication)', () => {
    const diagnostics = [createDiagnostic({ message: 'detailed message here' })];
    const error = new StrictModeFailure(diagnostics);
    // Message should NOT contain the detailed diagnostic message
    assert.ok(!error.message.includes('detailed message here'));
    assert.ok(error.message.includes('1 unresolved reference'));
  });

  it('should be instanceof Error', () => {
    const error = new StrictModeFailure([]);
    assert.ok(error instanceof Error);
  });
});
```

**File:** `test/unit/diagnostics/DiagnosticReporter.test.ts` (add to existing)

```typescript
describe('formatStrict()', () => {
  it('should format diagnostic with location', () => {
    const diagnostics = [{
      code: 'STRICT_UNRESOLVED_METHOD',
      severity: 'fatal' as const,
      message: 'Cannot resolve method call: user.processData',
      file: '/tmp/test.js',
      line: 3,
      phase: 'ENRICHMENT' as const,
      plugin: 'MethodCallResolver',
      timestamp: Date.now(),
      suggestion: 'Check if class is imported',
    }];

    const collector = new DiagnosticCollector();
    const reporter = new DiagnosticReporter(collector);
    const output = reporter.formatStrict(diagnostics);

    assert.ok(output.includes('STRICT_UNRESOLVED_METHOD'));
    assert.ok(output.includes('/tmp/test.js:3'));
    assert.ok(output.includes('Cannot resolve method call'));
    assert.ok(output.includes('Suggestion:'));
  });

  it('should handle multiple diagnostics', () => {
    const diagnostics = [
      createDiagnostic({ code: 'ERROR_1' }),
      createDiagnostic({ code: 'ERROR_2' }),
    ];

    const collector = new DiagnosticCollector();
    const reporter = new DiagnosticReporter(collector);
    const output = reporter.formatStrict(diagnostics);

    assert.ok(output.includes('ERROR_1'));
    assert.ok(output.includes('ERROR_2'));
  });

  it('should handle diagnostic without file info', () => {
    const diagnostics = [{
      code: 'STRICT_ERROR',
      severity: 'fatal' as const,
      message: 'Some error',
      phase: 'ENRICHMENT' as const,
      plugin: 'TestPlugin',
      timestamp: Date.now(),
    }];

    const collector = new DiagnosticCollector();
    const reporter = new DiagnosticReporter(collector);

    // Should not throw
    const output = reporter.formatStrict(diagnostics);
    assert.ok(output.includes('STRICT_ERROR'));
  });
});
```

---

## Phase 2: Show Resolution Chain

**Goal:** Build infrastructure for tracking what DID resolve before failure.

### Interface Changes

#### File: `packages/core/src/errors/GrafemaError.ts`

**Update ErrorContext interface (lines 21-27):**

```typescript
/**
 * Context for error reporting
 */
export interface ErrorContext {
  filePath?: string;
  lineNumber?: number;
  phase?: PluginPhase;
  plugin?: string;
  /** Resolution chain showing what was resolved before failure (REG-332) */
  resolutionChain?: ResolutionStep[];
  /** Reason why resolution failed (REG-332) */
  failureReason?: ResolutionFailureReason;
  [key: string]: unknown;
}

/**
 * A step in the resolution chain showing what was resolved
 */
export interface ResolutionStep {
  /** Description of what was resolved, e.g., "getUser() return" */
  step: string;
  /** Result of resolution, e.g., "unknown" or "User class" */
  result: string;
  /** File where this step occurred */
  file?: string;
  /** Line number */
  line?: number;
}

/**
 * Reasons why resolution can fail
 */
export type ResolutionFailureReason =
  | 'unknown_object_type'      // getUser() return unknown
  | 'class_not_imported'       // User class not in scope
  | 'method_not_found'         // Class exists but no such method
  | 'external_dependency'      // From node_modules
  | 'circular_reference'       // Alias chain too deep
  | 'builtin_method'           // Built-in prototype method (not an error)
  | 'unknown';                 // Catch-all
```

#### File: `packages/core/src/diagnostics/DiagnosticCollector.ts`

**Update Diagnostic interface (lines 25-35):**

```typescript
/**
 * Diagnostic entry - unified format for all errors/warnings
 */
export interface Diagnostic {
  code: string;
  severity: 'fatal' | 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  phase: PluginPhase;
  plugin: string;
  timestamp: number;
  suggestion?: string;
  /** Resolution chain for context (REG-332) */
  resolutionChain?: ResolutionStep[];
  /** Failure reason for context-aware suggestions (REG-332) */
  failureReason?: ResolutionFailureReason;
}
```

**Update addFromPluginResult method (lines 54-78) to pass new fields:**

```typescript
  addFromPluginResult(phase: PluginPhase, plugin: string, result: PluginResult): void {
    for (const error of result.errors) {
      if (error instanceof GrafemaError) {
        this.add({
          code: error.code,
          severity: error.severity,
          message: error.message,
          file: error.context.filePath,
          line: error.context.lineNumber,
          phase,
          plugin,
          suggestion: error.suggestion,
          // REG-332: Pass through resolution context
          resolutionChain: error.context.resolutionChain,
          failureReason: error.context.failureReason,
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

#### File: `packages/core/src/diagnostics/DiagnosticReporter.ts`

**Update formatStrict method to show chain:**

```typescript
  /**
   * Format strict mode errors with enhanced context.
   * Shows resolution chain and context-aware suggestions.
   */
  formatStrict(diagnostics: Diagnostic[]): string {
    const lines: string[] = [];

    for (const diag of diagnostics) {
      // Header: CODE file:line
      const location = diag.file
        ? diag.line
          ? `${diag.file}:${diag.line}`
          : diag.file
        : '';
      lines.push(`${diag.code} ${location}`);
      lines.push('');

      // Message
      lines.push(`  ${diag.message}`);

      // Resolution chain (if present)
      if (diag.resolutionChain && diag.resolutionChain.length > 0) {
        lines.push('');
        lines.push('  Resolution chain:');
        for (const step of diag.resolutionChain) {
          const stepLocation = step.file
            ? step.line
              ? ` (${step.file}:${step.line})`
              : ` (${step.file})`
            : '';
          lines.push(`    ${step.step} -> ${step.result}${stepLocation}`);
        }
      }

      // Suggestion (if present)
      if (diag.suggestion) {
        lines.push('');
        lines.push(`  Suggestion: ${diag.suggestion}`);
      }

      lines.push('');
      lines.push('---');
      lines.push('');
    }

    // Remove trailing separator
    if (lines.length > 0) {
      lines.splice(-3);
    }

    return lines.join('\n');
  }
```

### Complexity Analysis

- **Time:** O(c) where c = length of resolution chain (typically < 10 steps)
- **Space:** O(c) for storing chain steps
- Chain is built during resolution, not by additional graph traversal

### Test Specifications for Phase 2

**File:** `test/unit/diagnostics/DiagnosticReporter.test.ts` (extend formatStrict tests)

```typescript
describe('formatStrict() with resolution chain', () => {
  it('should display resolution chain', () => {
    const diagnostics = [{
      code: 'STRICT_UNRESOLVED_METHOD',
      severity: 'fatal' as const,
      message: 'Cannot resolve method call: user.processData',
      file: '/tmp/test.js',
      line: 3,
      phase: 'ENRICHMENT' as const,
      plugin: 'MethodCallResolver',
      timestamp: Date.now(),
      suggestion: 'Add return type to getUser()',
      resolutionChain: [
        { step: 'getUser() return', result: 'unknown (not declared)', file: '/tmp/test.js', line: 1 },
        { step: 'user variable', result: 'inherits unknown type' },
        { step: 'user.processData', result: 'FAILED (no type information)' },
      ],
    }];

    const collector = new DiagnosticCollector();
    const reporter = new DiagnosticReporter(collector);
    const output = reporter.formatStrict(diagnostics);

    assert.ok(output.includes('Resolution chain:'));
    assert.ok(output.includes('getUser() return -> unknown'));
    assert.ok(output.includes('user variable -> inherits unknown'));
    assert.ok(output.includes('FAILED'));
  });

  it('should handle empty resolution chain', () => {
    const diagnostics = [{
      code: 'STRICT_UNRESOLVED_METHOD',
      severity: 'fatal' as const,
      message: 'Some error',
      phase: 'ENRICHMENT' as const,
      plugin: 'TestPlugin',
      timestamp: Date.now(),
      resolutionChain: [],
    }];

    const collector = new DiagnosticCollector();
    const reporter = new DiagnosticReporter(collector);
    const output = reporter.formatStrict(diagnostics);

    assert.ok(!output.includes('Resolution chain:'));
  });
});
```

---

## Phase 3: Context-Aware Suggestions

**Goal:** Generate suggestions based on WHY resolution failed, not just THAT it failed.

### File: `packages/core/src/plugins/enrichment/MethodCallResolver.ts`

**Add helper function after line 700:**

```typescript
/**
 * Generate context-aware suggestion based on failure reason and chain.
 */
private generateContextualSuggestion(
  object: string,
  method: string,
  reason: ResolutionFailureReason,
  chain: ResolutionStep[]
): string {
  switch (reason) {
    case 'unknown_object_type': {
      // Find the source in chain
      const source = chain.find(s => s.result.includes('unknown'));
      const sourceDesc = source?.step || 'the source';
      return `Variable "${object}" comes from ${sourceDesc} which has unknown return type. ` +
             `Add JSDoc: /** @returns {{${method}: Function}} */`;
    }

    case 'class_not_imported':
      return `Class "${object}" is not imported. Check your imports or ensure the class is defined.`;

    case 'method_not_found': {
      // Chain might have available methods
      const classStep = chain.find(s => s.result.includes('class'));
      return `Class "${object}" exists but has no method "${method}". ` +
             `Check spelling or if the method is defined.`;
    }

    case 'external_dependency':
      return `This call is to an external library ("${object}"). ` +
             `Consider adding type stubs or a dedicated analyzer plugin.`;

    case 'circular_reference':
      return `Alias chain for "${object}" is too deep (possible cycle). ` +
             `Simplify variable assignments or check for circular references.`;

    default:
      return `Check if class "${object}" is imported and has method "${method}"`;
  }
}

/**
 * Determine why method resolution failed.
 * Returns reason and partial chain of what DID resolve.
 */
private analyzeResolutionFailure(
  methodCall: MethodCallNode,
  classMethodIndex: Map<string, ClassEntry>,
  variableTypes: Map<string, string>
): { reason: ResolutionFailureReason; chain: ResolutionStep[] } {
  const { object, method, file } = methodCall;
  const chain: ResolutionStep[] = [];

  if (!object || !method) {
    return { reason: 'unknown', chain };
  }

  // Check if object is a known class name
  if (classMethodIndex.has(object!)) {
    const classEntry = classMethodIndex.get(object!)!;
    chain.push({
      step: `${object} class lookup`,
      result: 'found',
      file: classEntry.classNode.file as string | undefined,
      line: classEntry.classNode.line as number | undefined,
    });

    if (!classEntry.methods.has(method!)) {
      chain.push({
        step: `${object}.${method} method`,
        result: 'NOT FOUND in class',
      });
      return { reason: 'method_not_found', chain };
    }
  }

  // Check if object is in local scope
  const localKey = `${file}:${object}`;
  if (classMethodIndex.has(localKey)) {
    const classEntry = classMethodIndex.get(localKey)!;
    chain.push({
      step: `${object} local class`,
      result: 'found in same file',
    });

    if (!classEntry.methods.has(method!)) {
      chain.push({
        step: `${object}.${method} method`,
        result: 'NOT FOUND',
      });
      return { reason: 'method_not_found', chain };
    }
  }

  // If we get here, object type is unknown
  chain.push({
    step: `${object} type lookup`,
    result: 'unknown (not in class index)',
  });
  chain.push({
    step: `${object}.${method}`,
    result: 'FAILED (no type information)',
  });

  return { reason: 'unknown_object_type', chain };
}
```

**Update the unresolved error creation (around line 370-388):**

Replace the existing error creation with:

```typescript
      if (targetMethod) {
        await graph.addEdge({
          src: methodCall.id,
          dst: targetMethod.id,
          type: 'CALLS'
        });
        edgesCreated++;
      } else {
        unresolved++;

        // In strict mode, collect error with context-aware suggestion
        if (context.strictMode) {
          // Analyze WHY resolution failed
          const { reason, chain } = this.analyzeResolutionFailure(
            methodCall,
            classMethodIndex,
            variableTypes
          );

          // Generate context-aware suggestion
          const suggestion = this.generateContextualSuggestion(
            methodCall.object!,
            methodCall.method!,
            reason,
            chain
          );

          const error = new StrictModeError(
            `Cannot resolve method call: ${methodCall.object}.${methodCall.method}`,
            'STRICT_UNRESOLVED_METHOD',
            {
              filePath: methodCall.file,
              lineNumber: methodCall.line as number | undefined,
              phase: 'ENRICHMENT',
              plugin: 'MethodCallResolver',
              object: methodCall.object,
              method: methodCall.method,
              resolutionChain: chain,
              failureReason: reason,
            },
            suggestion
          );
          errors.push(error);
        }
      }
```

**Add import at top of file:**

```typescript
import type { ResolutionStep, ResolutionFailureReason } from '../../errors/GrafemaError.js';
```

### Complexity Analysis

- **Time:** O(1) for suggestion generation (switch statement)
- **Time:** O(k) for failure analysis where k = number of lookups (typically < 5)
- No additional graph iterations - uses already-built indexes

### Test Specifications for Phase 3

**File:** `test/unit/plugins/enrichment/MethodCallResolver.test.ts` (add new describe block)

```typescript
describe('context-aware suggestions', () => {
  it('should suggest JSDoc for unknown return type', async () => {
    // Setup: function getUser() with no return type, call user.processData()
    const graph = createMockGraph();
    const resolver = new MethodCallResolver();

    // ... test setup with unresolved method call ...

    const result = await resolver.execute({
      graph,
      strictMode: true,
      logger: createLogger('silent'),
    });

    const error = result.errors[0] as StrictModeError;
    assert.ok(error.suggestion?.includes('JSDoc'));
    assert.ok(error.context.failureReason === 'unknown_object_type');
  });

  it('should suggest checking imports for missing class', async () => {
    // Setup: call SomeClass.method() where SomeClass is not defined
    // ...
    const error = result.errors[0] as StrictModeError;
    assert.ok(error.suggestion?.includes('imported'));
  });

  it('should suggest checking spelling for missing method', async () => {
    // Setup: class exists but method doesn't
    // ...
    const error = result.errors[0] as StrictModeError;
    assert.ok(error.context.failureReason === 'method_not_found');
    assert.ok(error.suggestion?.includes('spelling'));
  });

  it('should include resolution chain', async () => {
    // ...
    const error = result.errors[0] as StrictModeError;
    assert.ok(error.context.resolutionChain);
    assert.ok(error.context.resolutionChain.length > 0);
  });
});
```

---

## Phase 4: grafema-ignore Escape Hatch

**Goal:** Allow users to suppress known false positives with comments.

### Comment Syntax

```javascript
// grafema-ignore-next-line STRICT_UNRESOLVED_METHOD
user.processData();

// grafema-ignore STRICT_UNRESOLVED_METHOD - known library call
someLibrary.unknownMethod();
```

### Implementation Approach

#### Phase 4a: Parse ignore comments during INDEXING

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

Add comment parsing to the visitor that creates CALL nodes.

**Add constant after imports:**

```typescript
/**
 * Pattern for grafema-ignore comments
 * Matches: // grafema-ignore-next-line CODE
 *          // grafema-ignore CODE
 *          // grafema-ignore CODE - optional reason
 */
const GRAFEMA_IGNORE_PATTERN = /grafema-ignore(?:-next-line)?\s+([\w_]+)(?:\s+-\s+(.+))?/;
```

**Add helper function:**

```typescript
/**
 * Check if a node has a grafema-ignore comment for the given code.
 * Looks at leadingComments on the node.
 */
function getGrafemaIgnore(node: t.Node): { code: string; reason?: string } | null {
  const comments = (node as { leadingComments?: t.Comment[] }).leadingComments;
  if (!comments || comments.length === 0) return null;

  // Check last comment (closest to the node)
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    const text = comment.value.trim();
    const match = text.match(GRAFEMA_IGNORE_PATTERN);
    if (match) {
      return {
        code: match[1],
        reason: match[2],
      };
    }
  }

  return null;
}
```

**Update CALL node creation** (find where CALL nodes are created, typically in CallExpression visitor):

```typescript
// When creating CALL node:
const callNode = NodeFactory.createCall(callee, args, file, line, column, {
  // ... existing metadata ...
  grafemaIgnore: getGrafemaIgnore(path.node),
});
```

#### Phase 4b: Check ignore in enrichers

**File:** `packages/core/src/plugins/enrichment/MethodCallResolver.ts`

**Update the resolution loop (around line 306):**

```typescript
    for (const methodCall of methodCalls) {
      methodCallsProcessed++;

      // ... progress reporting ...

      // Check for grafema-ignore annotation (REG-332)
      const ignoreAnnotation = methodCall.metadata?.grafemaIgnore as { code: string; reason?: string } | undefined;
      if (ignoreAnnotation?.code === 'STRICT_UNRESOLVED_METHOD') {
        logger.debug('Suppressed by grafema-ignore', {
          call: `${methodCall.object}.${methodCall.method}`,
          reason: ignoreAnnotation.reason,
        });
        externalSkipped++; // Count as skipped, not unresolved
        continue;
      }

      // ... rest of existing logic ...
```

### Complexity Analysis

- **Time:** O(c) per node where c = number of leading comments (typically 0-3)
- **Space:** O(1) per ignore annotation stored in metadata
- No additional graph iterations

### Test Specifications for Phase 4

**File:** `test/unit/plugins/analysis/JSASTAnalyzer.grafemaIgnore.test.ts`

```typescript
describe('grafema-ignore comment parsing', () => {
  it('should parse grafema-ignore-next-line comment', async () => {
    const code = `
      // grafema-ignore-next-line STRICT_UNRESOLVED_METHOD
      user.processData();
    `;

    const result = await analyzeCode(code);
    const callNode = findCallNode(result, 'processData');

    assert.ok(callNode.metadata?.grafemaIgnore);
    assert.strictEqual(callNode.metadata.grafemaIgnore.code, 'STRICT_UNRESOLVED_METHOD');
  });

  it('should parse grafema-ignore with reason', async () => {
    const code = `
      // grafema-ignore STRICT_UNRESOLVED_METHOD - known external API
      api.call();
    `;

    const result = await analyzeCode(code);
    const callNode = findCallNode(result, 'call');

    assert.strictEqual(callNode.metadata.grafemaIgnore.code, 'STRICT_UNRESOLVED_METHOD');
    assert.strictEqual(callNode.metadata.grafemaIgnore.reason, 'known external API');
  });

  it('should not match invalid format', async () => {
    const code = `
      // grafema-skip STRICT_UNRESOLVED_METHOD
      user.processData();
    `;

    const result = await analyzeCode(code);
    const callNode = findCallNode(result, 'processData');

    assert.ok(!callNode.metadata?.grafemaIgnore);
  });

  it('should require specifying error code', async () => {
    const code = `
      // grafema-ignore-next-line
      user.processData();
    `;

    const result = await analyzeCode(code);
    const callNode = findCallNode(result, 'processData');

    // Should not match - code is required
    assert.ok(!callNode.metadata?.grafemaIgnore);
  });
});
```

**File:** `test/unit/plugins/enrichment/MethodCallResolver.grafemaIgnore.test.ts`

```typescript
describe('grafema-ignore suppression', () => {
  it('should skip error when grafema-ignore matches', async () => {
    const graph = createMockGraph();

    // Add CALL node with grafema-ignore metadata
    await graph.addNode({
      id: 'call:1',
      type: 'CALL',
      object: 'user',
      method: 'processData',
      metadata: {
        grafemaIgnore: { code: 'STRICT_UNRESOLVED_METHOD' },
      },
    });

    const resolver = new MethodCallResolver();
    const result = await resolver.execute({
      graph,
      strictMode: true,
      logger: createLogger('silent'),
    });

    // Should not have errors for this call
    assert.strictEqual(result.errors.length, 0);
  });

  it('should NOT skip when grafema-ignore code does not match', async () => {
    const graph = createMockGraph();

    await graph.addNode({
      id: 'call:1',
      type: 'CALL',
      object: 'user',
      method: 'processData',
      metadata: {
        grafemaIgnore: { code: 'SOME_OTHER_CODE' }, // Different code
      },
    });

    const resolver = new MethodCallResolver();
    const result = await resolver.execute({
      graph,
      strictMode: true,
      logger: createLogger('silent'),
    });

    // Should still have error - ignore code doesn't match
    assert.ok(result.errors.length > 0);
  });

  it('should log suppression in debug mode', async () => {
    const logs: string[] = [];
    const logger = {
      debug: (msg: string) => logs.push(msg),
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    // ... setup with grafema-ignore ...

    assert.ok(logs.some(l => l.includes('Suppressed')));
  });
});
```

---

## Export Updates

### File: `packages/core/src/index.ts`

Add exports for new types:

```typescript
// Errors
export {
  GrafemaError,
  ConfigError,
  FileAccessError,
  LanguageError,
  DatabaseError,
  PluginError,
  AnalysisError,
  ValidationError,
  StrictModeError,
  StrictModeFailure,  // NEW
  type ErrorContext,
  type GrafemaErrorJSON,
  type ResolutionStep,        // NEW
  type ResolutionFailureReason, // NEW
} from './errors/GrafemaError.js';
```

---

## Implementation Order Summary

| Phase | Files Modified | New Files | Estimated Hours |
|-------|---------------|-----------|-----------------|
| 1: Deduplicate | GrafemaError.ts, Orchestrator.ts, analyze.ts, DiagnosticReporter.ts | StrictModeFailure.test.ts | 2-3 |
| 2: Chain Infrastructure | GrafemaError.ts, DiagnosticCollector.ts, DiagnosticReporter.ts | - | 3-4 |
| 3: Context-Aware | MethodCallResolver.ts | - | 4-6 |
| 4: grafema-ignore | JSASTAnalyzer.ts, MethodCallResolver.ts | grafemaIgnore tests | 4-6 |
| Tests | - | Multiple test files | 4-6 |
| Documentation | - | - | 2 |
| **Total** | | | **19-27** |

---

## Risk Mitigations

### Risk 1: grafema-ignore comment parsing edge cases

**Mitigation:**
- Use strict regex pattern requiring error code
- Only check `leadingComments` (not trailing)
- Test multi-line comments, nested comments
- Test comments with special characters

### Risk 2: Chain tracking performance impact

**Mitigation:**
- Chain is only built when resolution fails (not on success path)
- Chain length is bounded (max ~10 steps typically)
- Uses existing indexes, no additional graph queries

### Risk 3: Backward compatibility with CI integrations

**Mitigation:**
- JSON output format unchanged (new fields are optional)
- Exit codes unchanged (0 = success, 1 = fatal, 2 = errors)
- Text format changes are additive (more info, same structure)

### Risk 4: Export changes breaking external code

**Mitigation:**
- New types are additions, not changes
- StrictModeFailure extends Error (standard interface)
- Test imports in CLI package to verify exports work

---

## Verification Checklist

Before marking complete:

1. [ ] `npm test` passes
2. [ ] `npm run build` succeeds
3. [ ] Error output no longer duplicates (visual check)
4. [ ] Resolution chain appears in output (visual check)
5. [ ] Suggestions are context-specific (visual check)
6. [ ] grafema-ignore suppresses errors (manual test)
7. [ ] JSON output is valid and parseable
8. [ ] Exit codes correct (0/1/2)

---

## Next Steps

1. **Steve + Vadim review** this spec for vision alignment
2. **Kent Beck** writes tests per specifications above
3. **Rob Pike** implements per this spec
4. **Demo** by Steve Jobs to verify UX improvement
