/**
 * ControlFlow DERIVES_FROM Edge Tests (REG-533)
 *
 * Tests that EXPRESSION nodes created by ControlFlowBuilder for loop conditions,
 * loop updates, and branch discriminants have DERIVES_FROM edges to their
 * operand variables/parameters.
 *
 * Covers these control flow contexts:
 * - Loop conditions: while (i < arr.length), while (flag), while (x && y)
 * - For loop test: for (let i = 0; i < 10; i++)
 * - For loop update: i++
 * - Do-while conditions: do { ... } while (count < attempts)
 * - If conditions: if (!flag), if (a > b), if (name && age)
 * - Switch discriminants: switch (action.type), switch (status)
 *
 * Expression types covered:
 * - BinaryExpression (left + right operands)
 * - LogicalExpression (left + right)
 * - MemberExpression (object)
 * - Identifier (self)
 * - UnaryExpression (argument)
 * - UpdateExpression (argument)
 * - Skip cases: ThisExpression (no DERIVES_FROM)
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { analyzeProject } from '../helpers/createTestOrchestrator.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);

describe('ControlFlow DERIVES_FROM Edges (REG-533)', () => {
  let testCounter = 0;

  /**
   * Set up a test project, run analysis, return backend handle.
   * Follows the same pattern as Expression.test.js.
   */
  async function setupTest(files) {
    const testDir = join(tmpdir(), `grafema-test-cf-derives-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'cf-derives-test',
      version: '1.0.0'
    }));

    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(testDir, name), content);
    }

    const db = await createTestDatabase();
    const backend = db.backend;

    await analyzeProject(backend, testDir);
    await backend.flush();

    return { backend, testDir };
  }

  async function cleanup(backend, testDir) {
    await backend.close();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  /**
   * Find all EXPRESSION nodes matching a given expressionType.
   */
  async function findExpressionNodes(backend, expressionType) {
    const nodes = [];
    for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
      if (node.expressionType === expressionType) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  /**
   * Get DERIVES_FROM edge targets (names) for a given EXPRESSION node.
   */
  async function getDerivesFromTargetNames(backend, expressionNodeId) {
    const edges = await backend.getOutgoingEdges(expressionNodeId, ['DERIVES_FROM']);
    const names = [];
    for (const edge of edges) {
      const target = await backend.getNode(edge.dst);
      if (target) {
        names.push(target.name);
      }
    }
    return names;
  }

  /**
   * Get DERIVES_FROM edges for a given EXPRESSION node.
   */
  async function getDerivesFromEdges(backend, expressionNodeId) {
    return backend.getOutgoingEdges(expressionNodeId, ['DERIVES_FROM']);
  }

  // ===========================================================================
  // GROUP 1: BinaryExpression in loop conditions
  // ===========================================================================

  describe('BinaryExpression in while condition', () => {
    it('should create DERIVES_FROM edges from condition EXPRESSION to both operands', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function process(arr) {
  let i = 0;
  while (i < arr.length) {
    console.log(arr[i]);
    i++;
  }
}
`
      });

      try {
        // Find the BinaryExpression EXPRESSION node (i < arr.length)
        // The while condition should be a BinaryExpression
        const expressionNodes = await findExpressionNodes(backend, 'BinaryExpression');

        // Filter to the one that is a loop condition (connected via HAS_CONDITION from LOOP)
        let conditionExpression = null;
        for (const expr of expressionNodes) {
          // Check if any LOOP node has HAS_CONDITION pointing to this expression
          for await (const node of backend.queryNodes({ type: 'LOOP' })) {
            const edges = await backend.getOutgoingEdges(node.id, ['HAS_CONDITION']);
            for (const edge of edges) {
              if (edge.dst === expr.id) {
                conditionExpression = expr;
                break;
              }
            }
            if (conditionExpression) break;
          }
          if (conditionExpression) break;
        }

        assert.ok(conditionExpression, 'Should find BinaryExpression EXPRESSION node as while condition');

        // Get DERIVES_FROM edges
        const targetNames = await getDerivesFromTargetNames(backend, conditionExpression.id);

        // The condition `i < arr.length` should derive from `i` and `arr`
        // (arr.length is a MemberExpression, so DERIVES_FROM should point to `arr`)
        assert.ok(
          targetNames.includes('i'),
          `DERIVES_FROM should include 'i', got: [${targetNames.join(', ')}]`
        );
        assert.ok(
          targetNames.includes('arr'),
          `DERIVES_FROM should include 'arr', got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('BinaryExpression in for test', () => {
    it('should create DERIVES_FROM edge from test EXPRESSION to loop variable', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function count() {
  for (let i = 0; i < 10; i++) {
    console.log(i);
  }
}
`
      });

      try {
        // Find LOOP node for the for loop
        let forLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'for') {
            forLoop = node;
            break;
          }
        }
        assert.ok(forLoop, 'Should find for LOOP node');

        // Find the HAS_CONDITION edge to get the condition EXPRESSION
        const conditionEdges = await backend.getOutgoingEdges(forLoop.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'for LOOP should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');
        assert.strictEqual(conditionNode.type, 'EXPRESSION', 'Condition should be EXPRESSION node');
        assert.strictEqual(
          conditionNode.expressionType,
          'BinaryExpression',
          'Condition should be BinaryExpression'
        );

        // Get DERIVES_FROM edges from the condition
        const targetNames = await getDerivesFromTargetNames(backend, conditionNode.id);

        // The condition `i < 10` has operand `i` (10 is a literal, no DERIVES_FROM for literals)
        assert.ok(
          targetNames.includes('i'),
          `DERIVES_FROM should include 'i', got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 2: UpdateExpression in for update
  // ===========================================================================

  describe('UpdateExpression in for update', () => {
    it('should create DERIVES_FROM edge from update EXPRESSION to loop variable', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function count() {
  for (let i = 0; i < 10; i++) {
    console.log(i);
  }
}
`
      });

      try {
        // Find LOOP node for the for loop
        let forLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'for') {
            forLoop = node;
            break;
          }
        }
        assert.ok(forLoop, 'Should find for LOOP node');

        // Find the HAS_UPDATE edge to get the update EXPRESSION
        const updateEdges = await backend.getOutgoingEdges(forLoop.id, ['HAS_UPDATE']);
        assert.ok(updateEdges.length >= 1, 'for LOOP should have HAS_UPDATE edge');

        const updateNode = await backend.getNode(updateEdges[0].dst);
        assert.ok(updateNode, 'Update EXPRESSION node should exist');
        assert.strictEqual(updateNode.type, 'EXPRESSION', 'Update should be EXPRESSION node');
        assert.strictEqual(
          updateNode.expressionType,
          'UpdateExpression',
          'Update should be UpdateExpression'
        );

        // Get DERIVES_FROM edges from the update expression
        const targetNames = await getDerivesFromTargetNames(backend, updateNode.id);

        // The update `i++` should derive from `i`
        assert.ok(
          targetNames.includes('i'),
          `DERIVES_FROM should include 'i', got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 3: UnaryExpression in if condition
  // ===========================================================================

  describe('UnaryExpression in if condition', () => {
    it('should create DERIVES_FROM edge from condition EXPRESSION to negated variable', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function check(flag) {
  if (!flag) {
    return 'not set';
  }
  return 'set';
}
`
      });

      try {
        // Find BRANCH node for the if statement
        let ifBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.branchType === 'if') {
            ifBranch = node;
            break;
          }
        }
        assert.ok(ifBranch, 'Should find if BRANCH node');

        // Find the HAS_CONDITION edge to get the condition EXPRESSION
        const conditionEdges = await backend.getOutgoingEdges(ifBranch.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'if BRANCH should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');
        assert.strictEqual(conditionNode.type, 'EXPRESSION', 'Condition should be EXPRESSION node');
        assert.strictEqual(
          conditionNode.expressionType,
          'UnaryExpression',
          'Condition should be UnaryExpression'
        );

        // Get DERIVES_FROM edges from the condition
        const targetNames = await getDerivesFromTargetNames(backend, conditionNode.id);

        // The condition `!flag` should derive from `flag`
        assert.ok(
          targetNames.includes('flag'),
          `DERIVES_FROM should include 'flag', got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 4: MemberExpression in switch discriminant
  // ===========================================================================

  describe('MemberExpression in switch discriminant', () => {
    it('should create DERIVES_FROM edge from discriminant EXPRESSION to object variable', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function reducer(state, action) {
  switch (action.type) {
    case 'INCREMENT':
      return state + 1;
    case 'DECREMENT':
      return state - 1;
    default:
      return state;
  }
}
`
      });

      try {
        // Find BRANCH node for the switch statement
        let switchBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.branchType === 'switch') {
            switchBranch = node;
            break;
          }
        }
        assert.ok(switchBranch, 'Should find switch BRANCH node');

        // Find the HAS_CONDITION edge to get the discriminant EXPRESSION
        const conditionEdges = await backend.getOutgoingEdges(switchBranch.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'switch BRANCH should have HAS_CONDITION edge');

        const discriminantNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(discriminantNode, 'Discriminant EXPRESSION node should exist');
        assert.strictEqual(discriminantNode.type, 'EXPRESSION', 'Discriminant should be EXPRESSION node');
        assert.strictEqual(
          discriminantNode.expressionType,
          'MemberExpression',
          'Discriminant should be MemberExpression'
        );

        // Get DERIVES_FROM edges from the discriminant
        const targetNames = await getDerivesFromTargetNames(backend, discriminantNode.id);

        // The discriminant `action.type` should derive from `action`
        assert.ok(
          targetNames.includes('action'),
          `DERIVES_FROM should include 'action', got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 5: LogicalExpression in while condition
  // ===========================================================================

  describe('LogicalExpression in while condition', () => {
    it('should create DERIVES_FROM edges from condition EXPRESSION to both operands', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function process(x, y) {
  while (x && y) {
    x = step(x);
    y = step(y);
  }
}
`
      });

      try {
        // Find the while LOOP
        let whileLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'while') {
            whileLoop = node;
            break;
          }
        }
        assert.ok(whileLoop, 'Should find while LOOP node');

        // Find the HAS_CONDITION edge
        const conditionEdges = await backend.getOutgoingEdges(whileLoop.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'while LOOP should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');
        assert.strictEqual(conditionNode.type, 'EXPRESSION', 'Condition should be EXPRESSION node');
        assert.strictEqual(
          conditionNode.expressionType,
          'LogicalExpression',
          'Condition should be LogicalExpression'
        );

        // Get DERIVES_FROM edges
        const targetNames = await getDerivesFromTargetNames(backend, conditionNode.id);

        // The condition `x && y` should derive from `x` and `y`
        assert.ok(
          targetNames.includes('x'),
          `DERIVES_FROM should include 'x', got: [${targetNames.join(', ')}]`
        );
        assert.ok(
          targetNames.includes('y'),
          `DERIVES_FROM should include 'y', got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 6: Identifier in while condition
  // ===========================================================================

  describe('Identifier in while condition', () => {
    it('should create DERIVES_FROM edge from condition EXPRESSION to the variable', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function process(flag) {
  while (flag) {
    flag = checkNext();
  }
}
`
      });

      try {
        // Find the while LOOP
        let whileLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'while') {
            whileLoop = node;
            break;
          }
        }
        assert.ok(whileLoop, 'Should find while LOOP node');

        // Find the HAS_CONDITION edge
        const conditionEdges = await backend.getOutgoingEdges(whileLoop.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'while LOOP should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');
        assert.strictEqual(conditionNode.type, 'EXPRESSION', 'Condition should be EXPRESSION node');
        assert.strictEqual(
          conditionNode.expressionType,
          'Identifier',
          'Condition should be Identifier'
        );

        // Get DERIVES_FROM edges
        const targetNames = await getDerivesFromTargetNames(backend, conditionNode.id);

        // The condition `flag` (an Identifier) should derive from `flag`
        assert.ok(
          targetNames.includes('flag'),
          `DERIVES_FROM should include 'flag', got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 7: BinaryExpression with parameter operands
  // ===========================================================================

  describe('BinaryExpression with parameter operands', () => {
    it('should create DERIVES_FROM edges to parameters (not just variables)', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function countdown(n) {
  while (n > 0) {
    console.log(n);
    n--;
  }
}
`
      });

      try {
        // Find the while LOOP
        let whileLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'while') {
            whileLoop = node;
            break;
          }
        }
        assert.ok(whileLoop, 'Should find while LOOP node');

        // Find the HAS_CONDITION edge
        const conditionEdges = await backend.getOutgoingEdges(whileLoop.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'while LOOP should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');

        // Get DERIVES_FROM edges
        const targetNames = await getDerivesFromTargetNames(backend, conditionNode.id);

        // The condition `n > 0` should derive from `n` (a parameter)
        assert.ok(
          targetNames.includes('n'),
          `DERIVES_FROM should include 'n' (parameter), got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 8: MemberExpression in while condition
  // ===========================================================================

  describe('MemberExpression in while condition', () => {
    it('should create DERIVES_FROM edge to the object of MemberExpression', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function drain(queue) {
  while (queue.length) {
    queue.pop();
  }
}
`
      });

      try {
        // Find the while LOOP
        let whileLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'while') {
            whileLoop = node;
            break;
          }
        }
        assert.ok(whileLoop, 'Should find while LOOP node');

        // Find the HAS_CONDITION edge
        const conditionEdges = await backend.getOutgoingEdges(whileLoop.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'while LOOP should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');
        assert.strictEqual(
          conditionNode.expressionType,
          'MemberExpression',
          'Condition should be MemberExpression'
        );

        // Get DERIVES_FROM edges
        const targetNames = await getDerivesFromTargetNames(backend, conditionNode.id);

        // The condition `queue.length` should derive from `queue`
        assert.ok(
          targetNames.includes('queue'),
          `DERIVES_FROM should include 'queue', got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 9: Identifier in if condition (simple truthy check)
  // ===========================================================================

  describe('Identifier in if condition', () => {
    it('should create DERIVES_FROM edge from if condition EXPRESSION to the variable', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function check(value) {
  if (value) {
    return 'truthy';
  }
  return 'falsy';
}
`
      });

      try {
        // Find BRANCH node
        let ifBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.branchType === 'if') {
            ifBranch = node;
            break;
          }
        }
        assert.ok(ifBranch, 'Should find if BRANCH node');

        // Find HAS_CONDITION edge
        const conditionEdges = await backend.getOutgoingEdges(ifBranch.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'if BRANCH should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition node should exist');
        assert.strictEqual(conditionNode.type, 'EXPRESSION', 'Condition should be EXPRESSION node');
        assert.strictEqual(
          conditionNode.expressionType,
          'Identifier',
          'Condition should be Identifier'
        );

        // Get DERIVES_FROM edges
        const targetNames = await getDerivesFromTargetNames(backend, conditionNode.id);

        assert.ok(
          targetNames.includes('value'),
          `DERIVES_FROM should include 'value', got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 10: BinaryExpression in if condition
  // ===========================================================================

  describe('BinaryExpression in if condition', () => {
    it('should create DERIVES_FROM edges for both operands of if condition', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function compare(a, b) {
  if (a > b) {
    return a;
  }
  return b;
}
`
      });

      try {
        // Find BRANCH node
        let ifBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.branchType === 'if') {
            ifBranch = node;
            break;
          }
        }
        assert.ok(ifBranch, 'Should find if BRANCH node');

        // Find HAS_CONDITION edge
        const conditionEdges = await backend.getOutgoingEdges(ifBranch.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'if BRANCH should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');
        assert.strictEqual(
          conditionNode.expressionType,
          'BinaryExpression',
          'Condition should be BinaryExpression'
        );

        // Get DERIVES_FROM edges
        const targetNames = await getDerivesFromTargetNames(backend, conditionNode.id);

        // The condition `a > b` should derive from both `a` and `b`
        assert.ok(
          targetNames.includes('a'),
          `DERIVES_FROM should include 'a', got: [${targetNames.join(', ')}]`
        );
        assert.ok(
          targetNames.includes('b'),
          `DERIVES_FROM should include 'b', got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 11: Skip case - ThisExpression
  // ===========================================================================

  describe('ThisExpression skip case', () => {
    it('should NOT create DERIVES_FROM edge for this in while condition', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
class Runner {
  run() {
    while (this.running) {
      this.step();
    }
  }
}
`
      });

      try {
        // Find the while LOOP
        let whileLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'while') {
            whileLoop = node;
            break;
          }
        }
        assert.ok(whileLoop, 'Should find while LOOP node');

        // Find the HAS_CONDITION edge
        const conditionEdges = await backend.getOutgoingEdges(whileLoop.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'while LOOP should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');

        // The condition is `this.running` -- a MemberExpression with `this` as object.
        // DERIVES_FROM should NOT point to `this` (ThisExpression is a skip case).
        // There should be zero DERIVES_FROM edges since `this` is the only object.
        const derivesFromEdges = await getDerivesFromEdges(backend, conditionNode.id);

        // Verify none of the targets are named 'this'
        for (const edge of derivesFromEdges) {
          const target = await backend.getNode(edge.dst);
          assert.notStrictEqual(
            target?.name,
            'this',
            'Should NOT have DERIVES_FROM edge to this (ThisExpression is a skip case)'
          );
        }
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 12: LogicalExpression in if condition
  // ===========================================================================

  describe('LogicalExpression in if condition', () => {
    it('should create DERIVES_FROM edges from LogicalExpression condition to both operands', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function validate(name, age) {
  if (name && age) {
    return true;
  }
  return false;
}
`
      });

      try {
        // Find BRANCH node
        let ifBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.branchType === 'if') {
            ifBranch = node;
            break;
          }
        }
        assert.ok(ifBranch, 'Should find if BRANCH node');

        // Find HAS_CONDITION edge
        const conditionEdges = await backend.getOutgoingEdges(ifBranch.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'if BRANCH should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');
        assert.strictEqual(
          conditionNode.expressionType,
          'LogicalExpression',
          'Condition should be LogicalExpression'
        );

        // Get DERIVES_FROM edges
        const targetNames = await getDerivesFromTargetNames(backend, conditionNode.id);

        assert.ok(
          targetNames.includes('name'),
          `DERIVES_FROM should include 'name', got: [${targetNames.join(', ')}]`
        );
        assert.ok(
          targetNames.includes('age'),
          `DERIVES_FROM should include 'age', got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 13: do-while condition
  // ===========================================================================

  describe('BinaryExpression in do-while condition', () => {
    it('should create DERIVES_FROM edge from do-while condition EXPRESSION to operand', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function retry(attempts) {
  let count = 0;
  do {
    tryOperation();
    count++;
  } while (count < attempts);
}
`
      });

      try {
        // Find the do-while LOOP
        let doWhileLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'do-while') {
            doWhileLoop = node;
            break;
          }
        }
        assert.ok(doWhileLoop, 'Should find do-while LOOP node');

        // Find the HAS_CONDITION edge
        const conditionEdges = await backend.getOutgoingEdges(doWhileLoop.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'do-while LOOP should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');
        assert.strictEqual(
          conditionNode.expressionType,
          'BinaryExpression',
          'Condition should be BinaryExpression'
        );

        // Get DERIVES_FROM edges
        const targetNames = await getDerivesFromTargetNames(backend, conditionNode.id);

        // The condition `count < attempts` should derive from both
        assert.ok(
          targetNames.includes('count'),
          `DERIVES_FROM should include 'count', got: [${targetNames.join(', ')}]`
        );
        assert.ok(
          targetNames.includes('attempts'),
          `DERIVES_FROM should include 'attempts', got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 14: Complex nested expression (BinaryExpression with MemberExpression operand)
  // ===========================================================================

  describe('Complex expression in for condition', () => {
    it('should create DERIVES_FROM edges for complex condition with MemberExpression operands', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function processArray(arr) {
  for (let i = 0; i < arr.length; i++) {
    console.log(arr[i]);
  }
}
`
      });

      try {
        // Find LOOP node
        let forLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'for') {
            forLoop = node;
            break;
          }
        }
        assert.ok(forLoop, 'Should find for LOOP node');

        // Find HAS_CONDITION edge
        const conditionEdges = await backend.getOutgoingEdges(forLoop.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'for LOOP should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');

        // Get DERIVES_FROM edges
        const targetNames = await getDerivesFromTargetNames(backend, conditionNode.id);

        // The condition `i < arr.length` should derive from `i` and `arr`
        // Even though arr.length is a MemberExpression, the base object `arr` should be tracked
        assert.ok(
          targetNames.includes('i'),
          `DERIVES_FROM should include 'i', got: [${targetNames.join(', ')}]`
        );
        assert.ok(
          targetNames.includes('arr'),
          `DERIVES_FROM should include 'arr', got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 15: Identifier in switch discriminant
  // ===========================================================================

  describe('Identifier in switch discriminant', () => {
    it('should create DERIVES_FROM edge from switch discriminant to variable', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function process(status) {
  switch (status) {
    case 'active':
      return true;
    case 'inactive':
      return false;
    default:
      return null;
  }
}
`
      });

      try {
        // Find BRANCH node for the switch
        let switchBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.branchType === 'switch') {
            switchBranch = node;
            break;
          }
        }
        assert.ok(switchBranch, 'Should find switch BRANCH node');

        // Find HAS_CONDITION edge
        const conditionEdges = await backend.getOutgoingEdges(switchBranch.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'switch BRANCH should have HAS_CONDITION edge');

        const discriminantNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(discriminantNode, 'Discriminant node should exist');
        assert.strictEqual(discriminantNode.type, 'EXPRESSION', 'Discriminant should be EXPRESSION');
        assert.strictEqual(
          discriminantNode.expressionType,
          'Identifier',
          'Discriminant should be Identifier'
        );

        // Get DERIVES_FROM edges
        const targetNames = await getDerivesFromTargetNames(backend, discriminantNode.id);

        assert.ok(
          targetNames.includes('status'),
          `DERIVES_FROM should include 'status', got: [${targetNames.join(', ')}]`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });
});
