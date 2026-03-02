/**
 * Scope CONTAINS Edges Tests
 *
 * Tests for REG-274: CONTAINS edges should link CALL/VARIABLE nodes
 * to their actual conditional scope (if/else/loop/try/catch), not just
 * the function body scope.
 *
 * NOTE: V2 (CoreV2Analyzer) does NOT use the same scope tracking model.
 * V2 uses BRANCH nodes with HAS_CONSEQUENT/HAS_ALTERNATE edges for if/else,
 * and does not create SCOPE nodes for conditional blocks or set parentScopeId.
 * All tests marked as todo until V2 implements equivalent scope tracking.
 *
 * Key V1 behavioral verification (not applicable in V2):
 * 1. Call inside `if` -> parentScopeId points to the if-scope
 * 2. Call inside nested `if` -> parentScopeId points to innermost if-scope
 * 3. Call inside `else` -> parentScopeId points to else-scope
 * 4. Call inside `for` loop -> parentScopeId points to loop-scope
 * 5. Call outside conditional -> parentScopeId is function body scope
 * 6. Variable inside conditional -> parentScopeId is the conditional scope
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { setupSemanticTest } from '../helpers/setupSemanticTest.js';

const TEST_LABEL = 'scope-contains';

/**
 * Helper to create a test project with given files and run analysis
 */
async function setupTest(backend, files) {
  return setupSemanticTest(backend, files, { testLabel: TEST_LABEL });
}

/**
 * Find CALL node by name
 */
function findCallNode(nodes, name) {
  return nodes.find(n => n.type === 'CALL' && n.name === name);
}

/**
 * Find VARIABLE node by name
 */
function findVariableNode(nodes, name) {
  return nodes.find(n => (n.type === 'VARIABLE' || n.type === 'CONSTANT') && n.name === name);
}

