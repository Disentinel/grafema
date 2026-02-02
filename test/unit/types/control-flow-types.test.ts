/**
 * Control Flow Types Tests (REG-267 Phase 1)
 *
 * Tests to verify that new control flow types compile and export correctly:
 * - Node types: LOOP, TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK
 * - Edge types: HAS_BODY, ITERATES_OVER, HAS_CONSEQUENT, HAS_ALTERNATE, HAS_CATCH, HAS_FINALLY
 * - Info interfaces: LoopInfo, TryBlockInfo, CatchBlockInfo, FinallyBlockInfo, ControlFlowMetadata
 *
 * TDD: These tests verify type definitions exist and are properly exported.
 * Tests will FAIL until the types are implemented.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// =============================================================================
// TESTS: Node Type Constants
// =============================================================================

describe('Control Flow Node Types (REG-267 Phase 1)', () => {
  describe('NODE_TYPE constants', () => {
    it('should export LOOP node type', async () => {
      const { NODE_TYPE } = await import('@grafema/types');

      assert.ok(NODE_TYPE.LOOP, 'NODE_TYPE should have LOOP constant');
      assert.strictEqual(NODE_TYPE.LOOP, 'LOOP', 'LOOP constant should equal "LOOP"');
    });

    it('should export TRY_BLOCK node type', async () => {
      const { NODE_TYPE } = await import('@grafema/types');

      assert.ok(NODE_TYPE.TRY_BLOCK, 'NODE_TYPE should have TRY_BLOCK constant');
      assert.strictEqual(NODE_TYPE.TRY_BLOCK, 'TRY_BLOCK', 'TRY_BLOCK constant should equal "TRY_BLOCK"');
    });

    it('should export CATCH_BLOCK node type', async () => {
      const { NODE_TYPE } = await import('@grafema/types');

      assert.ok(NODE_TYPE.CATCH_BLOCK, 'NODE_TYPE should have CATCH_BLOCK constant');
      assert.strictEqual(NODE_TYPE.CATCH_BLOCK, 'CATCH_BLOCK', 'CATCH_BLOCK constant should equal "CATCH_BLOCK"');
    });

    it('should export FINALLY_BLOCK node type', async () => {
      const { NODE_TYPE } = await import('@grafema/types');

      assert.ok(NODE_TYPE.FINALLY_BLOCK, 'NODE_TYPE should have FINALLY_BLOCK constant');
      assert.strictEqual(NODE_TYPE.FINALLY_BLOCK, 'FINALLY_BLOCK', 'FINALLY_BLOCK constant should equal "FINALLY_BLOCK"');
    });
  });
});

// =============================================================================
// TESTS: Edge Type Constants
// =============================================================================

describe('Control Flow Edge Types (REG-267 Phase 1)', () => {
  describe('EDGE_TYPE constants', () => {
    it('should export HAS_BODY edge type', async () => {
      const { EDGE_TYPE } = await import('@grafema/types');

      assert.ok(EDGE_TYPE.HAS_BODY, 'EDGE_TYPE should have HAS_BODY constant');
      assert.strictEqual(EDGE_TYPE.HAS_BODY, 'HAS_BODY', 'HAS_BODY constant should equal "HAS_BODY"');
    });

    it('should export ITERATES_OVER edge type', async () => {
      const { EDGE_TYPE } = await import('@grafema/types');

      assert.ok(EDGE_TYPE.ITERATES_OVER, 'EDGE_TYPE should have ITERATES_OVER constant');
      assert.strictEqual(EDGE_TYPE.ITERATES_OVER, 'ITERATES_OVER', 'ITERATES_OVER constant should equal "ITERATES_OVER"');
    });

    it('should export HAS_CONSEQUENT edge type', async () => {
      const { EDGE_TYPE } = await import('@grafema/types');

      assert.ok(EDGE_TYPE.HAS_CONSEQUENT, 'EDGE_TYPE should have HAS_CONSEQUENT constant');
      assert.strictEqual(EDGE_TYPE.HAS_CONSEQUENT, 'HAS_CONSEQUENT', 'HAS_CONSEQUENT constant should equal "HAS_CONSEQUENT"');
    });

    it('should export HAS_ALTERNATE edge type', async () => {
      const { EDGE_TYPE } = await import('@grafema/types');

      assert.ok(EDGE_TYPE.HAS_ALTERNATE, 'EDGE_TYPE should have HAS_ALTERNATE constant');
      assert.strictEqual(EDGE_TYPE.HAS_ALTERNATE, 'HAS_ALTERNATE', 'HAS_ALTERNATE constant should equal "HAS_ALTERNATE"');
    });

    it('should export HAS_CATCH edge type', async () => {
      const { EDGE_TYPE } = await import('@grafema/types');

      assert.ok(EDGE_TYPE.HAS_CATCH, 'EDGE_TYPE should have HAS_CATCH constant');
      assert.strictEqual(EDGE_TYPE.HAS_CATCH, 'HAS_CATCH', 'HAS_CATCH constant should equal "HAS_CATCH"');
    });

    it('should export HAS_FINALLY edge type', async () => {
      const { EDGE_TYPE } = await import('@grafema/types');

      assert.ok(EDGE_TYPE.HAS_FINALLY, 'EDGE_TYPE should have HAS_FINALLY constant');
      assert.strictEqual(EDGE_TYPE.HAS_FINALLY, 'HAS_FINALLY', 'HAS_FINALLY constant should equal "HAS_FINALLY"');
    });
  });
});

// =============================================================================
// TESTS: Node Record Interfaces
// =============================================================================

describe('Control Flow Node Record Interfaces (REG-267 Phase 1)', () => {
  /**
   * TypeScript compile-time tests for interfaces.
   * These tests verify that the interfaces exist and can be used.
   * The actual runtime check is minimal - we're testing type system integration.
   */

  describe('LoopNodeRecord interface', () => {
    it('should be usable as a type', async () => {
      // This is a compile-time test - if it compiles, the interface exists
      const types = await import('@grafema/types');

      // Create a mock object that satisfies LoopNodeRecord
      const mockLoop: types.LoopNodeRecord = {
        id: 'test-loop',
        type: 'LOOP',
        name: 'test',
        file: 'test.js',
        loopType: 'for',
      };

      assert.strictEqual(mockLoop.type, 'LOOP');
      assert.strictEqual(mockLoop.loopType, 'for');
    });

    it('should support all loopType values', async () => {
      const types = await import('@grafema/types');

      const loopTypes: types.LoopNodeRecord['loopType'][] = [
        'for',
        'for-in',
        'for-of',
        'while',
        'do-while'
      ];

      for (const loopType of loopTypes) {
        const mockLoop: types.LoopNodeRecord = {
          id: `test-${loopType}`,
          type: 'LOOP',
          name: loopType,
          file: 'test.js',
          loopType,
        };
        assert.strictEqual(mockLoop.loopType, loopType);
      }
    });

    it('should support optional parentScopeId and bodyScopeId', async () => {
      const types = await import('@grafema/types');

      const mockLoop: types.LoopNodeRecord = {
        id: 'test-loop',
        type: 'LOOP',
        name: 'test',
        file: 'test.js',
        loopType: 'for',
        parentScopeId: 'parent-scope',
        bodyScopeId: 'body-scope',
      };

      assert.strictEqual(mockLoop.parentScopeId, 'parent-scope');
      assert.strictEqual(mockLoop.bodyScopeId, 'body-scope');
    });
  });

  describe('TryBlockNodeRecord interface', () => {
    it('should be usable as a type', async () => {
      const types = await import('@grafema/types');

      const mockTry: types.TryBlockNodeRecord = {
        id: 'test-try',
        type: 'TRY_BLOCK',
        name: 'try',
        file: 'test.js',
      };

      assert.strictEqual(mockTry.type, 'TRY_BLOCK');
    });

    it('should support optional scope IDs', async () => {
      const types = await import('@grafema/types');

      const mockTry: types.TryBlockNodeRecord = {
        id: 'test-try',
        type: 'TRY_BLOCK',
        name: 'try',
        file: 'test.js',
        parentScopeId: 'parent',
        bodyScopeId: 'body',
      };

      assert.strictEqual(mockTry.parentScopeId, 'parent');
      assert.strictEqual(mockTry.bodyScopeId, 'body');
    });
  });

  describe('CatchBlockNodeRecord interface', () => {
    it('should be usable as a type', async () => {
      const types = await import('@grafema/types');

      const mockCatch: types.CatchBlockNodeRecord = {
        id: 'test-catch',
        type: 'CATCH_BLOCK',
        name: 'catch',
        file: 'test.js',
      };

      assert.strictEqual(mockCatch.type, 'CATCH_BLOCK');
    });

    it('should support parameterName for error variable', async () => {
      const types = await import('@grafema/types');

      const mockCatch: types.CatchBlockNodeRecord = {
        id: 'test-catch',
        type: 'CATCH_BLOCK',
        name: 'catch',
        file: 'test.js',
        parameterName: 'err',
      };

      assert.strictEqual(mockCatch.parameterName, 'err');
    });
  });

  describe('FinallyBlockNodeRecord interface', () => {
    it('should be usable as a type', async () => {
      const types = await import('@grafema/types');

      const mockFinally: types.FinallyBlockNodeRecord = {
        id: 'test-finally',
        type: 'FINALLY_BLOCK',
        name: 'finally',
        file: 'test.js',
      };

      assert.strictEqual(mockFinally.type, 'FINALLY_BLOCK');
    });
  });

  describe('NodeRecord union type', () => {
    it('should include new control flow node types', async () => {
      const types = await import('@grafema/types');

      // Create different node types and verify they can be assigned to NodeRecord
      const nodes: types.NodeRecord[] = [
        { id: 'loop', type: 'LOOP', name: 'for', file: 'test.js', loopType: 'for' },
        { id: 'try', type: 'TRY_BLOCK', name: 'try', file: 'test.js' },
        { id: 'catch', type: 'CATCH_BLOCK', name: 'catch', file: 'test.js' },
        { id: 'finally', type: 'FINALLY_BLOCK', name: 'finally', file: 'test.js' },
      ];

      assert.strictEqual(nodes.length, 4, 'Should be able to create array of NodeRecord with new types');
    });
  });
});

