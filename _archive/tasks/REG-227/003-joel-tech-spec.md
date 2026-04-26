# REG-227: Joel Spolsky - Technical Specification

## Executive Summary

Update `CallResolverValidator` to correctly categorize call resolution outcomes and only report truly unresolved calls as warnings (not errors).

**Key insight from Don's analysis**: The `resolutionType` attribute does NOT exist on CALL nodes. Rather than modify multiple resolvers, the validator will detect resolution types at validation time using the same logic as ExternalCallResolver.

---

## Files to Modify

### 1. `/packages/core/src/data/builtins/jsGlobals.ts` (NEW FILE)

Create a shared constant for JS built-in global functions.

### 2. `/packages/core/src/data/builtins/index.ts`

Export the new JS_GLOBAL_FUNCTIONS set.

### 3. `/packages/core/src/plugins/enrichment/ExternalCallResolver.ts`

Import JS_GLOBAL_FUNCTIONS from shared location instead of local definition.

### 4. `/packages/core/src/plugins/validation/CallResolverValidator.ts`

Complete rewrite of validation logic to:
- Detect resolution type (internal, external, builtin, unresolved)
- Only report unresolved as warnings
- Update summary structure

### 5. `/Users/vadimr/grafema-worker-7/test/unit/CallResolverValidator.test.js`

Add new tests and update existing tests.

---

## Detailed Implementation

### Step 1: Create shared JS_GLOBAL_FUNCTIONS constant

**File**: `/packages/core/src/data/builtins/jsGlobals.ts`

```typescript
/**
 * JavaScript Global Functions (REG-227)
 *
 * These are functions intrinsic to the JS runtime that don't need CALLS edges.
 * They're available in all JS environments (browser, Node.js, etc.) and aren't
 * "callable definitions" in the code sense.
 *
 * What is NOT included:
 * - Constructors (Array, Object, Error) - handled as constructor calls
 * - Objects with methods (Math, JSON) - method calls go through MethodCallResolver
 * - Environment globals (window, document) - not functions, they're objects
 *
 * Used by:
 * - ExternalCallResolver: skips these when resolving external calls
 * - CallResolverValidator: recognizes these as resolved (no violation)
 */
export const JS_GLOBAL_FUNCTIONS = new Set([
  // Global functions (truly called as standalone functions)
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',

  // Timers (global functions in browser & Node.js)
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',

  // CommonJS (special case - global in CJS environments)
  'require'
]);
```

### Step 2: Update builtins index.ts

**File**: `/packages/core/src/data/builtins/index.ts`

Add export at line 10:

```typescript
export { JS_GLOBAL_FUNCTIONS } from './jsGlobals.js';
```

### Step 3: Update ExternalCallResolver.ts

**File**: `/packages/core/src/plugins/enrichment/ExternalCallResolver.ts`

**Change 1**: Remove local JS_BUILTINS definition (lines 57-68)

**Change 2**: Add import at top (after line 26):

```typescript
import { JS_GLOBAL_FUNCTIONS } from '../../data/builtins/index.js';
```

**Change 3**: Replace `JS_BUILTINS` with `JS_GLOBAL_FUNCTIONS` at line 169:

```typescript
// Before:
if (JS_BUILTINS.has(calledName)) {

// After:
if (JS_GLOBAL_FUNCTIONS.has(calledName)) {
```

### Step 4: Rewrite CallResolverValidator.ts

**File**: `/packages/core/src/plugins/validation/CallResolverValidator.ts`

Complete replacement:

