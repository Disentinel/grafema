/**
 * Scope CONTAINS Edges Tests
 *
 * Tests for REG-274: CONTAINS edges should link CALL/VARIABLE nodes
 * to their actual conditional scope (if/else/loop/try/catch), not just
 * the function body scope.
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * These tests will fail until Rob implements the scope tracking fix.
 *
 * Key behavioral verification:
 * 1. Call inside `if` -> parentScopeId points to the if-scope
 * 2. Call inside nested `if` -> parentScopeId points to innermost if-scope
 * 3. Call inside `else` -> parentScopeId points to else-scope
 * 4. Call inside `for` loop -> parentScopeId points to loop-scope
 * 5. Call outside conditional -> parentScopeId is function body scope
 * 6. Variable inside conditional -> parentScopeId is the conditional scope
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createTestBackend } from '../helpers/TestRFDB.js';
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

/**
 * Find SCOPE node by scopeType pattern (e.g., 'if', 'else', 'for-loop')
 */
function findScopeNode(nodes, scopeTypePattern) {
  return nodes.find(n => n.type === 'SCOPE' && n.scopeType?.includes(scopeTypePattern));
}

/**
 * Find SCOPE node by ID
 */
function findScopeById(nodes, scopeId) {
  return nodes.find(n => n.type === 'SCOPE' && n.id === scopeId);
}

/**
 * Find CONTAINS edge from scope to target node
 */
function findContainsEdge(edges, targetNodeId) {
  return edges.find(e => e.type === 'CONTAINS' && e.dst === targetNodeId);
}

