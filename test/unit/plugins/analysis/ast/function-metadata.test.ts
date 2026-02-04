/**
 * Function Control Flow Metadata Tests (REG-267 Phase 6)
 *
 * Tests for ControlFlowMetadata on FUNCTION nodes. This metadata provides
 * summary information about the control flow characteristics of a function:
 * - hasBranches: Has if/switch statements
 * - hasLoops: Has any loop type (for, while, do-while)
 * - hasTryCatch: Has try/catch blocks
 * - hasEarlyReturn: Has return before function end
 * - hasThrow: Has throw statements
 * - cyclomaticComplexity: McCabe cyclomatic complexity
 *
 * Cyclomatic complexity formula:
 *   M = 1 + branches + loops + (non-default switch cases) + logical operators (&& ||)
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase } from '../../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../../helpers/createTestOrchestrator.js';
import type { NodeRecord } from '@grafema/types';

// Define expected interface locally for TDD (matches ControlFlowMetadata in types.ts)
interface ControlFlowMetadata {
  hasBranches: boolean;
  hasLoops: boolean;
  hasTryCatch: boolean;
  hasEarlyReturn: boolean;
  hasThrow: boolean;
  cyclomaticComplexity: number;
}

let testCounter = 0;

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Helper to create a test project with given files and run analysis
 */