```typescript
/**
 * CallResolverValidator - validates function call resolution (REG-227)
 *
 * Checks that all function calls are properly resolved:
 * - Internal calls: CALLS edge to FUNCTION node
 * - External calls: CALLS edge to EXTERNAL_MODULE node
 * - Builtin calls: recognized by name (no edge needed)
 * - Unresolved: no edge, not builtin -> WARNING
 *
 * This validator runs AFTER FunctionCallResolver and ExternalCallResolver
 * to verify resolution quality and report issues.
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord, EdgeRecord } from '@grafema/types';
import { ValidationError } from '../../errors/GrafemaError.js';
import { JS_GLOBAL_FUNCTIONS } from '../../data/builtins/index.js';

/**
 * Resolution type for a CALL node
 */
type ResolutionType = 'internal' | 'external' | 'builtin' | 'method' | 'unresolved';

/**
 * Call node with optional attributes
 */
interface CallNode extends NodeRecord {
  object?: string; // If present, this is a method call
}

/**
 * Validation summary showing resolution breakdown
 */
interface ValidationSummary {
  totalCalls: number;
  resolvedInternal: number;   // CALLS -> FUNCTION
  resolvedExternal: number;   // CALLS -> EXTERNAL_MODULE
  resolvedBuiltin: number;    // Name in JS_GLOBAL_FUNCTIONS
  methodCalls: number;        // Has 'object' attribute (not validated)
  unresolvedCalls: number;    // No edge, not builtin
  warnings: number;           // = unresolvedCalls
}

export class CallResolverValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'CallResolverValidator',
      phase: 'VALIDATION',
      priority: 90,
      creates: {
        nodes: [],
        edges: []
      },
      dependencies: ['FunctionCallResolver', 'ExternalCallResolver']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    logger.info('Starting call resolution validation');

    const warnings: ValidationError[] = [];
    const summary: ValidationSummary = {
      totalCalls: 0,
      resolvedInternal: 0,
      resolvedExternal: 0,
      resolvedBuiltin: 0,
      methodCalls: 0,
      unresolvedCalls: 0,
      warnings: 0
    };

    // Process all CALL nodes
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      summary.totalCalls++;
      const callNode = node as CallNode;

      const resolutionType = await this.determineResolutionType(graph, callNode);

      switch (resolutionType) {
        case 'internal':
          summary.resolvedInternal++;
          break;
        case 'external':
          summary.resolvedExternal++;
          break;
        case 'builtin':
          summary.resolvedBuiltin++;
          break;
        case 'method':
          summary.methodCalls++;
          break;
        case 'unresolved':
          summary.unresolvedCalls++;
          summary.warnings++;
          warnings.push(this.createWarning(callNode));
          break;
      }
    }

    logger.info('Validation complete', { ...summary });

    if (warnings.length > 0) {
      logger.warn('Unresolved calls detected', { count: warnings.length });
      for (const warning of warnings.slice(0, 10)) {
        logger.warn(warning.message);
      }
      if (warnings.length > 10) {
        logger.debug(`... and ${warnings.length - 10} more`);
      }
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },
      { summary },
      warnings
    );
  }

  /**
   * Determine the resolution type for a CALL node.
   *
   * Resolution priority:
   * 1. Method call (has 'object' attribute) -> 'method'
   * 2. Has CALLS edge to FUNCTION -> 'internal'
   * 3. Has CALLS edge to EXTERNAL_MODULE -> 'external'
   * 4. Name in JS_GLOBAL_FUNCTIONS -> 'builtin'
   * 5. Otherwise -> 'unresolved'
   */
  private async determineResolutionType(
    graph: PluginContext['graph'],
    callNode: CallNode
  ): Promise<ResolutionType> {
    // 1. Check if method call (has object attribute)
    if (callNode.object) {
      return 'method';
    }

    // 2. Check for CALLS edges
    const edges = await graph.getOutgoingEdges(callNode.id, ['CALLS']);
    if (edges.length > 0) {
      // Determine destination type
      const edge = edges[0];
      const dstNode = await graph.getNode(edge.dst);

      if (dstNode) {
        if (dstNode.type === 'FUNCTION') {
          return 'internal';
        }
        if (dstNode.type === 'EXTERNAL_MODULE') {
          return 'external';
        }
      }

      // Has edge but unknown destination type - treat as resolved
      return 'internal';
    }

    // 3. Check if builtin
    const calledName = callNode.name as string;
    if (calledName && JS_GLOBAL_FUNCTIONS.has(calledName)) {
      return 'builtin';
    }

    // 4. Unresolved
    return 'unresolved';
  }

  /**
   * Create a warning for an unresolved call.
   */
  private createWarning(callNode: CallNode): ValidationError {
    return new ValidationError(
      `Unresolved call to "${callNode.name}" at ${callNode.file}:${callNode.line || '?'}`,
      'WARN_UNRESOLVED_CALL',
      {
        filePath: callNode.file,
        lineNumber: callNode.line as number | undefined,
        phase: 'VALIDATION',
        plugin: 'CallResolverValidator',
        nodeId: callNode.id,
        callName: callNode.name as string,
      },
      'Ensure the function is defined, imported, or is a known global',
      'warning' // Severity: warning (not error)
    );
  }
}
```

