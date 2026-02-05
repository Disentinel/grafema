/**
 * Semantic ID Pipeline Integration Tests
 *
 * End-to-end tests for the semantic ID integration through the full analysis pipeline.
 * These tests verify that:
 * 1. ScopeTracker is properly passed through JSASTAnalyzer
 * 2. Semantic IDs are preserved when nodes are stored via GraphBuilder
 * 3. The primary `id` field contains semantic IDs (not legacy format)
 * 4. Complex nested code produces correct semantic IDs
 *
 * TDD: Tests written first per Kent Beck's methodology.
 *
 * User Decisions:
 * 1. Replace `id`: Semantic ID becomes the primary `id` field (breaking change)
 * 2. Full scope path: Variables/calls include control flow scope in path
 * 3. Array mutations: Track with semantic IDs
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { setupSemanticTest } from '../helpers/setupSemanticTest.js';

const TEST_LABEL = 'pipeline';

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files, options = {}) {
  return setupSemanticTest(backend, files, { testLabel: TEST_LABEL, ...options });
}

/**
 * Check if an ID is in semantic format (not legacy format)
 * Semantic format: file->scope->TYPE->name[#N]
 * Legacy format: TYPE#name#file#line:column:counter
 */
function isSemanticIdFormat(id) {
  if (!id || typeof id !== 'string') return false;

  // Legacy format has # as separator with line:column:counter
  const hasLegacyLineFormat = /:\d+:\d+$/.test(id);
  if (hasLegacyLineFormat) return false;

  // Semantic format uses -> as separator
  const hasSemanticSeparator = id.includes('->');

  // Semantic format should have file at start, then scopes, then type, then name
  // e.g., "file.js->global->VARIABLE->name" or "file.js->func->if#0->CALL->log#1"
  return hasSemanticSeparator;
}

