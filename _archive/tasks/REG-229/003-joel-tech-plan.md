# Joel Spolsky Technical Implementation Plan: REG-229 ArgumentParameterLinker

## Executive Summary

This plan details the implementation of `ArgumentParameterLinker`, an enrichment plugin that creates `RECEIVES_ARGUMENT` edges connecting function parameters to the argument values passed at call sites. This enables data flow tracing across function boundaries.

---

## Step-by-Step Implementation Plan

### STEP 1: Create Test Fixtures (Kent - TDD First)

**Location:** `test/fixtures/receives-argument/`

**Files to create:**

1. `index.js` - Main test fixture with all scenarios:

```javascript
// === Basic argument binding ===
function process(data) { return data; }
process(userInput);

// === Multi-argument binding ===
function combine(a, b) { return a + b; }
const x = 1, y = 2;
combine(x, y);

// === Method call binding ===
class Service {
  process(data) { return data; }
}
const svc = new Service();
svc.process(userInput);

// === Arrow function binding ===
const fn = (x) => x * 2;
fn(value);

// === Unresolved call (no CALLS edge) ===
unknownFn(someData);
```

2. `cross-file/a.js` and `cross-file/b.js` - Cross-file test case

---

### STEP 2: Create Test File (Kent - TDD First)

**Location:** `test/unit/ReceivesArgument.test.js`

**Test structure (following `PassesArgument.test.js` pattern):**

```javascript
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { ArgumentParameterLinker } from '@grafema/core';

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/receives-argument');

describe('RECEIVES_ARGUMENT Edges', () => {
  // Test cases:
  // 1. Basic: PARAMETER receives from VARIABLE
  // 2. Multi-argument: Each PARAMETER receives correct arg by index
  // 3. Method call: Class method PARAMETER receives argument
  // 4. Arrow function: Arrow function PARAMETER receives argument
  // 5. Unresolved call: No crash, no edges
  // 6. Missing arguments: Extra params get no edge
  // 7. Extra arguments: Extra args get no edge
  // 8. Edge metadata: callId and argIndex present
});
```

**Key test assertions:**
- Edge direction: `PARAMETER --RECEIVES_ARGUMENT--> argument_source`
- Edge metadata contains `argIndex` and `callId`
- No edges created for unresolved calls (no CALLS edge)
- No duplicate edges on re-run

---

### STEP 3: Create ArgumentParameterLinker Plugin (Rob)

**Location:** `packages/core/src/plugins/enrichment/ArgumentParameterLinker.ts`

**Implementation following `MethodCallResolver.ts` pattern:**

```typescript
/**
 * ArgumentParameterLinker - connects function parameters to call arguments
 *
 * For each CALL node with PASSES_ARGUMENT edges:
 * 1. Follow CALLS edge to find target function
 * 2. Get function's PARAMETER nodes via HAS_PARAMETER edges
 * 3. Match arguments to parameters by index
 * 4. Create RECEIVES_ARGUMENT edge: PARAMETER -> argument_source
 *
 * CREATES EDGES:
 * - PARAMETER -> RECEIVES_ARGUMENT -> argument_source (VARIABLE, LITERAL, etc.)
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';

export class ArgumentParameterLinker extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ArgumentParameterLinker',
      phase: 'ENRICHMENT',
      priority: 55, // After MethodCallResolver (50), before ValueDomainAnalyzer (65)
      creates: {
        nodes: [],
        edges: ['RECEIVES_ARGUMENT']
      },
      dependencies: ['JSASTAnalyzer', 'MethodCallResolver']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting argument-parameter linking');

    let callsProcessed = 0;
    let edgesCreated = 0;
    let skipped = 0;

    // Step 1: Get all CALL nodes
    const calls: BaseNodeRecord[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      calls.push(node);
    }

    logger.info('Found calls to process', { count: calls.length });

    const startTime = Date.now();

    for (const call of calls) {
      callsProcessed++;

      // Progress reporting every 50 calls
      if (onProgress && callsProcessed % 50 === 0) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'ArgumentParameterLinker',
          message: `Linking arguments ${callsProcessed}/${calls.length}`,
          totalFiles: calls.length,
          processedFiles: callsProcessed
        });
      }

      // Step 2: Get CALLS edge to find target function
      const callsEdges = await graph.getOutgoingEdges(call.id, ['CALLS']);
      if (callsEdges.length === 0) {
        skipped++; // Unresolved call
        continue;
      }

      const targetFunctionId = callsEdges[0].dst;

      // Step 3: Get target function's parameters via HAS_PARAMETER
      const paramEdges = await graph.getOutgoingEdges(targetFunctionId, ['HAS_PARAMETER']);
      if (paramEdges.length === 0) {
        skipped++; // Function has no parameters
        continue;
      }

      // Build parameter index map: index -> parameterNodeId
      const parametersByIndex = new Map<number, string>();
      for (const edge of paramEdges) {
        const paramNode = await graph.getNode(edge.dst);
        if (paramNode && paramNode.index !== undefined) {
          parametersByIndex.set(paramNode.index as number, edge.dst);
        }
      }

      // Step 4: Get PASSES_ARGUMENT edges from call
      const passesArgEdges = await graph.getOutgoingEdges(call.id, ['PASSES_ARGUMENT']);

      // Step 5: Match arguments to parameters by index
      for (const argEdge of passesArgEdges) {
        const argIndex = argEdge.metadata?.argIndex ?? argEdge.argIndex;
        if (argIndex === undefined) continue;

        const parameterId = parametersByIndex.get(argIndex as number);
        if (!parameterId) continue; // More args than params

        // Step 6: Create RECEIVES_ARGUMENT edge
        await graph.addEdge({
          src: parameterId,
          dst: argEdge.dst, // argument source
          type: 'RECEIVES_ARGUMENT',
          metadata: {
            argIndex: argIndex,
            callId: call.id,
            isSpread: argEdge.metadata?.isSpread
          }
        });
        edgesCreated++;
      }
    }

    const summary = {
      callsProcessed,
      edgesCreated,
      skipped,
      timeMs: Date.now() - startTime
    };

    logger.info('Complete', summary);

    return createSuccessResult({ nodes: 0, edges: edgesCreated }, summary);
  }
}
```