**Key Changes from Original**:

1. **Lines 1-12**: Updated JSDoc to explain resolution categories
2. **Lines 14-16**: Import `JS_GLOBAL_FUNCTIONS` from shared builtins
3. **Lines 18-20**: New `ResolutionType` type
4. **Lines 27-38**: New `ValidationSummary` interface with proper breakdown
5. **Lines 40-55**: Updated metadata with dependencies on resolvers
6. **Lines 57-100**: Refactored `execute()` to use `determineResolutionType()`
7. **Lines 102-140**: New `determineResolutionType()` method with clear priority
8. **Lines 142-160**: New `createWarning()` method with severity 'warning'
9. **Removed**: Datalog-based validation (replaced with programmatic checks)
10. **Removed**: `countMethodCalls()` helper (integrated into main loop)

---

## Test Cases

### File: `/Users/vadimr/grafema-worker-7/test/unit/CallResolverValidator.test.js`

#### New Tests to Add

**Test 1: Built-in calls not reported as warnings**

```javascript
it('should NOT flag JavaScript built-in function calls', async () => {
  const { backend } = await setupTest({
    'index.js': `// Empty`
  });

  try {
    // Add built-in function calls
    await backend.addNodes([
      { id: 'parseInt-call', type: 'CALL', name: 'parseInt', file: 'app.js' },
      { id: 'setTimeout-call', type: 'CALL', name: 'setTimeout', file: 'app.js' },
      { id: 'require-call', type: 'CALL', name: 'require', file: 'app.js' }
    ]);

    await backend.flush();

    // Run validator directly
    const { CallResolverValidator } = await import('@grafema/core');
    const validator = new CallResolverValidator();
    const result = await validator.execute({
      graph: backend,
      config: {},
      rootDir: testDir
    });

    // Should have no warnings
    assert.strictEqual(result.errors?.length ?? 0, 0, 'Built-in calls should not be flagged');

    // Summary should show built-ins resolved
    const summary = result.metadata?.summary;
    assert.strictEqual(summary.resolvedBuiltin, 3, 'Should count 3 built-in calls');
    assert.strictEqual(summary.unresolvedCalls, 0, 'Should have no unresolved calls');

    console.log('Built-in function calls correctly recognized');
  } finally {
    await backend.close();
  }
});
```

**Test 2: External package calls not reported**

```javascript
it('should NOT flag external package calls with CALLS edges', async () => {
  const { backend } = await setupTest({
    'index.js': `// Empty`
  });

  try {
    await backend.addNodes([
      { id: 'ext-module', type: 'EXTERNAL_MODULE', name: 'lodash', file: '' },
      { id: 'map-call', type: 'CALL', name: 'map', file: 'app.js' }
    ]);

    await backend.addEdge({
      src: 'map-call',
      dst: 'ext-module',
      type: 'CALLS'
    });

    await backend.flush();

    const { CallResolverValidator } = await import('@grafema/core');
    const validator = new CallResolverValidator();
    const result = await validator.execute({
      graph: backend,
      config: {},
      rootDir: testDir
    });

    assert.strictEqual(result.errors?.length ?? 0, 0, 'External calls should not be flagged');

    const summary = result.metadata?.summary;
    assert.strictEqual(summary.resolvedExternal, 1, 'Should count 1 external call');

    console.log('External package calls correctly recognized');
  } finally {
    await backend.close();
  }
});
```

**Test 3: Truly unresolved calls reported as warnings**

```javascript
it('should flag truly unresolved calls as warnings (not errors)', async () => {
  const { backend } = await setupTest({
    'index.js': `// Empty`
  });

  try {
    await backend.addNodes([
      { id: 'unknown-call', type: 'CALL', name: 'unknownFunction', file: 'app.js', line: 42 }
    ]);

    await backend.flush();

    const { CallResolverValidator } = await import('@grafema/core');
    const validator = new CallResolverValidator();
    const result = await validator.execute({
      graph: backend,
      config: {},
      rootDir: testDir
    });

    // Should have exactly 1 warning
    assert.strictEqual(result.errors?.length ?? 0, 1, 'Should report 1 warning');

    const warning = result.errors[0];
    assert.strictEqual(warning.severity, 'warning', 'Should be a warning, not error');
    assert.strictEqual(warning.code, 'WARN_UNRESOLVED_CALL');
    assert.ok(warning.message.includes('unknownFunction'), 'Message should include function name');

    const summary = result.metadata?.summary;
    assert.strictEqual(summary.unresolvedCalls, 1, 'Should count 1 unresolved call');
    assert.strictEqual(summary.warnings, 1, 'Should show 1 warning');

    console.log('Unresolved calls correctly reported as warnings');
  } finally {
    await backend.close();
  }
});
```

**Test 4: Mixed resolution types summary**

```javascript
it('should correctly categorize mixed resolution types in summary', async () => {
  const { backend } = await setupTest({
    'index.js': `// Empty`
  });

  try {
    await backend.addNodes([
      // Internal resolved
      { id: 'fn-def', type: 'FUNCTION', name: 'helper', file: 'app.js' },
      { id: 'internal-call', type: 'CALL', name: 'helper', file: 'app.js' },

      // External resolved
      { id: 'lodash-module', type: 'EXTERNAL_MODULE', name: 'lodash', file: '' },
      { id: 'external-call', type: 'CALL', name: 'map', file: 'app.js' },

      // Built-in
      { id: 'builtin-call', type: 'CALL', name: 'parseInt', file: 'app.js' },

      // Method call
      { id: 'method-call', type: 'CALL', name: 'arr.filter', file: 'app.js', object: 'arr', method: 'filter' },

      // Unresolved
      { id: 'unresolved-call', type: 'CALL', name: 'unknownFunc', file: 'app.js' }
    ]);

    await backend.addEdge({ src: 'internal-call', dst: 'fn-def', type: 'CALLS' });
    await backend.addEdge({ src: 'external-call', dst: 'lodash-module', type: 'CALLS' });
    await backend.flush();

    const { CallResolverValidator } = await import('@grafema/core');
    const validator = new CallResolverValidator();
    const result = await validator.execute({
      graph: backend,
      config: {},
      rootDir: testDir
    });

    const summary = result.metadata?.summary;
    assert.strictEqual(summary.totalCalls, 5, 'Should count 5 total calls');
    assert.strictEqual(summary.resolvedInternal, 1, 'Should count 1 internal');
    assert.strictEqual(summary.resolvedExternal, 1, 'Should count 1 external');
    assert.strictEqual(summary.resolvedBuiltin, 1, 'Should count 1 builtin');
    assert.strictEqual(summary.methodCalls, 1, 'Should count 1 method call');
    assert.strictEqual(summary.unresolvedCalls, 1, 'Should count 1 unresolved');

    console.log('Mixed resolution types categorized correctly');
  } finally {
    await backend.close();
  }
});
```

#### Tests to Update

**Update Test**: "should flag eval/Function constructor calls" (lines 396-424)

This test currently expects `eval` and `Function` to be flagged. After the change:
- `eval` IS a builtin (in JS_GLOBAL_FUNCTIONS) -> NOT flagged
- `Function` is a constructor, NOT in JS_GLOBAL_FUNCTIONS -> FLAGGED

```javascript
it('should handle eval as builtin but flag Function constructor', async () => {
  const { backend } = await setupTest({
    'index.js': `// Empty`
  });

  try {
    await backend.addNodes([
      // eval is a builtin - should NOT be flagged
      { id: 'eval-call', type: 'CALL', name: 'eval', file: 'app.js' },
      // Function constructor is NOT a builtin - should be flagged
      { id: 'func-ctor', type: 'CALL', name: 'Function', file: 'app.js' }
    ]);

    await backend.flush();

    const { CallResolverValidator } = await import('@grafema/core');
    const validator = new CallResolverValidator();
    const result = await validator.execute({
      graph: backend,
      config: {},
      rootDir: testDir
    });

    // Only Function should be flagged (eval is builtin)
    assert.strictEqual(result.errors?.length ?? 0, 1, 'Only Function should be flagged');
    assert.ok(result.errors[0].message.includes('Function'), 'Should flag Function');

    const summary = result.metadata?.summary;
    assert.strictEqual(summary.resolvedBuiltin, 1, 'eval should be builtin');
    assert.strictEqual(summary.unresolvedCalls, 1, 'Function should be unresolved');

    console.log('eval recognized as builtin, Function flagged');
  } finally {
    await backend.close();
  }
});
```

---

## Order of Operations

1. **Kent (Tests)**: Create test file changes first
   - Add 4 new test cases
   - Update the eval/Function test
   - Run tests - they should FAIL (expected)

2. **Rob (Implementation)**:
   - Step 1: Create `jsGlobals.ts` with `JS_GLOBAL_FUNCTIONS`
   - Step 2: Update `builtins/index.ts` export
   - Step 3: Update `ExternalCallResolver.ts` imports
   - Step 4: Rewrite `CallResolverValidator.ts`
   - Run tests after each step

3. **Verification**: All tests should pass after Step 4

---

## Edge Cases and Gotchas

### 1. Datalog vs Programmatic Approach

The original implementation used Datalog rules. The new implementation uses programmatic checks because:
- Datalog can't access attributes like `JS_GLOBAL_FUNCTIONS` set membership
- Programmatic approach allows richer resolution type detection
- More maintainable and debuggable

### 2. ValidationError Severity

The `ValidationError` class accepts severity in constructor (5th parameter):
```typescript
constructor(message, code, context, suggestion, severity = 'warning')
```

We explicitly pass `'warning'` to ensure unresolved calls are warnings, not errors.

### 3. Graph Interface

The code uses:
- `graph.queryNodes({ nodeType: 'CALL' })` - async iterator
- `graph.getOutgoingEdges(nodeId, ['CALLS'])` - returns EdgeRecord[]
- `graph.getNode(nodeId)` - returns NodeRecord | undefined

These methods are well-tested in existing validators.

### 4. Error Code Change

Changed from `ERR_UNRESOLVED_CALL` (error) to `WARN_UNRESOLVED_CALL` (warning) to reflect the semantic change.

### 5. Test Setup

Tests need to import the validator from `@grafema/core`. The test helper `createTestOrchestrator` runs the full pipeline, but for validator-specific tests, instantiate the validator directly.

---

## Dependencies and Build Order

```
jsGlobals.ts (new)
     |
     v