// =============================================================================
// TESTS: AST Types (Info Interfaces)
// =============================================================================

describe('Control Flow AST Info Interfaces (REG-267 Phase 1)', () => {
  /**
   * These tests verify that the AST collection types are properly defined
   * in packages/core/src/plugins/analysis/ast/types.ts
   */

  describe('LoopInfo interface', () => {
    it('should be importable from ast/types', async () => {
      // Dynamic import to test the interface exists
      const astTypes = await import('@grafema/core/plugins/analysis/ast/types');

      // Create a mock LoopInfo object
      const mockLoop: astTypes.LoopInfo = {
        id: 'test-loop',
        type: 'LOOP',
        loopType: 'for-of',
        file: 'test.js',
        line: 1,
      };

      assert.strictEqual(mockLoop.type, 'LOOP');
      assert.strictEqual(mockLoop.loopType, 'for-of');
    });

    it('should support iteration info fields for for-in/for-of', async () => {
      const astTypes = await import('@grafema/core/plugins/analysis/ast/types');

      const mockLoop: astTypes.LoopInfo = {
        id: 'test-loop',
        type: 'LOOP',
        loopType: 'for-of',
        file: 'test.js',
        line: 1,
        iteratesOverName: 'items',
        iteratesOverLine: 1,
        iteratesOverColumn: 20,
      };

      assert.strictEqual(mockLoop.iteratesOverName, 'items');
    });
  });

  describe('TryBlockInfo interface', () => {
    it('should be importable from ast/types', async () => {
      const astTypes = await import('@grafema/core/plugins/analysis/ast/types');

      const mockTry: astTypes.TryBlockInfo = {
        id: 'test-try',
        type: 'TRY_BLOCK',
        file: 'test.js',
        line: 1,
      };

      assert.strictEqual(mockTry.type, 'TRY_BLOCK');
    });
  });

  describe('CatchBlockInfo interface', () => {
    it('should be importable from ast/types', async () => {
      const astTypes = await import('@grafema/core/plugins/analysis/ast/types');

      const mockCatch: astTypes.CatchBlockInfo = {
        id: 'test-catch',
        type: 'CATCH_BLOCK',
        file: 'test.js',
        line: 1,
        parentTryBlockId: 'test-try',
      };

      assert.strictEqual(mockCatch.type, 'CATCH_BLOCK');
      assert.strictEqual(mockCatch.parentTryBlockId, 'test-try');
    });

    it('should support parameterName', async () => {
      const astTypes = await import('@grafema/core/plugins/analysis/ast/types');

      const mockCatch: astTypes.CatchBlockInfo = {
        id: 'test-catch',
        type: 'CATCH_BLOCK',
        file: 'test.js',
        line: 1,
        parentTryBlockId: 'test-try',
        parameterName: 'error',
      };

      assert.strictEqual(mockCatch.parameterName, 'error');
    });
  });

  describe('FinallyBlockInfo interface', () => {
    it('should be importable from ast/types', async () => {
      const astTypes = await import('@grafema/core/plugins/analysis/ast/types');

      const mockFinally: astTypes.FinallyBlockInfo = {
        id: 'test-finally',
        type: 'FINALLY_BLOCK',
        file: 'test.js',
        line: 1,
        parentTryBlockId: 'test-try',
      };

      assert.strictEqual(mockFinally.type, 'FINALLY_BLOCK');
      assert.strictEqual(mockFinally.parentTryBlockId, 'test-try');
    });
  });

  describe('ControlFlowMetadata interface', () => {
    it('should be importable from ast/types', async () => {
      const astTypes = await import('@grafema/core/plugins/analysis/ast/types');

      const mockMetadata: astTypes.ControlFlowMetadata = {
        hasBranches: true,
        hasLoops: true,
        hasTryCatch: false,
        hasEarlyReturn: true,
        hasThrow: false,
        cyclomaticComplexity: 5,
      };

      assert.strictEqual(mockMetadata.hasBranches, true);
      assert.strictEqual(mockMetadata.cyclomaticComplexity, 5);
    });
  });

  describe('ASTCollections interface', () => {
    it('should include loops collection field', async () => {
      const astTypes = await import('@grafema/core/plugins/analysis/ast/types');

      const mockCollections: astTypes.ASTCollections = {
        functions: [],
        scopes: [],
        variableDeclarations: [],
        callSites: [],
        loops: [],  // New field
      };

      assert.ok(Array.isArray(mockCollections.loops), 'ASTCollections should have loops array');
    });

    it('should include try/catch/finally collection fields', async () => {
      const astTypes = await import('@grafema/core/plugins/analysis/ast/types');

      const mockCollections: astTypes.ASTCollections = {
        functions: [],
        scopes: [],
        variableDeclarations: [],
        callSites: [],
        tryBlocks: [],      // New field
        catchBlocks: [],    // New field
        finallyBlocks: [],  // New field
      };

      assert.ok(Array.isArray(mockCollections.tryBlocks), 'ASTCollections should have tryBlocks array');
      assert.ok(Array.isArray(mockCollections.catchBlocks), 'ASTCollections should have catchBlocks array');
      assert.ok(Array.isArray(mockCollections.finallyBlocks), 'ASTCollections should have finallyBlocks array');
    });

    it('should include counter refs for new collections', async () => {
      const astTypes = await import('@grafema/core/plugins/analysis/ast/types');

      const mockCollections: astTypes.ASTCollections = {
        functions: [],
        scopes: [],
        variableDeclarations: [],
        callSites: [],
        loopCounterRef: { value: 0 },         // New field
        tryBlockCounterRef: { value: 0 },     // New field
        catchBlockCounterRef: { value: 0 },   // New field
        finallyBlockCounterRef: { value: 0 }, // New field
      };

      assert.ok(mockCollections.loopCounterRef, 'ASTCollections should have loopCounterRef');
      assert.ok(mockCollections.tryBlockCounterRef, 'ASTCollections should have tryBlockCounterRef');
    });
  });
});