async function setupTest(
  backend: ReturnType<typeof createTestBackend>,
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-funcmeta-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-funcmeta-${testCounter}`,
      type: 'module',
      main: 'index.js'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Get nodes by type from backend
 */
async function getNodesByType(
  backend: ReturnType<typeof createTestBackend>,
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
}

/**
 * Get control flow metadata from a function node
 */
function getControlFlowMetadata(funcNode: NodeRecord): ControlFlowMetadata | undefined {
  const record = funcNode as Record<string, unknown>;
  // Metadata could be at top level or nested in metadata object
  if (record.controlFlow) {
    return record.controlFlow as ControlFlowMetadata;
  }
  if (record.metadata && typeof record.metadata === 'object') {
    const metadata = record.metadata as Record<string, unknown>;
    return metadata.controlFlow as ControlFlowMetadata | undefined;
  }
  return undefined;
}

/**
 * Find function node by name
 */
async function getFunctionByName(
  backend: ReturnType<typeof createTestBackend>,
  name: string
): Promise<NodeRecord | undefined> {
  const functionNodes = await getNodesByType(backend, 'FUNCTION');
  return functionNodes.find((n: NodeRecord) => n.name === name);
}

// =============================================================================
// TESTS: ControlFlowMetadata on FUNCTION nodes
// =============================================================================

describe('Function Control Flow Metadata (REG-267 Phase 6)', () => {
  let backend: ReturnType<typeof createTestBackend> & { cleanup: () => Promise<void> };

  beforeEach(async () => {
    if (db) await db.cleanup();
    backend = createTestBackend() as ReturnType<typeof createTestBackend> & { cleanup: () => Promise<void> };
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ===========================================================================
  // GROUP 1: Basic metadata presence
  // ===========================================================================

  describe('Basic metadata presence', () => {
    it('should have controlFlow metadata on simple function', async () => {
      await setupTest(backend, {
        'index.js': `
function simple() {
  return 1;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'simple');
      assert.ok(funcNode, 'Should have FUNCTION node named "simple"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'FUNCTION node should have controlFlow metadata');

      // Verify all expected fields are present
      assert.strictEqual(typeof controlFlow.hasBranches, 'boolean', 'hasBranches should be boolean');
      assert.strictEqual(typeof controlFlow.hasLoops, 'boolean', 'hasLoops should be boolean');
      assert.strictEqual(typeof controlFlow.hasTryCatch, 'boolean', 'hasTryCatch should be boolean');
      assert.strictEqual(typeof controlFlow.hasEarlyReturn, 'boolean', 'hasEarlyReturn should be boolean');
      assert.strictEqual(typeof controlFlow.hasThrow, 'boolean', 'hasThrow should be boolean');
      assert.strictEqual(typeof controlFlow.cyclomaticComplexity, 'number', 'cyclomaticComplexity should be number');
    });

    it('should have controlFlow metadata on arrow function', async () => {
      await setupTest(backend, {
        'index.js': `
const arrowFunc = () => {
  return 1;
};
        `
      });

      const functionNodes = await getNodesByType(backend, 'FUNCTION');
      // Find arrow function - it may not have name 'arrowFunc' directly
      const arrowNode = functionNodes.find((n: NodeRecord) => {
        const record = n as Record<string, unknown>;
        return record.arrowFunction === true || n.name === 'arrowFunc';
      });
      assert.ok(arrowNode, 'Should have arrow FUNCTION node');

      const controlFlow = getControlFlowMetadata(arrowNode);
      assert.ok(controlFlow, 'Arrow function should have controlFlow metadata');
    });
  });

  // ===========================================================================
  // GROUP 2: hasBranches detection
  // ===========================================================================

  describe('hasBranches detection', () => {
    it('should detect hasBranches = true for if statement', async () => {
      await setupTest(backend, {
        'index.js': `
function withIf(x) {
  if (x) {
    return 1;
  }
  return 0;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'withIf');
      assert.ok(funcNode, 'Should have FUNCTION node named "withIf"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasBranches, true, 'hasBranches should be true for function with if');
    });

    it('should detect hasBranches = true for switch statement', async () => {
      await setupTest(backend, {
        'index.js': `
function withSwitch(x) {
  switch (x) {
    case 1: return 'one';
    default: return 'other';
  }
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'withSwitch');
      assert.ok(funcNode, 'Should have FUNCTION node named "withSwitch"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasBranches, true, 'hasBranches should be true for function with switch');
    });

    it('should detect hasBranches = false for function without branches', async () => {
      await setupTest(backend, {
        'index.js': `
function noBranches(a, b) {
  return a + b;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'noBranches');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasBranches, false, 'hasBranches should be false for function without branches');
    });
  });

  // ===========================================================================
  // GROUP 3: hasLoops detection
  // ===========================================================================

  describe('hasLoops detection', () => {
    it('should detect hasLoops = true for for-of loop', async () => {
      await setupTest(backend, {
        'index.js': `
function withLoop(items) {
  for (const x of items) {
    console.log(x);
  }
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'withLoop');
      assert.ok(funcNode, 'Should have FUNCTION node named "withLoop"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasLoops, true, 'hasLoops should be true for function with for-of loop');
    });

    it('should detect hasLoops = true for while loop', async () => {
      await setupTest(backend, {
        'index.js': `
function withWhile(n) {
  let i = 0;
  while (i < n) {
    i++;
  }
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'withWhile');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasLoops, true, 'hasLoops should be true for function with while loop');
    });

    it('should detect hasLoops = true for for loop', async () => {
      await setupTest(backend, {
        'index.js': `
function withFor(n) {
  for (let i = 0; i < n; i++) {
    console.log(i);
  }
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'withFor');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasLoops, true, 'hasLoops should be true for function with for loop');
    });

    it('should detect hasLoops = false for function without loops', async () => {
      await setupTest(backend, {
        'index.js': `
function noLoops() {
  return 42;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'noLoops');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasLoops, false, 'hasLoops should be false for function without loops');
    });
  });

  // ===========================================================================
  // GROUP 4: hasTryCatch detection
  // ===========================================================================

  describe('hasTryCatch detection', () => {
    it('should detect hasTryCatch = true for try/catch', async () => {
      await setupTest(backend, {
        'index.js': `
function withTry() {
  try {
    riskyOp();
  } catch {
    handleError();
  }
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'withTry');
      assert.ok(funcNode, 'Should have FUNCTION node named "withTry"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasTryCatch, true, 'hasTryCatch should be true for function with try/catch');
    });

    it('should detect hasTryCatch = true for try/finally', async () => {
      await setupTest(backend, {
        'index.js': `
function withTryFinally() {
  try {
    riskyOp();
  } finally {
    cleanup();
  }
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'withTryFinally');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasTryCatch, true, 'hasTryCatch should be true for function with try/finally');
    });

    it('should detect hasTryCatch = false for function without try', async () => {
      await setupTest(backend, {
        'index.js': `
function noTry() {
  return safeOp();
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'noTry');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasTryCatch, false, 'hasTryCatch should be false for function without try');
    });
  });

  // ===========================================================================
  // GROUP 5: hasEarlyReturn detection
  // ===========================================================================

  describe('hasEarlyReturn detection', () => {
    it('should detect hasEarlyReturn = true for conditional early return', async () => {
      await setupTest(backend, {
        'index.js': `
function earlyReturn(x) {
  if (x) {
    return 1;
  }
  console.log('after');
  return 0;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'earlyReturn');
      assert.ok(funcNode, 'Should have FUNCTION node named "earlyReturn"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.hasEarlyReturn,
        true,
        'hasEarlyReturn should be true for function with early return in if block'
      );
    });

    it('should detect hasEarlyReturn = false for single return at end', async () => {
      await setupTest(backend, {
        'index.js': `
function singleReturn(a, b) {
  const sum = a + b;
  return sum;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'singleReturn');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.hasEarlyReturn,
        false,
        'hasEarlyReturn should be false for function with single return at end'
      );
    });

    it('should detect hasEarlyReturn = true for guard clause pattern', async () => {
      await setupTest(backend, {
        'index.js': `
function guardClause(data) {
  if (!data) {
    return null;
  }
  if (!data.valid) {
    return null;
  }
  return data.value;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'guardClause');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.hasEarlyReturn,
        true,
        'hasEarlyReturn should be true for guard clause pattern'
      );
    });
  });

  // ===========================================================================
  // GROUP 6: hasThrow detection
  // ===========================================================================

  describe('hasThrow detection', () => {
    it('should detect hasThrow = true for function with throw', async () => {
      await setupTest(backend, {
        'index.js': `
function throws() {
  throw new Error('Something went wrong');
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'throws');
      assert.ok(funcNode, 'Should have FUNCTION node named "throws"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasThrow, true, 'hasThrow should be true for function that throws');
    });

    it('should detect hasThrow = true for conditional throw', async () => {
      await setupTest(backend, {
        'index.js': `
function mayThrow(x) {
  if (!x) {
    throw new Error('x is required');
  }
  return x * 2;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'mayThrow');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasThrow, true, 'hasThrow should be true for function with conditional throw');
    });

    it('should detect hasThrow = false for function without throw', async () => {
      await setupTest(backend, {
        'index.js': `
function noThrow(x) {
  return x || null;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'noThrow');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasThrow, false, 'hasThrow should be false for function without throw');
    });
  });

  // ===========================================================================
  // GROUP 7: cyclomaticComplexity calculation
  // ===========================================================================

  describe('cyclomaticComplexity calculation', () => {
    it('should calculate complexity = 1 for simple function', async () => {
      // Base complexity for any function is 1
      await setupTest(backend, {
        'index.js': `
function add(a, b) {
  return a + b;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'add');
      assert.ok(funcNode, 'Should have FUNCTION node named "add"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        1,
        'Simple function should have cyclomaticComplexity = 1'
      );

      // Verify all boolean flags are false for simple function
      assert.strictEqual(controlFlow.hasBranches, false, 'Simple function: hasBranches should be false');
      assert.strictEqual(controlFlow.hasLoops, false, 'Simple function: hasLoops should be false');
      assert.strictEqual(controlFlow.hasTryCatch, false, 'Simple function: hasTryCatch should be false');
      assert.strictEqual(controlFlow.hasEarlyReturn, false, 'Simple function: hasEarlyReturn should be false');
      assert.strictEqual(controlFlow.hasThrow, false, 'Simple function: hasThrow should be false');
    });

    it('should calculate complexity = 5 for complex function with branches, loops, and logical operators', async () => {
      // Complexity formula: 1 + branches + cases + loops + logicalOps
      // This function has: base(1) + 2 branches + 1 loop + 1 logical operator = 5
      await setupTest(backend, {
        'index.js': `
function complex(x) {
  if (x > 0 && x < 10) {  // +1 branch, +1 logical (&& counts)
    for (let i = 0; i < x; i++) {  // +1 loop
      if (i % 2 === 0) {  // +1 branch
        return i;
      }
    }
  }
  return -1;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'complex');
      assert.ok(funcNode, 'Should have FUNCTION node named "complex"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        5,
        'Complex function should have cyclomaticComplexity = 1 + 2 branches + 1 loop + 1 logical = 5'
      );
      assert.strictEqual(controlFlow.hasBranches, true, 'Should have hasBranches = true');
      assert.strictEqual(controlFlow.hasLoops, true, 'Should have hasLoops = true');
      assert.strictEqual(controlFlow.hasEarlyReturn, true, 'Should have hasEarlyReturn = true (return inside loop)');
    });

    it('should calculate complexity for switch with multiple cases', async () => {
      // Complexity formula: 1 + branches(switch=1) + non-default cases(2) = 4
      await setupTest(backend, {
        'index.js': `
function withSwitch(x) {
  switch (x) {
    case 1: return 'one';    // +1 case
    case 2: return 'two';    // +1 case
    default: return 'other'; // default doesn't count
  }
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'withSwitch');
      assert.ok(funcNode, 'Should have FUNCTION node named "withSwitch"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        4,
        'Switch function should have cyclomaticComplexity = 1 base + 1 switch + 2 non-default cases = 4'
      );
    });

    it('should count logical operators in if conditions', async () => {
      // 1 base + 1 if branch + 2 logical operators (&&, ||) = 4
      await setupTest(backend, {
        'index.js': `
function withLogicalOps(a, b, c) {
  if (a && b || c) {
    return true;
  }
  return false;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'withLogicalOps');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        4,
        'Function with logical ops should have cyclomaticComplexity = 1 + 1 branch + 2 logical ops = 4'
      );
    });

    it('should count nested if statements', async () => {
      // 1 base + 3 if branches = 4
      await setupTest(backend, {
        'index.js': `
function nestedIfs(a, b, c) {
  if (a) {
    if (b) {
      if (c) {
        return 'all true';
      }
    }
  }
  return 'not all';
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'nestedIfs');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        4,
        'Nested ifs should have cyclomaticComplexity = 1 base + 3 branches = 4'
      );
    });

    it('should count multiple loops', async () => {
      // 1 base + 2 loops = 3
      await setupTest(backend, {
        'index.js': `
function multipleLoops(items, count) {
  for (const item of items) {
    process(item);
  }
  while (count > 0) {
    count--;
  }
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'multipleLoops');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        3,
        'Multiple loops should have cyclomaticComplexity = 1 base + 2 loops = 3'
      );
    });
  });

  // ===========================================================================
  // GROUP 8: Edge cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle empty function', async () => {
      await setupTest(backend, {
        'index.js': `
function empty() {
  // nothing here
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'empty');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.cyclomaticComplexity, 1, 'Empty function should have complexity = 1');
      assert.strictEqual(controlFlow.hasBranches, false, 'Empty function: hasBranches = false');
      assert.strictEqual(controlFlow.hasLoops, false, 'Empty function: hasLoops = false');
      assert.strictEqual(controlFlow.hasTryCatch, false, 'Empty function: hasTryCatch = false');
      assert.strictEqual(controlFlow.hasEarlyReturn, false, 'Empty function: hasEarlyReturn = false');
      assert.strictEqual(controlFlow.hasThrow, false, 'Empty function: hasThrow = false');
    });

    it('should handle async function', async () => {
      await setupTest(backend, {
        'index.js': `
async function asyncFunc(data) {
  if (!data) {
    throw new Error('No data');
  }
  try {
    const result = await fetch(data.url);
    return result;
  } catch (e) {
    console.error(e);
    return null;
  }
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'asyncFunc');
      assert.ok(funcNode, 'Should have FUNCTION node named "asyncFunc"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Async function should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasBranches, true, 'Should detect if branch');
      assert.strictEqual(controlFlow.hasTryCatch, true, 'Should detect try/catch');
      assert.strictEqual(controlFlow.hasThrow, true, 'Should detect throw');
    });

    it('should handle generator function', async () => {
      await setupTest(backend, {
        'index.js': `
function* generator(items) {
  for (const item of items) {
    if (item.valid) {
      yield item.value;
    }
  }
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'generator');
      assert.ok(funcNode, 'Should have FUNCTION node named "generator"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Generator function should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasLoops, true, 'Should detect loop in generator');
      assert.strictEqual(controlFlow.hasBranches, true, 'Should detect if in generator');
    });

    it('should handle ternary operator (not counting as branch for complexity)', async () => {
      // Ternary is not counted as a branch for hasBranches but may count for complexity
      await setupTest(backend, {
        'index.js': `
function withTernary(x) {
  return x > 0 ? 'positive' : 'non-positive';
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'withTernary');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      // Ternary may or may not count as a branch depending on implementation
      // This test documents expected behavior
      assert.strictEqual(typeof controlFlow.cyclomaticComplexity, 'number', 'Should have complexity');
    });

    it('should handle function with only throw', async () => {
      await setupTest(backend, {
        'index.js': `
function alwaysThrows() {
  throw new Error('Always fails');
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'alwaysThrows');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasThrow, true, 'Should detect throw');
      assert.strictEqual(controlFlow.hasEarlyReturn, false, 'No early return if only throw');
      assert.strictEqual(controlFlow.cyclomaticComplexity, 1, 'Just throw = complexity 1');
    });

    it('should handle IIFE', async () => {
      await setupTest(backend, {
        'index.js': `
const result = (function() {
  if (Math.random() > 0.5) {
    return 'heads';
  }
  return 'tails';
})();
        `
      });

      const functionNodes = await getNodesByType(backend, 'FUNCTION');
      assert.ok(functionNodes.length >= 1, 'Should have at least one FUNCTION node for IIFE');

      // Find the IIFE (anonymous function)
      const iife = functionNodes.find((n: NodeRecord) => {
        const controlFlow = getControlFlowMetadata(n);
        return controlFlow && controlFlow.hasBranches === true;
      });
      assert.ok(iife, 'Should find IIFE with branch');

      const controlFlow = getControlFlowMetadata(iife);
      assert.ok(controlFlow, 'IIFE should have controlFlow metadata');
      assert.strictEqual(controlFlow.hasBranches, true, 'IIFE should have hasBranches = true');
    });
  });

  // ===========================================================================
  // GROUP 9: Multiple functions in same file
  // ===========================================================================

  describe('Multiple functions in same file', () => {
    it('should have correct metadata for each function independently', async () => {
      await setupTest(backend, {
        'index.js': `
function simple() {
  return 1;
}

function complex(x, y) {
  if (x > y) {
    for (let i = 0; i < x; i++) {
      console.log(i);
    }
  }
  return x + y;
}

function withTryCatch() {
  try {
    riskyOp();
  } catch {
    return null;
  }
}
        `
      });

      const simpleFunc = await getFunctionByName(backend, 'simple');
      const complexFunc = await getFunctionByName(backend, 'complex');
      const tryCatchFunc = await getFunctionByName(backend, 'withTryCatch');

      assert.ok(simpleFunc, 'Should have simple function');
      assert.ok(complexFunc, 'Should have complex function');
      assert.ok(tryCatchFunc, 'Should have withTryCatch function');

      const simpleFlow = getControlFlowMetadata(simpleFunc);
      const complexFlow = getControlFlowMetadata(complexFunc);
      const tryCatchFlow = getControlFlowMetadata(tryCatchFunc);

      assert.ok(simpleFlow, 'simple should have controlFlow');
      assert.ok(complexFlow, 'complex should have controlFlow');
      assert.ok(tryCatchFlow, 'withTryCatch should have controlFlow');

      // Verify independent metadata
      assert.strictEqual(simpleFlow.cyclomaticComplexity, 1, 'simple: complexity = 1');
      assert.strictEqual(simpleFlow.hasBranches, false, 'simple: no branches');
      assert.strictEqual(simpleFlow.hasLoops, false, 'simple: no loops');

      assert.strictEqual(complexFlow.hasBranches, true, 'complex: has branches');
      assert.strictEqual(complexFlow.hasLoops, true, 'complex: has loops');
      assert.strictEqual(complexFlow.cyclomaticComplexity, 3, 'complex: 1 base + 1 branch + 1 loop = 3');

      assert.strictEqual(tryCatchFlow.hasTryCatch, true, 'withTryCatch: has try/catch');
      assert.strictEqual(tryCatchFlow.hasBranches, false, 'withTryCatch: no branches');
    });
  });

  // ===========================================================================
  // GROUP 10: Method functions in classes
  // ===========================================================================

  describe('Method functions in classes', () => {
    it('should have controlFlow metadata on class methods', async () => {
      await setupTest(backend, {
        'index.js': `
class Calculator {
  add(a, b) {
    return a + b;
  }

  divide(a, b) {
    if (b === 0) {
      throw new Error('Division by zero');
    }
    return a / b;
  }
}
        `
      });

      const functionNodes = await getNodesByType(backend, 'FUNCTION');

      // Find add method
      const addMethod = functionNodes.find((n: NodeRecord) => n.name === 'add');
      assert.ok(addMethod, 'Should have add method');

      const addFlow = getControlFlowMetadata(addMethod);
      assert.ok(addFlow, 'add method should have controlFlow metadata');
      assert.strictEqual(addFlow.cyclomaticComplexity, 1, 'add: complexity = 1');

      // Find divide method
      const divideMethod = functionNodes.find((n: NodeRecord) => n.name === 'divide');
      assert.ok(divideMethod, 'Should have divide method');

      const divideFlow = getControlFlowMetadata(divideMethod);
      assert.ok(divideFlow, 'divide method should have controlFlow metadata');
      assert.strictEqual(divideFlow.hasBranches, true, 'divide: has if branch');
      assert.strictEqual(divideFlow.hasThrow, true, 'divide: has throw');
      assert.strictEqual(divideFlow.cyclomaticComplexity, 2, 'divide: 1 base + 1 branch = 2');
    });
  });
});
