/**
 * Break/Continue Label TARGETS Edge Tests (REG-601)
 *
 * Tests that labeled break/continue statements create TARGETS edges
 * to their target LABEL nodes in the graph.
 *
 * Acceptance criteria:
 * - break outerLoop → EXPRESSION('break') --TARGETS--> LABEL('outerLoop')
 * - continue myLabel → EXPRESSION('continue') --TARGETS--> LABEL('myLabel')
 * - Unlabeled break/continue → no TARGETS edge
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(cleanupAllTestDatabases);
import { setupSemanticTest } from '../helpers/setupSemanticTest.js';

const TEST_LABEL = 'break-continue-targets';

async function setupTest(backend, files) {
  return setupSemanticTest(backend, files, { testLabel: TEST_LABEL });
}

describe('Break/Continue Label TARGETS Edges (REG-601)', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  describe('labeled break', () => {
    it('should create TARGETS edge from break to its label', async () => {
      await setupTest(backend, {
        'index.js': `
outer: for (let i = 0; i < 5; i++) {
  for (let j = 0; j < 5; j++) {
    if (i === 2 && j === 2) break outer;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const labelNode = allNodes.find(n => n.type === 'LABEL' && n.name === 'outer');
      assert.ok(labelNode, 'Should find LABEL node "outer"');

      const breakNode = allNodes.find(n => n.type === 'EXPRESSION' && n.name === 'break');
      assert.ok(breakNode, 'Should find EXPRESSION node "break"');

      const targetsEdge = allEdges.find(e =>
        e.type === 'TARGETS' &&
        e.src === breakNode.id &&
        e.dst === labelNode.id
      );
      assert.ok(targetsEdge,
        `Should have TARGETS edge from break to label. ` +
        `Break ID: ${breakNode.id}, Label ID: ${labelNode.id}. ` +
        `All TARGETS edges: ${JSON.stringify(allEdges.filter(e => e.type === 'TARGETS'))}`
      );
    });

    it('should create TARGETS edge for break in labeled block', async () => {
      await setupTest(backend, {
        'index.js': `
function test() {
  block: {
    if (true) break block;
    unreachable();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const labelNode = allNodes.find(n => n.type === 'LABEL' && n.name === 'block');
      assert.ok(labelNode, 'Should find LABEL node "block"');

      const breakNode = allNodes.find(n => n.type === 'EXPRESSION' && n.name === 'break');
      assert.ok(breakNode, 'Should find EXPRESSION node "break"');

      const targetsEdge = allEdges.find(e =>
        e.type === 'TARGETS' &&
        e.src === breakNode.id &&
        e.dst === labelNode.id
      );
      assert.ok(targetsEdge,
        `Should have TARGETS edge from break to label "block". ` +
        `All TARGETS edges: ${JSON.stringify(allEdges.filter(e => e.type === 'TARGETS'))}`
      );
    });
  });

  describe('labeled continue', () => {
    it('should create TARGETS edge from continue to its label', async () => {
      await setupTest(backend, {
        'index.js': `
const results = [];
loop: for (let i = 0; i < 5; i++) {
  if (i === 3) continue loop;
  results.push(i);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const labelNode = allNodes.find(n => n.type === 'LABEL' && n.name === 'loop');
      assert.ok(labelNode, 'Should find LABEL node "loop"');

      const continueNode = allNodes.find(n => n.type === 'EXPRESSION' && n.name === 'continue');
      assert.ok(continueNode, 'Should find EXPRESSION node "continue"');

      const targetsEdge = allEdges.find(e =>
        e.type === 'TARGETS' &&
        e.src === continueNode.id &&
        e.dst === labelNode.id
      );
      assert.ok(targetsEdge,
        `Should have TARGETS edge from continue to label. ` +
        `Continue ID: ${continueNode.id}, Label ID: ${labelNode.id}. ` +
        `All TARGETS edges: ${JSON.stringify(allEdges.filter(e => e.type === 'TARGETS'))}`
      );
    });

    it('should create TARGETS edge for continue targeting outer loop', async () => {
      await setupTest(backend, {
        'index.js': `
outerLoop: for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 3; j++) {
    if (j === 1) continue outerLoop;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const labelNode = allNodes.find(n => n.type === 'LABEL' && n.name === 'outerLoop');
      assert.ok(labelNode, 'Should find LABEL node "outerLoop"');

      const continueNode = allNodes.find(n => n.type === 'EXPRESSION' && n.name === 'continue');
      assert.ok(continueNode, 'Should find EXPRESSION node "continue"');

      const targetsEdge = allEdges.find(e =>
        e.type === 'TARGETS' &&
        e.src === continueNode.id &&
        e.dst === labelNode.id
      );
      assert.ok(targetsEdge,
        `Should have TARGETS edge from continue to outerLoop label. ` +
        `All TARGETS edges: ${JSON.stringify(allEdges.filter(e => e.type === 'TARGETS'))}`
      );
    });
  });

  describe('unlabeled break/continue', () => {
    it('should NOT create TARGETS edge for unlabeled break', async () => {
      await setupTest(backend, {
        'index.js': `
for (let i = 0; i < 5; i++) {
  if (i === 3) break;
}
        `
      });

      const allEdges = await backend.getAllEdges();

      const targetsEdges = allEdges.filter(e => e.type === 'TARGETS');
      assert.strictEqual(targetsEdges.length, 0,
        `Unlabeled break should not create TARGETS edges. Found: ${JSON.stringify(targetsEdges)}`
      );
    });

    it('should NOT create TARGETS edge for unlabeled continue', async () => {
      await setupTest(backend, {
        'index.js': `
for (let i = 0; i < 5; i++) {
  if (i === 3) continue;
  console.log(i);
}
        `
      });

      const allEdges = await backend.getAllEdges();

      const targetsEdges = allEdges.filter(e => e.type === 'TARGETS');
      assert.strictEqual(targetsEdges.length, 0,
        `Unlabeled continue should not create TARGETS edges. Found: ${JSON.stringify(targetsEdges)}`
      );
    });
  });

  describe('labeled for-switch interaction', () => {
    it('should create TARGETS edges for both break and continue with labels', async () => {
      await setupTest(backend, {
        'index.js': `
function process(items) {
  const processed = [];
  loop: for (const item of items) {
    switch (item.type) {
      case 'skip': continue loop;
      case 'stop': break loop;
      case 'data': processed.push(item); break;
    }
  }
  return processed;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const labelNode = allNodes.find(n => n.type === 'LABEL' && n.name === 'loop');
      assert.ok(labelNode, 'Should find LABEL node "loop"');

      // Only labeled break/continue should have TARGETS edges
      const targetsEdges = allEdges.filter(e => e.type === 'TARGETS');

      // Should have exactly 2 TARGETS edges (continue loop + break loop)
      // The unlabeled `break` in case 'data' should NOT have TARGETS
      assert.strictEqual(targetsEdges.length, 2,
        `Should have exactly 2 TARGETS edges (continue loop + break loop). ` +
        `Found: ${JSON.stringify(targetsEdges)}`
      );

      // Both should point to the same label
      for (const edge of targetsEdges) {
        assert.strictEqual(edge.dst, labelNode.id,
          `TARGETS edge should point to label "loop". Got dst: ${edge.dst}`
        );
      }
    });
  });
});