---

### STEP 4: Export from Core Index

**File:** `packages/core/src/index.ts`

**Add to enrichment exports section (around line 187):**
```typescript
export { ArgumentParameterLinker } from './plugins/enrichment/ArgumentParameterLinker.js';
```

---

### STEP 5: Register in CLI

**File:** `packages/cli/src/commands/analyze.ts`

**Step 5.1: Add import (around line 38):**
```typescript
  ArgumentParameterLinker,
```

**Step 5.2: Add to BUILTIN_PLUGINS (around line 77):**
```typescript
  ArgumentParameterLinker: () => new ArgumentParameterLinker() as Plugin,
```

---

### STEP 6: Register in MCP Config

**File:** `packages/mcp/src/config.ts`

**Step 6.1: Add import (around line 32):**
```typescript
  ArgumentParameterLinker,
```

**Step 6.2: Add to BUILTIN_PLUGINS (around line 91):**
```typescript
  ArgumentParameterLinker: () => new ArgumentParameterLinker(),
```

---

### STEP 7: Register in MCP Analysis Worker

**File:** `packages/mcp/src/analysis-worker.ts`

**Add to plugins object (around line 165):**
```typescript
      ArgumentParameterLinker: () => new ArgumentParameterLinker(),
```

---

### STEP 8: Add to Default Config

**File:** `packages/core/src/config/ConfigLoader.ts`

**Add to enrichment array (around line 73):**
```typescript
      'ArgumentParameterLinker',
```

**Position:** After `MethodCallResolver` (it depends on resolved CALLS edges)

---

### STEP 9: Update Test Helper (Optional)

**File:** `test/helpers/createTestOrchestrator.js`

**Add import and plugin if needed for comprehensive tests:**
```javascript
import { ArgumentParameterLinker } from '@grafema/core';

// In plugins array:
plugins.push(new ArgumentParameterLinker());
```

---

## Edge Cases to Handle

1. **Unresolved calls:** No CALLS edge exists -> skip silently
2. **No parameters:** Function takes no params -> skip
3. **Missing arguments:** Call passes fewer args than params -> only link available
4. **Extra arguments:** Call passes more args than params -> extras get no edge
5. **Rest parameters:** `...args` -> link spread argument (use isSpread metadata)
6. **Duplicate prevention:** Check if edge exists before creating

---

## Test Verification Checklist

- [ ] Basic binding: `process(userInput)` creates PARAMETER(data) -> RECEIVES_ARGUMENT -> VARIABLE(userInput)
- [ ] Multi-argument: Each parameter receives correct argument by index
- [ ] Method calls: Works with class methods via MethodCallResolver
- [ ] Arrow functions: Works with arrow function parameters
- [ ] Cross-file: Works when function is in different file (after ImportExportLinker)
- [ ] Unresolved calls: No crash, no edges created
- [ ] No duplicates: Re-running doesn't create duplicate edges
- [ ] Edge metadata: argIndex and callId are set correctly

---

## Performance Considerations

**Expected impact:**
- One edge per argument that maps to a parameter
- For a file with 100 calls averaging 2 arguments each: ~200 additional edges
- Total runtime: O(calls * avg_args) - linear scaling

**Optimization potential:**
- Batch parameter lookups (build index upfront like MethodCallResolver)
- Skip external/builtin function calls

---

## Files Summary

| File | Action |
|------|--------|
| `packages/core/src/plugins/enrichment/ArgumentParameterLinker.ts` | CREATE - New plugin |
| `packages/core/src/index.ts` | MODIFY - Add export |
| `packages/cli/src/commands/analyze.ts` | MODIFY - Add import + registration |
| `packages/mcp/src/config.ts` | MODIFY - Add import + registration |
| `packages/mcp/src/analysis-worker.ts` | MODIFY - Add registration |
| `packages/core/src/config/ConfigLoader.ts` | MODIFY - Add to default enrichment |
| `test/unit/ReceivesArgument.test.js` | CREATE - Test file |
| `test/fixtures/receives-argument/index.js` | CREATE - Test fixture |
| `test/fixtures/receives-argument/cross-file/a.js` | CREATE - Cross-file test |
| `test/fixtures/receives-argument/cross-file/b.js` | CREATE - Cross-file test |

---

## Critical Files for Implementation

- `packages/core/src/plugins/enrichment/MethodCallResolver.ts` - Pattern to follow for enrichment plugin structure
- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Reference for PASSES_ARGUMENT edge creation (bufferArgumentEdges method)
- `packages/types/src/edges.ts` - RECEIVES_ARGUMENT edge type definition
- `packages/core/src/core/nodes/ParameterNode.ts` - Parameter node structure with index field
- `test/unit/PassesArgument.test.js` - Test pattern to follow