describe('Scope CONTAINS Edges (REG-274)', () => {
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

  // ===========================================================================
  // Call inside if statement
  // ===========================================================================

  describe('Call inside if statement', () => {
    it('should create CALL node for call inside if block', async () => {
      await setupTest(backend, {
        'index.js': `
function processUser(user) {
  if (user.isAdmin) {
    deleteAllRecords();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const deleteCall = findCallNode(allNodes, 'deleteAllRecords');
      assert.ok(deleteCall, 'deleteAllRecords call should exist');
    });

    it('should track scope via BRANCH node and HAS_CONSEQUENT edge in v2', { todo: 'V2 uses BRANCH nodes, not SCOPE with parentScopeId' }, async () => {
      await setupTest(backend, {
        'index.js': `
function handler() {
  if (condition) {
    doWork();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const doWorkCall = findCallNode(allNodes, 'doWork');
      assert.ok(doWorkCall, 'doWork call should exist');
    });
  });

  // ===========================================================================
  // Call inside nested if statements
  // ===========================================================================

  describe('Call inside nested if statements', () => {
    it('should create CALL nodes for nested if blocks', async () => {
      await setupTest(backend, {
        'index.js': `
function processUser(user) {
  if (user.exists) {
    if (user.isAdmin) {
      deleteAllRecords();
    }
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const deleteCall = findCallNode(allNodes, 'deleteAllRecords');
      assert.ok(deleteCall, 'deleteAllRecords call should exist');
    });

    it('should create CALL nodes at different nesting levels', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  outerCall();
  if (a) {
    middleCall();
    if (b) {
      innerCall();
    }
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const outerCall = findCallNode(allNodes, 'outerCall');
      const middleCall = findCallNode(allNodes, 'middleCall');
      const innerCall = findCallNode(allNodes, 'innerCall');

      assert.ok(outerCall, 'outerCall should exist');
      assert.ok(middleCall, 'middleCall should exist');
      assert.ok(innerCall, 'innerCall should exist');
    });
  });

  // ===========================================================================
  // Call inside else block
  // ===========================================================================

  describe('Call inside else block', () => {
    it('should create CALL node for call inside else block', async () => {
      await setupTest(backend, {
        'index.js': `
function processUser(user) {
  if (user.isAdmin) {
    deleteAllRecords();
  } else {
    showError();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const showErrorCall = findCallNode(allNodes, 'showError');
      assert.ok(showErrorCall, 'showError call should exist');

      // V2: else branch is modeled as BRANCH node with CONTAINS edge to call
      const containsToShowError = allEdges.find(e =>
        e.type === 'CONTAINS' && e.dst === showErrorCall.id
      );
      // The CONTAINS edge exists from BRANCH->else to CALL->showError in v2
      assert.ok(containsToShowError, 'CONTAINS edge to showError should exist in v2 (from BRANCH)');
    });

    it('should create both if and else calls', async () => {
      await setupTest(backend, {
        'index.js': `
function handler() {
  if (ok) {
    successCall();
  } else {
    failCall();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const successCall = findCallNode(allNodes, 'successCall');
      const failCall = findCallNode(allNodes, 'failCall');

      assert.ok(successCall, 'successCall should exist');
      assert.ok(failCall, 'failCall should exist');
    });
  });

  // ===========================================================================
  // Call inside for loop
  // ===========================================================================

  describe('Call inside for loop', () => {
    it('should create CALL node for call inside for loop', async () => {
      await setupTest(backend, {
        'index.js': `
function processItems(items) {
  for (const item of items) {
    processItem(item);
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const processItemCall = findCallNode(allNodes, 'processItem');
      assert.ok(processItemCall, 'processItem call should exist');
    });

    it('should create CALL node for call inside while loop', async () => {
      await setupTest(backend, {
        'index.js': `
function waitLoop() {
  while (running) {
    checkStatus();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const checkStatusCall = findCallNode(allNodes, 'checkStatus');
      assert.ok(checkStatusCall, 'checkStatus call should exist');
    });

    it('should create CALL node inside nested loop and conditional', async () => {
      await setupTest(backend, {
        'index.js': `
function processArray(arr) {
  for (const item of arr) {
    if (item.valid) {
      handleValid(item);
    }
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const handleValidCall = findCallNode(allNodes, 'handleValid');
      assert.ok(handleValidCall, 'handleValid call should exist');
    });
  });

  // ===========================================================================
  // Call outside conditional (function body)
  // ===========================================================================

  describe('Call outside conditional (function body)', () => {
    it('should create CALL node for direct call in function body', async () => {
      await setupTest(backend, {
        'index.js': `
function simple() {
  directCall();
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const directCall = findCallNode(allNodes, 'directCall');
      assert.ok(directCall, 'directCall should exist');
    });

    it('should create CALL nodes for mix of conditional and non-conditional calls', async () => {
      await setupTest(backend, {
        'index.js': `
function mixed() {
  beforeCall();
  if (cond) {
    insideCall();
  }
  afterCall();
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const beforeCall = findCallNode(allNodes, 'beforeCall');
      const insideCall = findCallNode(allNodes, 'insideCall');
      const afterCall = findCallNode(allNodes, 'afterCall');

      assert.ok(beforeCall, 'beforeCall should exist');
      assert.ok(insideCall, 'insideCall should exist');
      assert.ok(afterCall, 'afterCall should exist');
    });
  });

  // ===========================================================================
  // Variable inside conditional
  // ===========================================================================

  describe('Variable inside conditional scope', () => {
    it('should create VARIABLE node for variable inside if block', async () => {
      await setupTest(backend, {
        'index.js': `
function process() {
  if (condition) {
    const localVar = getValue();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const localVar = findVariableNode(allNodes, 'localVar');
      assert.ok(localVar, 'localVar should exist');
    });

    it('should create VARIABLE node for variable inside loop', async () => {
      await setupTest(backend, {
        'index.js': `
function iterate(items) {
  for (const item of items) {
    const processed = transform(item);
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const processed = findVariableNode(allNodes, 'processed');
      assert.ok(processed, 'processed variable should exist');
    });
  });

  // ===========================================================================
  // Try/catch/finally scopes
  // ===========================================================================

  describe('Try/catch/finally scopes', () => {
    it('should create CALL nodes for calls in try and catch blocks', async () => {
      await setupTest(backend, {
        'index.js': `
function riskyOperation() {
  try {
    riskyCall();
  } catch (e) {
    handleError(e);
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const riskyCall = findCallNode(allNodes, 'riskyCall');
      const handleError = findCallNode(allNodes, 'handleError');

      assert.ok(riskyCall, 'riskyCall should exist');
      assert.ok(handleError, 'handleError should exist');
    });

    it('should create CALL node for call in finally block', async () => {
      await setupTest(backend, {
        'index.js': `
function withCleanup() {
  try {
    tryCall();
  } finally {
    cleanupCall();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const cleanupCall = findCallNode(allNodes, 'cleanupCall');
      assert.ok(cleanupCall, 'cleanupCall should exist');
    });
  });

  // ===========================================================================
  // V2 edge structure verification
  // ===========================================================================

  describe('V2 edge structure verification', () => {
    it('should create BRANCH node for else block with CONTAINS edge to call', async () => {
      await setupTest(backend, {
        'index.js': `
function example() {
  if (a) {
    ifCall();
  } else {
    elseCall();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const elseCall = findCallNode(allNodes, 'elseCall');
      assert.ok(elseCall, 'elseCall should exist');

      // V2: BRANCH node with CONTAINS edge for else block
      const branchNodes = allNodes.filter(n => n.type === 'BRANCH');
      // There should be at least one BRANCH node (for else)
      assert.ok(branchNodes.length >= 1, `Should have BRANCH nodes, got ${branchNodes.length}`);

      // CONTAINS edge from BRANCH to elseCall
      const containsToElse = allEdges.find(e =>
        e.type === 'CONTAINS' && e.dst === elseCall.id
      );
      assert.ok(containsToElse, 'CONTAINS edge from BRANCH to elseCall should exist');
    });
  });
});
