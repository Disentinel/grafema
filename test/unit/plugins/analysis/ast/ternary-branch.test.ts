/**
 * Ternary Branch Nodes Tests (REG-287)
 *
 * Tests for BRANCH nodes representing ConditionalExpression (ternary operator `? :`).
 * These tests verify the graph structure for ternary expressions including:
 * - BRANCH node creation with branchType='ternary'
 * - Cyclomatic complexity incrementing by 1 per ternary
 * - Nested ternary handling (multiple BRANCH nodes)
 * - Ternary in different contexts (return, assignment, function argument)
 *
 * What will be created:
 * - BRANCH node with branchType='ternary'
 * - (Future) HAS_CONDITION edge from BRANCH to condition EXPRESSION
 * - (Future) HAS_CONSEQUENT edge from BRANCH to consequent EXPRESSION
 * - (Future) HAS_ALTERNATE edge from BRANCH to alternate EXPRESSION
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
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-ternary-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-ternary-${testCounter}`,
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
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
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
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  name: string
): Promise<NodeRecord | undefined> {
  const functionNodes = await getNodesByType(backend, 'FUNCTION');
  return functionNodes.find((n: NodeRecord) => n.name === name);
}

// =============================================================================
// TESTS: BRANCH Node Creation for Ternary Expressions
// =============================================================================

describe('Ternary Branch Nodes Analysis (REG-287)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'] & { cleanup: () => Promise<void> };

  beforeEach(async () => {
    if (db) await db.cleanup();
    backend = await createTestDatabase(); backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ===========================================================================
  // GROUP 1: Basic ternary creates BRANCH node
  // ===========================================================================

  describe('Basic ternary creates BRANCH node', () => {
    it('should create BRANCH node for simple ternary expression', async () => {
      await setupTest(backend, {
        'index.js': `
function getValue(a) {
  const x = a ? 1 : 2;
  return x;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have BRANCH node with branchType="ternary"');
      assert.ok(ternaryBranch.file, 'BRANCH node should have file property');
      assert.ok(ternaryBranch.line, 'BRANCH node should have line property');
    });

    it('should have correct parentScopeId on ternary BRANCH', async () => {
      await setupTest(backend, {
        'index.js': `
function getValue(a) {
  const x = a ? 1 : 2;
  return x;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node');

      const branchRecord = ternaryBranch as Record<string, unknown>;
      assert.ok(
        branchRecord.parentScopeId !== undefined,
        'Ternary BRANCH node should have parentScopeId'
      );
    });
  });

  // ===========================================================================
  // GROUP 2: Cyclomatic complexity
  // ===========================================================================

  describe('Cyclomatic complexity', () => {
    it('should have complexity = 2 for function with single ternary (1 base + 1 ternary)', async () => {
      await setupTest(backend, {
        'index.js': `
function withTernary(a) {
  const x = a ? 1 : 2;
  return x;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'withTernary');
      assert.ok(funcNode, 'Should have FUNCTION node named "withTernary"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        2,
        'Function with single ternary should have cyclomaticComplexity = 1 base + 1 ternary = 2'
      );
    });

    it('should have complexity = 3 for function with two ternaries', async () => {
      await setupTest(backend, {
        'index.js': `
function withTwoTernaries(a, b) {
  const x = a ? 1 : 2;
  const y = b ? 3 : 4;
  return x + y;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'withTwoTernaries');
      assert.ok(funcNode, 'Should have FUNCTION node named "withTwoTernaries"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        3,
        'Function with two ternaries should have cyclomaticComplexity = 1 base + 2 ternaries = 3'
      );
    });

    it('should count ternary towards hasBranches = true', async () => {
      await setupTest(backend, {
        'index.js': `
function onlyTernary(a) {
  return a ? 1 : 2;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'onlyTernary');
      assert.ok(funcNode, 'Should have FUNCTION node named "onlyTernary"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.hasBranches,
        true,
        'Function with only ternary should have hasBranches = true'
      );
    });

    it('should combine ternary with if statement for complexity', async () => {
      // 1 base + 1 if + 1 ternary = 3
      await setupTest(backend, {
        'index.js': `
function mixedBranches(a, b) {
  if (a) {
    return b ? 1 : 2;
  }
  return 0;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'mixedBranches');
      assert.ok(funcNode, 'Should have FUNCTION node named "mixedBranches"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        3,
        'Function with if and ternary should have cyclomaticComplexity = 1 base + 1 if + 1 ternary = 3'
      );
    });
  });

  // ===========================================================================
  // GROUP 3: Nested ternary
  // ===========================================================================

  describe('Nested ternary creates multiple BRANCH nodes', () => {
    it('should create 2 BRANCH nodes for nested ternary', async () => {
      await setupTest(backend, {
        'index.js': `
function nestedTernary(a, b) {
  const x = a ? (b ? 1 : 2) : 3;
  return x;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );

      assert.ok(
        ternaryBranches.length >= 2,
        `Should have at least 2 ternary BRANCH nodes for nested ternary, got ${ternaryBranches.length}`
      );
    });

    it('should have unique IDs with discriminators for nested ternaries', async () => {
      await setupTest(backend, {
        'index.js': `
function nestedTernary(a, b) {
  const x = a ? (b ? 1 : 2) : 3;
  return x;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );

      assert.ok(ternaryBranches.length >= 2, 'Should have at least 2 ternary BRANCH nodes');

      const ids = ternaryBranches.map(n => n.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(
        uniqueIds.size,
        ids.length,
        'All ternary BRANCH nodes should have unique IDs'
      );
    });

    it('should have complexity = 3 for function with nested ternary (1 base + 2 ternaries)', async () => {
      await setupTest(backend, {
        'index.js': `
function nestedTernary(a, b) {
  const x = a ? (b ? 1 : 2) : 3;
  return x;
}
        `
      });

      const funcNode = await getFunctionByName(backend, 'nestedTernary');
      assert.ok(funcNode, 'Should have FUNCTION node named "nestedTernary"');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        3,
        'Nested ternary should have cyclomaticComplexity = 1 base + 2 ternaries = 3'
      );
    });

    it('should handle deeply nested ternary (3 levels)', async () => {
      await setupTest(backend, {
        'index.js': `
function deeplyNested(a, b, c) {
  const x = a ? (b ? (c ? 1 : 2) : 3) : 4;
  return x;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );

      assert.ok(
        ternaryBranches.length >= 3,
        `Should have at least 3 ternary BRANCH nodes for 3-level nested ternary, got ${ternaryBranches.length}`
      );

      const funcNode = await getFunctionByName(backend, 'deeplyNested');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        4,
        'Deeply nested ternary (3 levels) should have cyclomaticComplexity = 1 base + 3 ternaries = 4'
      );
    });
  });

  // ===========================================================================
  // GROUP 4: Ternary in different contexts
  // ===========================================================================

  describe('Ternary in different contexts', () => {
    it('should create BRANCH for ternary in return statement', async () => {
      await setupTest(backend, {
        'index.js': `
function returnTernary(a) {
  return a ? 1 : 2;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node in return statement');

      const funcNode = await getFunctionByName(backend, 'returnTernary');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        2,
        'Function with ternary in return should have complexity = 2'
      );
    });

    it('should create BRANCH for ternary in assignment expression', async () => {
      await setupTest(backend, {
        'index.js': `
function assignmentTernary(a) {
  let x;
  x = a ? 1 : 2;
  return x;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node in assignment');
    });

    it('should create BRANCH for ternary in function argument', async () => {
      await setupTest(backend, {
        'index.js': `
function argumentTernary(a) {
  console.log(a ? 'yes' : 'no');
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node in function argument');
    });

    it('should create BRANCH for ternary in array literal', async () => {
      await setupTest(backend, {
        'index.js': `
function arrayTernary(a) {
  return [a ? 1 : 2, 3, 4];
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node in array literal');
    });

    it('should create BRANCH for ternary in object literal', async () => {
      await setupTest(backend, {
        'index.js': `
function objectTernary(a) {
  return { value: a ? 1 : 2 };
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node in object literal');
    });

    it('should create BRANCH for ternary in template literal', async () => {
      await setupTest(backend, {
        'index.js': `
function templateTernary(a) {
  return \`Result: \${a ? 'yes' : 'no'}\`;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node in template literal');
    });
  });

  // ===========================================================================
  // GROUP 5: Ternary with complex conditions
  // ===========================================================================

  describe('Ternary with complex conditions', () => {
    it('should create BRANCH for ternary with logical AND condition', async () => {
      await setupTest(backend, {
        'index.js': `
function ternaryAndCondition(a, b) {
  return a && b ? 1 : 2;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node with && condition');

      // Complexity: 1 base + 1 ternary + 1 logical AND = 3
      const funcNode = await getFunctionByName(backend, 'ternaryAndCondition');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        3,
        'Ternary with && condition should have complexity = 1 + 1 ternary + 1 logical = 3'
      );
    });

    it('should create BRANCH for ternary with comparison condition', async () => {
      await setupTest(backend, {
        'index.js': `
function ternaryComparison(x) {
  return x > 0 ? 'positive' : 'non-positive';
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node with comparison condition');
    });

    it('should create BRANCH for ternary with function call condition', async () => {
      await setupTest(backend, {
        'index.js': `
function ternaryCallCondition(x) {
  return isValid(x) ? process(x) : null;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node with call condition');
    });
  });

  // ===========================================================================
  // GROUP 6: Multiple ternaries in same function
  // ===========================================================================

  describe('Multiple ternaries in same function', () => {
    it('should create separate BRANCH nodes for sequential ternaries', async () => {
      await setupTest(backend, {
        'index.js': `
function multipleTernaries(a, b, c) {
  const x = a ? 1 : 2;
  const y = b ? 3 : 4;
  const z = c ? 5 : 6;
  return x + y + z;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );

      assert.ok(
        ternaryBranches.length >= 3,
        `Should have at least 3 ternary BRANCH nodes, got ${ternaryBranches.length}`
      );
    });

    it('should have unique IDs for each sequential ternary BRANCH', async () => {
      await setupTest(backend, {
        'index.js': `
function multipleTernaries(a, b) {
  const x = a ? 1 : 2;
  const y = b ? 3 : 4;
  return x + y;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );

      assert.ok(ternaryBranches.length >= 2, 'Should have at least 2 ternary BRANCH nodes');

      const ids = ternaryBranches.map(n => n.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(
        uniqueIds.size,
        ids.length,
        'All sequential ternary BRANCH nodes should have unique IDs'
      );
    });
  });

  // ===========================================================================
  // GROUP 7: Ternary inside other control structures
  // ===========================================================================

  describe('Ternary inside other control structures', () => {
    it('should create BRANCH for ternary inside if body', async () => {
      await setupTest(backend, {
        'index.js': `
function ternaryInIf(a, b) {
  if (a) {
    return b ? 1 : 2;
  }
  return 0;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      const ifBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'if'
      );

      assert.ok(ifBranch, 'Should have if BRANCH node');
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node inside if body');
    });

    it('should create BRANCH for ternary inside loop body', async () => {
      await setupTest(backend, {
        'index.js': `
function ternaryInLoop(items) {
  for (const item of items) {
    console.log(item.valid ? item.value : 'invalid');
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node inside loop body');

      const loopNodes = await getNodesByType(backend, 'LOOP');
      assert.ok(loopNodes.length >= 1, 'Should have LOOP node');
    });

    it('should create BRANCH for ternary in switch case', async () => {
      await setupTest(backend, {
        'index.js': `
function ternaryInSwitch(type, flag) {
  switch (type) {
    case 'a':
      return flag ? 1 : 2;
    default:
      return 0;
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      const switchBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'switch'
      );

      assert.ok(switchBranch, 'Should have switch BRANCH node');
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node in switch case');
    });
  });

  // ===========================================================================
  // GROUP 8: BRANCH node semantic ID format
  // ===========================================================================

  describe('BRANCH node semantic ID format', () => {
    it('should have semantic ID containing BRANCH and ternary marker', async () => {
      await setupTest(backend, {
        'index.js': `
function myFunction(x) {
  return x ? 1 : 2;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node');

      // Semantic ID format per Joel's spec: {file}->{scope_path}->BRANCH->ternary#N
      assert.ok(
        ternaryBranch.id.includes('BRANCH') || ternaryBranch.id.includes('ternary'),
        `Ternary BRANCH node ID should contain BRANCH or ternary: ${ternaryBranch.id}`
      );
    });

    it('should have distinct discriminators for multiple ternaries on same line', async () => {
      await setupTest(backend, {
        'index.js': `
function multipleSameLine(a, b) { return (a ? 1 : 2) + (b ? 3 : 4); }
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );

      assert.ok(ternaryBranches.length >= 2, 'Should have at least 2 ternary BRANCH nodes');

      const ids = ternaryBranches.map(n => n.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(
        uniqueIds.size,
        ids.length,
        'Ternaries on same line should have unique IDs with different discriminators'
      );
    });
  });

  // ===========================================================================
  // GROUP 9: Arrow functions with ternary
  // ===========================================================================

  describe('Arrow functions with ternary', () => {
    it('should create BRANCH for ternary in arrow function body', async () => {
      await setupTest(backend, {
        'index.js': `
const arrowTernary = (a) => a ? 1 : 2;
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node in arrow function');
    });

    it('should count ternary in arrow function for complexity', async () => {
      await setupTest(backend, {
        'index.js': `
const arrowTernary = (a) => a ? 1 : 2;
        `
      });

      const functionNodes = await getNodesByType(backend, 'FUNCTION');
      const arrowNode = functionNodes.find((n: NodeRecord) => {
        const record = n as Record<string, unknown>;
        return record.arrowFunction === true || n.name === 'arrowTernary';
      });
      assert.ok(arrowNode, 'Should have arrow FUNCTION node');

      const controlFlow = getControlFlowMetadata(arrowNode);
      assert.ok(controlFlow, 'Arrow function should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        2,
        'Arrow function with ternary should have complexity = 2'
      );
    });
  });

  // ===========================================================================
  // GROUP 10: Edge cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle ternary with null/undefined branches', async () => {
      await setupTest(backend, {
        'index.js': `
function nullishTernary(x) {
  return x ? x.value : null;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node with null branch');
    });

    it('should handle ternary as default parameter value', async () => {
      await setupTest(backend, {
        'index.js': `
function defaultTernary(flag, value = flag ? 1 : 0) {
  return value;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node in default parameter');
    });

    it('should handle ternary in class method', async () => {
      await setupTest(backend, {
        'index.js': `
class MyClass {
  getValue(flag) {
    return flag ? 1 : 2;
  }
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node in class method');
    });

    it('should handle ternary with void expressions', async () => {
      await setupTest(backend, {
        'index.js': `
function voidTernary(flag) {
  flag ? console.log('yes') : console.log('no');
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranch = branchNodes.find(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );
      assert.ok(ternaryBranch, 'Should have ternary BRANCH node with void expressions');
    });

    it('should handle chained ternary (flat, not nested)', async () => {
      // Chained: a ? 1 : b ? 2 : 3 (equivalent to a ? 1 : (b ? 2 : 3))
      await setupTest(backend, {
        'index.js': `
function chainedTernary(a, b) {
  return a ? 1 : b ? 2 : 3;
}
        `
      });

      const branchNodes = await getNodesByType(backend, 'BRANCH');
      const ternaryBranches = branchNodes.filter(
        (n: NodeRecord) => (n as Record<string, unknown>).branchType === 'ternary'
      );

      assert.ok(
        ternaryBranches.length >= 2,
        `Chained ternary should create at least 2 BRANCH nodes, got ${ternaryBranches.length}`
      );

      const funcNode = await getFunctionByName(backend, 'chainedTernary');
      assert.ok(funcNode, 'Should have FUNCTION node');

      const controlFlow = getControlFlowMetadata(funcNode);
      assert.ok(controlFlow, 'Should have controlFlow metadata');
      assert.strictEqual(
        controlFlow.cyclomaticComplexity,
        3,
        'Chained ternary should have complexity = 1 base + 2 ternaries = 3'
      );
    });
  });
});