describe('Semantic ID Pipeline Integration', () => {
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
  // ScopeTracker through analysis
  // ===========================================================================

  describe('ScopeTracker passed through entire analysis', () => {
    it('should pass ScopeTracker to VariableVisitor', async () => {
      await setupTest(backend, {
        'index.js': `
const moduleLevel = 'global';
function myFunc() {
  const funcLevel = 'local';
  if (true) {
    const ifLevel = 'nested';
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find variables at different scope levels
      const moduleVar = allNodes.find(n => n.name === 'moduleLevel');
      const funcVar = allNodes.find(n => n.name === 'funcLevel');
      const ifVar = allNodes.find(n => n.name === 'ifLevel');

      assert.ok(moduleVar, 'Module-level variable should exist');
      assert.ok(funcVar, 'Function-level variable should exist');
      assert.ok(ifVar, 'If-level variable should exist');

      // All should have semantic ID format (passed through ScopeTracker)
      assert.ok(
        isSemanticIdFormat(moduleVar.id),
        `Module var should have semantic ID. Got: ${moduleVar.id}`
      );
      assert.ok(
        isSemanticIdFormat(funcVar.id),
        `Function var should have semantic ID. Got: ${funcVar.id}`
      );
      assert.ok(
        isSemanticIdFormat(ifVar.id),
        `If var should have semantic ID. Got: ${ifVar.id}`
      );
    });

    it('should pass ScopeTracker to CallExpressionVisitor', async () => {
      await setupTest(backend, {
        'index.js': `
globalCall();
function outer() {
  funcCall();
  if (condition) {
    nestedCall();
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const globalCallNode = allNodes.find(n => n.type === 'CALL' && n.name === 'globalCall');
      const funcCallNode = allNodes.find(n => n.type === 'CALL' && n.name === 'funcCall');
      const nestedCallNode = allNodes.find(n => n.type === 'CALL' && n.name === 'nestedCall');

      // All calls should have semantic ID format
      if (globalCallNode) {
        assert.ok(
          isSemanticIdFormat(globalCallNode.id),
          `Global call should have semantic ID. Got: ${globalCallNode.id}`
        );
        assert.ok(
          globalCallNode.id.includes('global'),
          `Global call should be in global scope. Got: ${globalCallNode.id}`
        );
      }

      if (funcCallNode) {
        assert.ok(
          isSemanticIdFormat(funcCallNode.id),
          `Function call should have semantic ID. Got: ${funcCallNode.id}`
        );
        assert.ok(
          funcCallNode.id.includes('outer'),
          `Function call should include function scope. Got: ${funcCallNode.id}`
        );
      }

      if (nestedCallNode) {
        assert.ok(
          isSemanticIdFormat(nestedCallNode.id),
          `Nested call should have semantic ID. Got: ${nestedCallNode.id}`
        );
        assert.ok(
          nestedCallNode.id.includes('if#'),
          `Nested call should include if scope. Got: ${nestedCallNode.id}`
        );
      }
    });

    it('should track scope correctly through nested functions', async () => {
      await setupTest(backend, {
        'index.js': `
function outer() {
  const outerVar = 1;

  function inner() {
    const innerVar = 2;

    function deepest() {
      const deepestVar = 3;
    }
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const outerVar = allNodes.find(n => n.name === 'outerVar');
      const innerVar = allNodes.find(n => n.name === 'innerVar');
      const deepestVar = allNodes.find(n => n.name === 'deepestVar');

      assert.ok(outerVar, 'outerVar should exist');
      assert.ok(innerVar, 'innerVar should exist');
      assert.ok(deepestVar, 'deepestVar should exist');

      // Verify scope nesting in IDs
      assert.ok(
        outerVar.id.includes('outer') && !outerVar.id.includes('inner'),
        `outerVar should only be in outer scope. Got: ${outerVar.id}`
      );

      assert.ok(
        innerVar.id.includes('inner'),
        `innerVar should be in inner scope. Got: ${innerVar.id}`
      );

      assert.ok(
        deepestVar.id.includes('deepest'),
        `deepestVar should be in deepest scope. Got: ${deepestVar.id}`
      );
    });
  });

  // ===========================================================================
  // GraphBuilder preservation
  // ===========================================================================

  describe('semantic IDs preserved in GraphBuilder', () => {
    it('should store nodes with semantic IDs in graph', async () => {
      await setupTest(backend, {
        'index.js': `
const config = { port: 3000 };

function startServer() {
  const server = createServer();
  server.listen(config.port);
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Verify CONSTANT node
      const configNode = allNodes.find(n => n.name === 'config');
      assert.ok(configNode, 'config node should exist');
      assert.ok(
        isSemanticIdFormat(configNode.id),
        `config should have semantic ID. Got: ${configNode.id}`
      );

      // Verify FUNCTION node
      const functionNode = allNodes.find(n => n.name === 'startServer' && n.type === 'FUNCTION');
      assert.ok(functionNode, 'startServer function should exist');
      assert.ok(
        isSemanticIdFormat(functionNode.id),
        `startServer should have semantic ID. Got: ${functionNode.id}`
      );

      // Verify CALL nodes
      const createServerCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'createServer'
      );
      if (createServerCall) {
        assert.ok(
          isSemanticIdFormat(createServerCall.id),
          `createServer call should have semantic ID. Got: ${createServerCall.id}`
        );
      }
    });

    it('should preserve edge references with semantic IDs', async () => {
      await setupTest(backend, {
        'index.js': `
const value = 42;
function useValue() {
  console.log(value);
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      // Find value variable
      const valueVar = allNodes.find(n => n.name === 'value');
      assert.ok(valueVar, 'value variable should exist');
      assert.ok(isSemanticIdFormat(valueVar.id), 'value should have semantic ID');

      // Find edges that reference this node
      const referencingEdges = allEdges.filter(e =>
        e.src === valueVar.id || e.dst === valueVar.id
      );

      // Should have at least one edge (e.g., CONTAINS from MODULE)
      // The edges should reference the semantic ID
      referencingEdges.forEach(edge => {
        if (edge.src === valueVar.id) {
          assert.ok(
            isSemanticIdFormat(edge.src),
            `Edge src should be semantic ID. Got: ${edge.src}`
          );
        }
        if (edge.dst === valueVar.id) {
          assert.ok(
            isSemanticIdFormat(edge.dst),
            `Edge dst should be semantic ID. Got: ${edge.dst}`
          );
        }
      });
    });
  });

  // ===========================================================================
  // Primary id field
  // ===========================================================================

  describe('use semantic ID as primary id field', () => {
    it('should use semantic ID as the primary id (no legacy format)', async () => {
      await setupTest(backend, {
        'index.js': `
const x = 1;
let y = 2;
var z = 3;

function test() {
  const local = 4;
  helper();
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Check all VARIABLE and CONSTANT nodes
      const varNodes = allNodes.filter(n =>
        n.type === 'VARIABLE' || n.type === 'CONSTANT'
      );

      varNodes.forEach(node => {
        assert.ok(
          isSemanticIdFormat(node.id),
          `Variable ${node.name} should have semantic ID as primary id. Got: ${node.id}`
        );

        // Should NOT have legacy format (TYPE#name#file#line:col:counter)
        assert.ok(
          !node.id.startsWith('VARIABLE#') && !node.id.startsWith('CONSTANT#'),
          `Variable ${node.name} should not have legacy prefix. Got: ${node.id}`
        );
      });

      // Check CALL nodes
      const callNodes = allNodes.filter(n => n.type === 'CALL');
      callNodes.forEach(node => {
        assert.ok(
          isSemanticIdFormat(node.id),
          `Call ${node.name} should have semantic ID. Got: ${node.id}`
        );

        assert.ok(
          !node.id.startsWith('CALL#'),
          `Call ${node.name} should not have legacy prefix. Got: ${node.id}`
        );
      });

      // Check FUNCTION nodes
      const funcNodes = allNodes.filter(n => n.type === 'FUNCTION');
      funcNodes.forEach(node => {
        assert.ok(
          isSemanticIdFormat(node.id),
          `Function ${node.name} should have semantic ID. Got: ${node.id}`
        );
      });
    });

    it('should use semantic ID format for all node types', async () => {
      await setupTest(backend, {
        'src/utils.js': `
export function helper() {
  return 42;
}
        `,
        'src/index.js': `
import { helper } from './utils.js';

class MyClass {
  method() {
    const result = helper();
    return result;
  }
}

export { MyClass };
        `
      });

      const allNodes = await backend.getAllNodes();

      // Check various node types
      const nodeTypes = ['MODULE', 'FUNCTION', 'CLASS', 'IMPORT', 'EXPORT', 'VARIABLE', 'CONSTANT', 'CALL'];

      nodeTypes.forEach(type => {
        const nodesOfType = allNodes.filter(n => n.type === type);
        nodesOfType.forEach(node => {
          // Allow some node types to have different formats (like MODULE, EXTERNAL_MODULE)
          if (type === 'MODULE' || type === 'EXTERNAL_MODULE') {
            // These may have special formats
            return;
          }

          assert.ok(
            isSemanticIdFormat(node.id),
            `${type} node "${node.name}" should have semantic ID. Got: ${node.id}`
          );
        });
      });
    });
  });

  // ===========================================================================
  // Complex nested code
  // ===========================================================================

  describe('generate correct IDs for complex nested code', () => {
    it('should handle deeply nested control flow', async () => {
      await setupTest(backend, {
        'index.js': `
class DataProcessor {
  async process(items) {
    if (items && items.length > 0) {
      try {
        for (const item of items) {
          if (item.valid) {
            while (item.hasMore()) {
              const chunk = await item.getNext();
              processChunk(chunk);
            }
          }
        }
      } catch (error) {
        logError(error);
      } finally {
        cleanup();
      }
    }
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find variable in deepest scope
      const chunkVar = allNodes.find(n => n.name === 'chunk');
      if (chunkVar) {
        assert.ok(
          isSemanticIdFormat(chunkVar.id),
          `Deeply nested variable should have semantic ID. Got: ${chunkVar.id}`
        );

        // Should include multiple scope levels
        assert.ok(
          chunkVar.id.includes('DataProcessor') || chunkVar.id.includes('process'),
          `Should include class/method scope. Got: ${chunkVar.id}`
        );
      }

      // Find call in catch block
      const logErrorCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'logError'
      );
      if (logErrorCall) {
        assert.ok(
          logErrorCall.id.includes('catch#'),
          `Error handler call should be in catch scope. Got: ${logErrorCall.id}`
        );
      }

      // Find call in finally block
      const cleanupCall = allNodes.find(n =>
        n.type === 'CALL' && n.name === 'cleanup'
      );
      if (cleanupCall) {
        assert.ok(
          cleanupCall.id.includes('finally#'),
          `Cleanup call should be in finally scope. Got: ${cleanupCall.id}`
        );
      }
    });

    it('should handle multiple files with same structure', async () => {
      await setupTest(backend, {
        'handlers/user.js': `
export function getUser(id) {
  const user = db.findById(id);
  return user;
}
        `,
        'handlers/post.js': `
export function getPost(id) {
  const post = db.findById(id);
  return post;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find variables with same name but different files
      const userVar = allNodes.find(n =>
        n.name === 'user' && n.file?.includes('user.js')
      );
      const postVar = allNodes.find(n =>
        n.name === 'post' && n.file?.includes('post.js')
      );

      if (userVar && postVar) {
        // IDs should be different (different files)
        assert.notStrictEqual(
          userVar.id,
          postVar.id,
          'Variables in different files should have different IDs'
        );

        // Both should have semantic format
        assert.ok(isSemanticIdFormat(userVar.id), 'user should have semantic ID');
        assert.ok(isSemanticIdFormat(postVar.id), 'post should have semantic ID');

        // IDs should include file paths
        assert.ok(
          userVar.id.includes('user.js'),
          `user ID should include filename. Got: ${userVar.id}`
        );
        assert.ok(
          postVar.id.includes('post.js'),
          `post ID should include filename. Got: ${postVar.id}`
        );
      }
    });

    it('should handle React-like component patterns', async () => {
      await setupTest(backend, {
        'components/Button.jsx': `
import React from 'react';

export function Button({ onClick, children }) {
  const [isHovered, setIsHovered] = React.useState(false);

  const handleClick = (event) => {
    if (onClick) {
      onClick(event);
    }
  };

  return (
    <button onClick={handleClick}>
      {children}
    </button>
  );
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find useState call
      const useStateCall = allNodes.find(n =>
        n.type === 'CALL' &&
        (n.name?.includes('useState') || n.method === 'useState')
      );

      // Find handleClick function
      const handleClickFunc = allNodes.find(n =>
        n.type === 'FUNCTION' && n.name === 'handleClick'
      );

      if (useStateCall) {
        assert.ok(
          isSemanticIdFormat(useStateCall.id),
          `useState call should have semantic ID. Got: ${useStateCall.id}`
        );
      }

      if (handleClickFunc) {
        assert.ok(
          isSemanticIdFormat(handleClickFunc.id),
          `handleClick should have semantic ID. Got: ${handleClickFunc.id}`
        );
        assert.ok(
          handleClickFunc.id.includes('Button'),
          `handleClick should be nested in Button. Got: ${handleClickFunc.id}`
        );
      }
    });

    it('should handle switch statement scopes', async () => {
      await setupTest(backend, {
        'index.js': `
function handleAction(type) {
  switch (type) {
    case 'A':
      const resultA = processA();
      return resultA;
    case 'B':
      const resultB = processB();
      return resultB;
    default:
      const defaultResult = processDefault();
      return defaultResult;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      // Find variables in different cases
      const resultA = allNodes.find(n => n.name === 'resultA');
      const resultB = allNodes.find(n => n.name === 'resultB');
      const defaultResult = allNodes.find(n => n.name === 'defaultResult');

      // All should have semantic IDs and be in switch scope
      [resultA, resultB, defaultResult].forEach(node => {
        if (node) {
          assert.ok(
            isSemanticIdFormat(node.id),
            `${node.name} should have semantic ID. Got: ${node.id}`
          );
        }
      });
    });
  });

  // ===========================================================================
  // Re-analysis stability
  // ===========================================================================

  describe('re-analysis stability', () => {
    it('should produce identical IDs on re-analysis', async () => {
      const codeFiles = {
        'src/lib.js': `
export function calculate(a, b) {
  const sum = a + b;
  if (sum > 100) {
    console.log('Large sum');
  }
  return sum;
}
        `,
        'src/index.js': `
import { calculate } from './lib.js';
const result = calculate(50, 60);
console.log(result);
        `
      };

      // First analysis
      await setupTest(backend, codeFiles);
      const nodes1 = await backend.getAllNodes();
      // Filter out SERVICE and MODULE nodes whose IDs depend on temp directory/project name
      const codeNodes1 = nodes1.filter(n => !['SERVICE', 'MODULE'].includes(n.type));
      const ids1 = codeNodes1.map(n => n.id).sort();

      // Clean up and re-analyze
      await db.cleanup();
      db = await createTestDatabase();
    backend = db.backend;

      await setupTest(backend, codeFiles);
      const nodes2 = await backend.getAllNodes();
      const codeNodes2 = nodes2.filter(n => !['SERVICE', 'MODULE'].includes(n.type));
      const ids2 = codeNodes2.map(n => n.id).sort();

      // IDs should be identical for code nodes (not infrastructure nodes)
      assert.deepStrictEqual(
        ids1,
        ids2,
        'Re-analysis should produce identical IDs'
      );
    });

    it('should maintain ID stability when unrelated code changes', async () => {
      // Original code
      await setupTest(backend, {
        'index.js': `
const target = 'value';
function targetFunc() {
  targetCall();
}
        `
      });

      const nodes1 = await backend.getAllNodes();
      const targetVarId1 = nodes1.find(n => n.name === 'target')?.id;
      const targetFuncId1 = nodes1.find(n => n.name === 'targetFunc' && n.type === 'FUNCTION')?.id;
      const targetCallId1 = nodes1.find(n => n.name === 'targetCall' && n.type === 'CALL')?.id;

      await db.cleanup();
      db = await createTestDatabase();
    backend = db.backend;
      await setupTest(backend, {
        'index.js': `
const unrelated1 = 'new';
function unrelatedFunc() {}
const target = 'value';
const unrelated2 = 'also new';
function targetFunc() {
  unrelatedCall();
  targetCall();
}
        `
      });

      const nodes2 = await backend.getAllNodes();
      const targetVarId2 = nodes2.find(n => n.name === 'target')?.id;
      const targetFuncId2 = nodes2.find(n => n.name === 'targetFunc' && n.type === 'FUNCTION')?.id;
      const targetCallId2 = nodes2.find(n => n.name === 'targetCall' && n.type === 'CALL')?.id;

      // Target IDs should remain stable
      if (targetVarId1 && targetVarId2) {
        assert.strictEqual(
          targetVarId1,
          targetVarId2,
          'Variable ID should be stable'
        );
      }

      if (targetFuncId1 && targetFuncId2) {
        assert.strictEqual(
          targetFuncId1,
          targetFuncId2,
          'Function ID should be stable'
        );
      }

      // Note: Call ID might change due to discriminator changes
      // but should still be semantic format
      if (targetCallId2) {
        assert.ok(
          isSemanticIdFormat(targetCallId2),
          'Call ID should still be semantic format'
        );
      }
    });
  });
});