describe('Scope CONTAINS Edges (REG-274)', () => {
  let backend;

  beforeEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
    backend = createTestBackend();
    await backend.connect();
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  // ===========================================================================
  // Call inside if statement
  // ===========================================================================

  describe('Call inside if statement', () => {
    it('should link call to if-scope via CONTAINS edge', async () => {
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
      const allEdges = await backend.getAllEdges();

      // Find the deleteAllRecords call
      const deleteCall = findCallNode(allNodes, 'deleteAllRecords');
      assert.ok(deleteCall, 'deleteAllRecords call should exist');

      // Verify parentScopeId points to an if-scope, not function body
      assert.ok(
        deleteCall.parentScopeId,
        'deleteAllRecords should have parentScopeId'
      );

      // The parentScopeId should contain 'if' to indicate it's inside an if-scope
      assert.ok(
        deleteCall.parentScopeId.includes('if'),
        `parentScopeId should reference if-scope, got: ${deleteCall.parentScopeId}`
      );

      // Verify CONTAINS edge exists from the if-scope
      const containsEdge = findContainsEdge(allEdges, deleteCall.id);
      assert.ok(containsEdge, 'CONTAINS edge to deleteAllRecords should exist');

      // The source of CONTAINS edge should be the if-scope
      const sourceScope = findScopeById(allNodes, containsEdge.src);
      assert.ok(sourceScope, 'Source scope should exist');
      assert.ok(
        sourceScope.scopeType?.includes('if'),
        `CONTAINS edge source should be if-scope, got: ${sourceScope.scopeType}`
      );
    });

    it('should preserve semantic ID with if-scope in path', async () => {
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

      // Semantic ID should include if-scope in the path
      assert.ok(
        doWorkCall.id.includes('if#'),
        `Semantic ID should include if-scope: ${doWorkCall.id}`
      );
    });
  });

  // ===========================================================================
  // Call inside nested if statements
  // ===========================================================================

  describe('Call inside nested if statements', () => {
    it('should link call to innermost if-scope', async () => {
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
      const allEdges = await backend.getAllEdges();

      // Find the deleteAllRecords call
      const deleteCall = findCallNode(allNodes, 'deleteAllRecords');
      assert.ok(deleteCall, 'deleteAllRecords call should exist');

      // Semantic ID should include both if scopes
      // Format: file->function->if#0->if#0->CALL->deleteAllRecords#0
      const idParts = deleteCall.id.split('->');
      const ifCount = idParts.filter(part => part.startsWith('if#')).length;
      assert.strictEqual(
        ifCount,
        2,
        `Semantic ID should have 2 nested if scopes, got ${ifCount}: ${deleteCall.id}`
      );

      // Verify CONTAINS edge points to innermost if-scope
      const containsEdge = findContainsEdge(allEdges, deleteCall.id);
      assert.ok(containsEdge, 'CONTAINS edge should exist');

      // The source scope ID should be the innermost if
      assert.ok(
        containsEdge.src.includes('if#'),
        `CONTAINS source should be if-scope: ${containsEdge.src}`
      );
    });

    it('should link calls at different nesting levels to correct scopes', async () => {
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
      const allEdges = await backend.getAllEdges();

      // Find all calls
      const outerCall = findCallNode(allNodes, 'outerCall');
      const middleCall = findCallNode(allNodes, 'middleCall');
      const innerCall = findCallNode(allNodes, 'innerCall');

      assert.ok(outerCall, 'outerCall should exist');
      assert.ok(middleCall, 'middleCall should exist');
      assert.ok(innerCall, 'innerCall should exist');

      // outerCall should be in function body (no if in parentScopeId)
      assert.ok(
        !outerCall.parentScopeId?.includes('if'),
        `outerCall parentScopeId should be function body, not if-scope: ${outerCall.parentScopeId}`
      );

      // middleCall should have exactly 1 if in scope path
      const middleIfCount = (middleCall.id.match(/if#/g) || []).length;
      assert.strictEqual(
        middleIfCount,
        1,
        `middleCall should be in 1 if-scope, got ${middleIfCount}`
      );

      // innerCall should have exactly 2 ifs in scope path
      const innerIfCount = (innerCall.id.match(/if#/g) || []).length;
      assert.strictEqual(
        innerIfCount,
        2,
        `innerCall should be in 2 if-scopes, got ${innerIfCount}`
      );
    });
  });

  // ===========================================================================
  // Call inside else block
  // ===========================================================================

  describe('Call inside else block', () => {
    it('should link call to else-scope via CONTAINS edge', async () => {
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

      // Find the showError call
      const showErrorCall = findCallNode(allNodes, 'showError');
      assert.ok(showErrorCall, 'showError call should exist');

      // parentScopeId should reference else-scope
      assert.ok(
        showErrorCall.parentScopeId?.includes('else'),
        `showError parentScopeId should reference else-scope: ${showErrorCall.parentScopeId}`
      );

      // Semantic ID should include else-scope
      assert.ok(
        showErrorCall.id.includes('else#'),
        `Semantic ID should include else-scope: ${showErrorCall.id}`
      );

      // Verify CONTAINS edge source is else-scope
      const containsEdge = findContainsEdge(allEdges, showErrorCall.id);
      assert.ok(containsEdge, 'CONTAINS edge should exist');

      const sourceScope = findScopeById(allNodes, containsEdge.src);
      assert.ok(
        sourceScope?.scopeType?.includes('else'),
        `CONTAINS source should be else-scope: ${sourceScope?.scopeType}`
      );
    });

    it('should distinguish if-scope from else-scope', async () => {
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

      // successCall should be in if-scope
      assert.ok(
        successCall.id.includes('if#') && !successCall.id.includes('else#'),
        `successCall should be in if-scope only: ${successCall.id}`
      );

      // failCall should be in else-scope
      assert.ok(
        failCall.id.includes('else#'),
        `failCall should be in else-scope: ${failCall.id}`
      );

      // They should have different parentScopeIds
      assert.notStrictEqual(
        successCall.parentScopeId,
        failCall.parentScopeId,
        'if and else calls should have different parentScopeIds'
      );
    });
  });

  // ===========================================================================
  // Call inside for loop
  // ===========================================================================

  describe('Call inside for loop', () => {
    it('should link call to for-loop scope via CONTAINS edge', async () => {
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
      const allEdges = await backend.getAllEdges();

      // Find the processItem call
      const processItemCall = findCallNode(allNodes, 'processItem');
      assert.ok(processItemCall, 'processItem call should exist');

      // parentScopeId should reference a loop scope
      assert.ok(
        processItemCall.parentScopeId?.includes('for') ||
        processItemCall.parentScopeId?.includes('loop'),
        `processItem parentScopeId should reference loop-scope: ${processItemCall.parentScopeId}`
      );

      // Verify CONTAINS edge source is loop-scope
      const containsEdge = findContainsEdge(allEdges, processItemCall.id);
      assert.ok(containsEdge, 'CONTAINS edge should exist');

      const sourceScope = findScopeById(allNodes, containsEdge.src);
      assert.ok(
        sourceScope?.scopeType?.includes('for') ||
        sourceScope?.scopeType?.includes('loop'),
        `CONTAINS source should be loop-scope: ${sourceScope?.scopeType}`
      );
    });

    it('should handle while loop scope', async () => {
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

      // parentScopeId should reference while-loop scope
      assert.ok(
        checkStatusCall.parentScopeId?.includes('while') ||
        checkStatusCall.parentScopeId?.includes('loop'),
        `checkStatus parentScopeId should reference while-loop: ${checkStatusCall.parentScopeId}`
      );
    });

    it('should handle nested loop and conditional', async () => {
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

      // Should have both loop and if in the scope path
      assert.ok(
        handleValidCall.id.includes('for') || handleValidCall.id.includes('loop'),
        `handleValid ID should include loop scope: ${handleValidCall.id}`
      );
      assert.ok(
        handleValidCall.id.includes('if#'),
        `handleValid ID should include if scope: ${handleValidCall.id}`
      );
    });
  });

  // ===========================================================================
  // Call outside conditional (function body)
  // ===========================================================================

  describe('Call outside conditional (function body)', () => {
    it('should link call to function body scope', async () => {
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

      // parentScopeId should be function body (no if/else/loop)
      assert.ok(
        !directCall.parentScopeId?.includes('if') &&
        !directCall.parentScopeId?.includes('else') &&
        !directCall.parentScopeId?.includes('for') &&
        !directCall.parentScopeId?.includes('while'),
        `directCall parentScopeId should be function body: ${directCall.parentScopeId}`
      );

      // Semantic ID should not have conditional scopes
      assert.ok(
        !directCall.id.includes('if#') &&
        !directCall.id.includes('else#') &&
        !directCall.id.includes('for#'),
        `directCall semantic ID should not have conditional scopes: ${directCall.id}`
      );
    });

    it('should handle mix of conditional and non-conditional calls', async () => {
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

      // beforeCall and afterCall should be in function body (same scope)
      assert.ok(
        !beforeCall.id.includes('if#'),
        `beforeCall should not be in if-scope: ${beforeCall.id}`
      );
      assert.ok(
        !afterCall.id.includes('if#'),
        `afterCall should not be in if-scope: ${afterCall.id}`
      );

      // insideCall should be in if-scope
      assert.ok(
        insideCall.id.includes('if#'),
        `insideCall should be in if-scope: ${insideCall.id}`
      );

      // beforeCall and afterCall should have same parentScopeId (function body)
      assert.strictEqual(
        beforeCall.parentScopeId,
        afterCall.parentScopeId,
        'beforeCall and afterCall should share function body scope'
      );

      // insideCall should have different parentScopeId (if-scope)
      assert.notStrictEqual(
        beforeCall.parentScopeId,
        insideCall.parentScopeId,
        'insideCall should have different parentScopeId than function body calls'
      );
    });
  });

  // ===========================================================================
  // Variable inside conditional
  // ===========================================================================

  describe('Variable inside conditional scope', () => {
    it('should link variable to if-scope via parentScopeId', async () => {
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
      const allEdges = await backend.getAllEdges();

      const localVar = findVariableNode(allNodes, 'localVar');
      assert.ok(localVar, 'localVar should exist');

      // parentScopeId should reference if-scope
      assert.ok(
        localVar.parentScopeId?.includes('if'),
        `localVar parentScopeId should reference if-scope: ${localVar.parentScopeId}`
      );

      // Semantic ID should include if-scope
      assert.ok(
        localVar.id.includes('if#'),
        `localVar semantic ID should include if-scope: ${localVar.id}`
      );
    });

    it('should link variable to loop scope', async () => {
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

      // parentScopeId should reference loop scope
      assert.ok(
        processed.parentScopeId?.includes('for') ||
        processed.parentScopeId?.includes('loop'),
        `processed parentScopeId should reference loop-scope: ${processed.parentScopeId}`
      );
    });
  });

  // ===========================================================================
  // Try/catch/finally scopes
  // ===========================================================================

  describe('Try/catch/finally scopes', () => {
    it('should link call in try block to try-scope', async () => {
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

      // riskyCall should be in try-scope
      assert.ok(
        riskyCall.parentScopeId?.includes('try') ||
        riskyCall.id.includes('try#'),
        `riskyCall should be in try-scope: ${riskyCall.id}`
      );

      // handleError should be in catch-scope
      assert.ok(
        handleError.parentScopeId?.includes('catch') ||
        handleError.id.includes('catch#'),
        `handleError should be in catch-scope: ${handleError.id}`
      );

      // They should have different parentScopeIds
      assert.notStrictEqual(
        riskyCall.parentScopeId,
        handleError.parentScopeId,
        'try and catch calls should have different parentScopeIds'
      );
    });

    it('should link call in finally block to finally-scope', async () => {
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

      // cleanupCall should be in finally-scope
      assert.ok(
        cleanupCall.parentScopeId?.includes('finally') ||
        cleanupCall.id.includes('finally#'),
        `cleanupCall should be in finally-scope: ${cleanupCall.id}`
      );
    });
  });

  // ===========================================================================
  // CONTAINS edge verification
  // ===========================================================================

  describe('CONTAINS edge source verification', () => {
    it('should create CONTAINS edge from correct scope to call', async () => {
      await setupTest(backend, {
        'index.js': `
function example() {
  if (a) {
    if (b) {
      deepCall();
    }
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const deepCall = findCallNode(allNodes, 'deepCall');
      assert.ok(deepCall, 'deepCall should exist');

      // Find CONTAINS edge targeting deepCall
      const containsEdge = allEdges.find(e =>
        e.type === 'CONTAINS' && e.dst === deepCall.id
      );
      assert.ok(containsEdge, 'CONTAINS edge to deepCall should exist');

      // The source should be the innermost if-scope (if#1 or similar)
      // and match deepCall.parentScopeId
      assert.strictEqual(
        containsEdge.src,
        deepCall.parentScopeId,
        'CONTAINS edge source should match parentScopeId'
      );

      // Verify the source is actually an if-scope
      const sourceScope = allNodes.find(n => n.id === containsEdge.src);
      assert.ok(sourceScope, 'Source scope node should exist');
      assert.ok(
        sourceScope.type === 'SCOPE' && sourceScope.scopeType?.includes('if'),
        `Source should be if-scope: ${sourceScope.type}/${sourceScope.scopeType}`
      );
    });
  });
});