builtins/index.ts (update export)
     |
     v
ExternalCallResolver.ts (update import, remove local const)
     |
     v
CallResolverValidator.ts (rewrite)
```

All changes are in `packages/core`, so `npm run build` in core package is sufficient.

---

## Risk Assessment

**Low Risk**:
- Clear scope: validator logic only
- Shared constant simplifies maintenance
- Existing tests cover edge cases

**Potential Issues**:
1. **Import path**: Ensure `.js` extension in imports for ESM
2. **Test timing**: Tests may need increased timeout if running full pipeline
3. **Backward compatibility**: Summary structure change - any code parsing summary will need update

---

## Acceptance Verification

After implementation:

1. Run unit tests: `node --test test/unit/CallResolverValidator.test.js`
2. Run full test suite: `npm test`
3. Test with real codebase: `grafema analyze` on a sample project
4. Verify log output shows new summary format:
   ```
   Validation complete {
     totalCalls: X,
     resolvedInternal: X,
     resolvedExternal: X,
     resolvedBuiltin: X,
     methodCalls: X,
     unresolvedCalls: X,
     warnings: X
   }
   ```

---

## Conclusion

This spec provides:
1. Exact file locations and changes
2. Complete code for new file
3. Complete replacement code for validator
4. Test cases with exact assertions
5. Order of operations for implementation
6. Edge cases and gotchas

Ready for Kent (tests) and Rob (implementation).
