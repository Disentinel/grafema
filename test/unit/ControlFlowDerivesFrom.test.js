/**
 * ControlFlow Data Flow Edge Tests (REG-533)
 *
 * Tests that EXPRESSION/PROPERTY_ACCESS nodes created for loop conditions,
 * loop updates, and branch discriminants have READS_FROM edges to their
 * operand variables/parameters.
 *
 * V2 Migration Notes:
 * - DERIVES_FROM edges no longer exist in V2 -- replaced by READS_FROM
 * - EXPRESSION nodes are identified by operator name (e.g., "<", "!", "++")
 *   not by expressionType (e.g., "BinaryExpression")
 * - branchType is undefined for BRANCH nodes -- use node.name to identify
 * - MemberExpression conditions -> PROPERTY_ACCESS nodes (not EXPRESSION)
 * - Simple identifier conditions (while(flag), switch(status)) don't create
 *   condition EXPRESSION nodes -- the LOOP/BRANCH has READS_FROM directly
 * - UpdateExpression (i++) -> EXPRESSION with name="++" and MODIFIES edge
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

describe('ControlFlow READS_FROM Edges (REG-533)', () => {
  let testCounter = 0;

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
    } catch (_e) {
      // Ignore cleanup errors
    }
  }

  /**
   * Get READS_FROM target names for a given node.
   * V2: replaces DERIVES_FROM with READS_FROM.
   */
  async function getReadsFromTargetNames(backend, nodeId) {
    const edges = await backend.getOutgoingEdges(nodeId, ['READS_FROM']);
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
   * Get all outgoing edge target names of given types for a node.
   */
  async function getEdgeTargetNames(backend, nodeId, edgeTypes) {
    const edges = await backend.getOutgoingEdges(nodeId, edgeTypes);
    const names = [];
    for (const edge of edges) {
      const target = await backend.getNode(edge.dst);
      if (target) {
        names.push(target.name);
      }
    }
    return names;
  }

  // ===========================================================================
  // GROUP 1: BinaryExpression in loop conditions
  // ===========================================================================

  describe('BinaryExpression in while condition', () => {
    it('should create READS_FROM edges from condition EXPRESSION to operands', async () => {
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
        // V2: Find LOOP -> HAS_CONDITION -> EXPRESSION("<")
        let conditionExpression = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'while') {
            const edges = await backend.getOutgoingEdges(node.id, ['HAS_CONDITION']);
            for (const edge of edges) {
              const dst = await backend.getNode(edge.dst);
              if (dst && dst.type === 'EXPRESSION' && dst.name === '<') {
                conditionExpression = dst;
                break;
              }
            }
          }
          if (conditionExpression) break;
        }

        assert.ok(conditionExpression, 'Should find EXPRESSION("<") node as while condition');

        // V2: READS_FROM replaces DERIVES_FROM
        const targetNames = await getReadsFromTargetNames(backend, conditionExpression.id);

        // The condition `i < arr.length`:
        // EXPRESSION("<") -> READS_FROM -> VARIABLE(i)
        // EXPRESSION("<") -> USES -> PROPERTY_ACCESS(arr.length)
        assert.ok(
          targetNames.includes('i'),
          `READS_FROM should include 'i', got: [${targetNames.join(', ')}]`
        );
        // arr is accessed via PROPERTY_ACCESS(arr.length) -> READS_FROM -> PARAMETER(arr)
        // The EXPRESSION uses PROPERTY_ACCESS, not directly reads arr
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('BinaryExpression in for test', () => {
    it('should create READS_FROM edge from test EXPRESSION to loop variable', async () => {
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
        // V2: Find for LOOP -> HAS_CONDITION -> EXPRESSION("<")
        let forLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'for') {
            forLoop = node;
            break;
          }
        }
        assert.ok(forLoop, 'Should find for LOOP node');

        const conditionEdges = await backend.getOutgoingEdges(forLoop.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'for LOOP should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition node should exist');
        assert.strictEqual(conditionNode.type, 'EXPRESSION', 'Condition should be EXPRESSION node');
        // V2: name is the operator, not expressionType
        assert.strictEqual(conditionNode.name, '<', 'Condition should be "<" expression');

        // V2: READS_FROM replaces DERIVES_FROM
        const targetNames = await getReadsFromTargetNames(backend, conditionNode.id);

        // The condition `i < 10` has operand `i`
        assert.ok(
          targetNames.includes('i'),
          `READS_FROM should include 'i', got: [${targetNames.join(', ')}]`
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
    it('should create MODIFIES edge from update EXPRESSION to loop variable', async () => {
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
        let forLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'for') {
            forLoop = node;
            break;
          }
        }
        assert.ok(forLoop, 'Should find for LOOP node');

        // V2: HAS_UPDATE edge exists for for-loop updates
        const updateEdges = await backend.getOutgoingEdges(forLoop.id, ['HAS_UPDATE']);
        assert.ok(updateEdges.length >= 1, 'for LOOP should have HAS_UPDATE edge');

        const updateNode = await backend.getNode(updateEdges[0].dst);
        assert.ok(updateNode, 'Update node should exist');
        assert.strictEqual(updateNode.type, 'EXPRESSION', 'Update should be EXPRESSION node');
        // V2: UpdateExpression -> EXPRESSION with name="++"
        assert.strictEqual(updateNode.name, '++', 'Update should be "++" expression');

        // V2: UpdateExpression has MODIFIES edge (not DERIVES_FROM)
        const modifiesNames = await getEdgeTargetNames(backend, updateNode.id, ['MODIFIES']);

        assert.ok(
          modifiesNames.includes('i'),
          `MODIFIES should include 'i', got: [${modifiesNames.join(', ')}]`
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
    it('should create READS_FROM edge from condition EXPRESSION to negated variable', async () => {
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
        // V2: Find BRANCH with HAS_CONDITION -> EXPRESSION("!")
        let ifBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.name === 'if') {
            ifBranch = node;
            break;
          }
        }
        assert.ok(ifBranch, 'Should find if BRANCH node');

        const conditionEdges = await backend.getOutgoingEdges(ifBranch.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'if BRANCH should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');
        assert.strictEqual(conditionNode.type, 'EXPRESSION', 'Condition should be EXPRESSION node');
        assert.strictEqual(conditionNode.name, '!', 'Condition should be "!" expression');

        // V2: READS_FROM replaces DERIVES_FROM
        const targetNames = await getReadsFromTargetNames(backend, conditionNode.id);

        assert.ok(
          targetNames.includes('flag'),
          `READS_FROM should include 'flag', got: [${targetNames.join(', ')}]`
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
    it('should create READS_FROM edge from discriminant PROPERTY_ACCESS to object variable', async () => {
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
        // V2: Find switch BRANCH -> HAS_CONDITION -> PROPERTY_ACCESS
        let switchBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.name === 'switch') {
            switchBranch = node;
            break;
          }
        }
        assert.ok(switchBranch, 'Should find switch BRANCH node');

        const conditionEdges = await backend.getOutgoingEdges(switchBranch.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'switch BRANCH should have HAS_CONDITION edge');

        const discriminantNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(discriminantNode, 'Discriminant node should exist');
        // V2: MemberExpression -> PROPERTY_ACCESS (not EXPRESSION)
        assert.strictEqual(discriminantNode.type, 'PROPERTY_ACCESS',
          'Discriminant should be PROPERTY_ACCESS node');

        // V2: PROPERTY_ACCESS has READS_FROM -> PARAMETER(action)
        const targetNames = await getReadsFromTargetNames(backend, discriminantNode.id);

        assert.ok(
          targetNames.includes('action'),
          `READS_FROM should include 'action', got: [${targetNames.join(', ')}]`
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
    it('should create READS_FROM edges from condition EXPRESSION to both operands', async () => {
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
        // V2: while(x && y) may create EXPRESSION("&&") with READS_FROM
        // or the LOOP may directly have READS_FROM to x and y
        let whileLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'while') {
            whileLoop = node;
            break;
          }
        }
        assert.ok(whileLoop, 'Should find while LOOP node');

        // Check for HAS_CONDITION -> EXPRESSION("&&")
        const conditionEdges = await backend.getOutgoingEdges(whileLoop.id, ['HAS_CONDITION']);
        let conditionNode = null;
        if (conditionEdges.length > 0) {
          conditionNode = await backend.getNode(conditionEdges[0].dst);
        }

        if (conditionNode && conditionNode.type === 'EXPRESSION') {
          // EXPRESSION("&&") -> READS_FROM -> x, y
          const targetNames = await getReadsFromTargetNames(backend, conditionNode.id);
          assert.ok(
            targetNames.includes('x'),
            `READS_FROM should include 'x', got: [${targetNames.join(', ')}]`
          );
          assert.ok(
            targetNames.includes('y'),
            `READS_FROM should include 'y', got: [${targetNames.join(', ')}]`
          );
        } else {
          // Fallback: LOOP itself may have READS_FROM edges
          const loopReadNames = await getReadsFromTargetNames(backend, whileLoop.id);
          assert.ok(
            loopReadNames.includes('x') || loopReadNames.includes('y'),
            `LOOP or condition should READS_FROM 'x' or 'y', got: [${loopReadNames.join(', ')}]`
          );
        }
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 6: Identifier in while condition
  // ===========================================================================

  describe('Identifier in while condition', () => {
    it('should create READS_FROM edge for simple identifier condition', async () => {
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
        // V2: while(flag) -- simple identifier conditions don't create EXPRESSION nodes
        // Instead, the LOOP itself has READS_FROM -> PARAMETER(flag)
        let whileLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'while') {
            whileLoop = node;
            break;
          }
        }
        assert.ok(whileLoop, 'Should find while LOOP node');

        // Check HAS_CONDITION first
        const conditionEdges = await backend.getOutgoingEdges(whileLoop.id, ['HAS_CONDITION']);
        let conditionNode = null;
        if (conditionEdges.length > 0) {
          conditionNode = await backend.getNode(conditionEdges[0].dst);
        }

        if (conditionNode && conditionNode.type === 'EXPRESSION') {
          // If there's an EXPRESSION condition node, check its READS_FROM
          const targetNames = await getReadsFromTargetNames(backend, conditionNode.id);
          assert.ok(
            targetNames.includes('flag'),
            `Condition READS_FROM should include 'flag', got: [${targetNames.join(', ')}]`
          );
        } else {
          // V2: LOOP directly has READS_FROM -> PARAMETER(flag)
          const loopReadNames = await getReadsFromTargetNames(backend, whileLoop.id);
          assert.ok(
            loopReadNames.includes('flag'),
            `LOOP READS_FROM should include 'flag', got: [${loopReadNames.join(', ')}]`
          );
        }
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 7: BinaryExpression with parameter operands
  // ===========================================================================

  describe('BinaryExpression with parameter operands', () => {
    it('should create READS_FROM edges to parameters (not just variables)', async () => {
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
        let whileLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'while') {
            whileLoop = node;
            break;
          }
        }
        assert.ok(whileLoop, 'Should find while LOOP node');

        const conditionEdges = await backend.getOutgoingEdges(whileLoop.id, ['HAS_CONDITION']);
        let conditionNode = null;
        if (conditionEdges.length > 0) {
          conditionNode = await backend.getNode(conditionEdges[0].dst);
        }

        if (conditionNode && conditionNode.type === 'EXPRESSION') {
          const targetNames = await getReadsFromTargetNames(backend, conditionNode.id);
          assert.ok(
            targetNames.includes('n'),
            `READS_FROM should include 'n' (parameter), got: [${targetNames.join(', ')}]`
          );
        } else {
          // LOOP directly reads from parameter
          const loopReadNames = await getReadsFromTargetNames(backend, whileLoop.id);
          assert.ok(
            loopReadNames.includes('n'),
            `LOOP READS_FROM should include 'n', got: [${loopReadNames.join(', ')}]`
          );
        }
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 8: MemberExpression in while condition
  // ===========================================================================

  describe('MemberExpression in while condition', () => {
    it('should create READS_FROM edge to the object of MemberExpression', async () => {
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
        let whileLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'while') {
            whileLoop = node;
            break;
          }
        }
        assert.ok(whileLoop, 'Should find while LOOP node');

        // V2: HAS_CONDITION -> PROPERTY_ACCESS(queue.length)
        const conditionEdges = await backend.getOutgoingEdges(whileLoop.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'while LOOP should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition node should exist');
        // V2: MemberExpression -> PROPERTY_ACCESS
        assert.strictEqual(
          conditionNode.type,
          'PROPERTY_ACCESS',
          `Condition should be PROPERTY_ACCESS, got ${conditionNode.type}`
        );

        // V2: PROPERTY_ACCESS has READS_FROM -> PARAMETER(queue)
        const targetNames = await getReadsFromTargetNames(backend, conditionNode.id);

        assert.ok(
          targetNames.includes('queue'),
          `READS_FROM should include 'queue', got: [${targetNames.join(', ')}]`
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
    it('should create READS_FROM edge from if condition to the variable', async () => {
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
        let ifBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.name === 'if') {
            ifBranch = node;
            break;
          }
        }
        assert.ok(ifBranch, 'Should find if BRANCH node');

        // V2: Simple identifier condition -- may have HAS_CONDITION or direct READS_FROM
        const conditionEdges = await backend.getOutgoingEdges(ifBranch.id, ['HAS_CONDITION']);
        let conditionNode = null;
        if (conditionEdges.length > 0) {
          conditionNode = await backend.getNode(conditionEdges[0].dst);
        }

        if (conditionNode && conditionNode.type === 'EXPRESSION') {
          const targetNames = await getReadsFromTargetNames(backend, conditionNode.id);
          assert.ok(
            targetNames.includes('value'),
            `READS_FROM should include 'value', got: [${targetNames.join(', ')}]`
          );
        } else {
          // V2: BRANCH directly has READS_FROM -> PARAMETER(value)
          const branchReadNames = await getReadsFromTargetNames(backend, ifBranch.id);
          assert.ok(
            branchReadNames.includes('value'),
            `BRANCH READS_FROM should include 'value', got: [${branchReadNames.join(', ')}]`
          );
        }
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ===========================================================================
  // GROUP 10: BinaryExpression in if condition
  // ===========================================================================

  describe('BinaryExpression in if condition', () => {
    it('should create READS_FROM edges for both operands of if condition', async () => {
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
        let ifBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.name === 'if') {
            ifBranch = node;
            break;
          }
        }
        assert.ok(ifBranch, 'Should find if BRANCH node');

        const conditionEdges = await backend.getOutgoingEdges(ifBranch.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'if BRANCH should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');
        assert.strictEqual(conditionNode.name, '>', 'Condition should be ">" expression');

        const targetNames = await getReadsFromTargetNames(backend, conditionNode.id);

        assert.ok(
          targetNames.includes('a'),
          `READS_FROM should include 'a', got: [${targetNames.join(', ')}]`
        );
        assert.ok(
          targetNames.includes('b'),
          `READS_FROM should include 'b', got: [${targetNames.join(', ')}]`
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
    it('should NOT create READS_FROM edge for this in while condition', async () => {
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
        let whileLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'while') {
            whileLoop = node;
            break;
          }
        }
        assert.ok(whileLoop, 'Should find while LOOP node');

        // V2: HAS_CONDITION -> PROPERTY_ACCESS(this.running)
        const conditionEdges = await backend.getOutgoingEdges(whileLoop.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'while LOOP should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition node should exist');

        // V2: PROPERTY_ACCESS(this.running) should NOT have READS_FROM to 'this'
        // It has CONTAINS -> LITERAL(this) instead
        const readsFromNames = await getReadsFromTargetNames(backend, conditionNode.id);

        for (const name of readsFromNames) {
          assert.notStrictEqual(
            name,
            'this',
            'Should NOT have READS_FROM edge to this (ThisExpression is a skip case)'
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
    it('should create READS_FROM edges from LogicalExpression condition to both operands', async () => {
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
        let ifBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.name === 'if') {
            ifBranch = node;
            break;
          }
        }
        assert.ok(ifBranch, 'Should find if BRANCH node');

        const conditionEdges = await backend.getOutgoingEdges(ifBranch.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'if BRANCH should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');
        assert.strictEqual(conditionNode.name, '&&', 'Condition should be "&&" expression');

        const targetNames = await getReadsFromTargetNames(backend, conditionNode.id);

        assert.ok(
          targetNames.includes('name'),
          `READS_FROM should include 'name', got: [${targetNames.join(', ')}]`
        );
        assert.ok(
          targetNames.includes('age'),
          `READS_FROM should include 'age', got: [${targetNames.join(', ')}]`
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
    it('should create READS_FROM edge from do-while condition EXPRESSION to operands', async () => {
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
        let doWhileLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'do-while') {
            doWhileLoop = node;
            break;
          }
        }
        assert.ok(doWhileLoop, 'Should find do-while LOOP node');

        const conditionEdges = await backend.getOutgoingEdges(doWhileLoop.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'do-while LOOP should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');
        assert.strictEqual(conditionNode.name, '<', 'Condition should be "<" expression');

        const targetNames = await getReadsFromTargetNames(backend, conditionNode.id);

        assert.ok(
          targetNames.includes('count'),
          `READS_FROM should include 'count', got: [${targetNames.join(', ')}]`
        );
        assert.ok(
          targetNames.includes('attempts'),
          `READS_FROM should include 'attempts', got: [${targetNames.join(', ')}]`
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
    it('should create READS_FROM edges for complex condition with MemberExpression operands', async () => {
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
        let forLoop = null;
        for await (const node of backend.queryNodes({ type: 'LOOP' })) {
          if (node.loopType === 'for') {
            forLoop = node;
            break;
          }
        }
        assert.ok(forLoop, 'Should find for LOOP node');

        const conditionEdges = await backend.getOutgoingEdges(forLoop.id, ['HAS_CONDITION']);
        assert.ok(conditionEdges.length >= 1, 'for LOOP should have HAS_CONDITION edge');

        const conditionNode = await backend.getNode(conditionEdges[0].dst);
        assert.ok(conditionNode, 'Condition EXPRESSION node should exist');

        // V2: EXPRESSION("<") -> READS_FROM -> VARIABLE(i)
        const targetNames = await getReadsFromTargetNames(backend, conditionNode.id);

        assert.ok(
          targetNames.includes('i'),
          `READS_FROM should include 'i', got: [${targetNames.join(', ')}]`
        );

        // V2: arr.length is accessed via USES -> PROPERTY_ACCESS(arr.length)
        // which in turn has READS_FROM -> PARAMETER(arr)
        // So we check the USES edge targets for completeness
        const usesNames = await getEdgeTargetNames(backend, conditionNode.id, ['USES']);
        // Should USE the arr.length PROPERTY_ACCESS
        const usesArrLength = usesNames.some(n => n.includes('arr'));
        // Either direct READS_FROM to arr or USES to arr.length
        assert.ok(
          targetNames.includes('arr') || usesArrLength,
          `Should reference 'arr' via READS_FROM or USES, got reads: [${targetNames.join(', ')}], uses: [${usesNames.join(', ')}]`
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
    it('should create READS_FROM edge from switch to discriminant variable', async () => {
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
        let switchBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.name === 'switch') {
            switchBranch = node;
            break;
          }
        }
        assert.ok(switchBranch, 'Should find switch BRANCH node');

        // V2: Simple identifier switch(status) -- BRANCH directly READS_FROM parameter
        // (No HAS_CONDITION -> EXPRESSION for simple identifiers)
        const conditionEdges = await backend.getOutgoingEdges(switchBranch.id, ['HAS_CONDITION']);
        let conditionNode = null;
        if (conditionEdges.length > 0) {
          conditionNode = await backend.getNode(conditionEdges[0].dst);
        }

        if (conditionNode && (conditionNode.type === 'EXPRESSION' || conditionNode.type === 'PROPERTY_ACCESS')) {
          const targetNames = await getReadsFromTargetNames(backend, conditionNode.id);
          assert.ok(
            targetNames.includes('status'),
            `READS_FROM should include 'status', got: [${targetNames.join(', ')}]`
          );
        } else {
          // V2: BRANCH directly has READS_FROM -> PARAMETER(status)
          const branchReadNames = await getReadsFromTargetNames(backend, switchBranch.id);
          assert.ok(
            branchReadNames.includes('status'),
            `BRANCH READS_FROM should include 'status', got: [${branchReadNames.join(', ')}]`
          );
        }
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });
});
