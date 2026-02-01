/**
 * Tests for findContainingFunction utility (REG-254)
 *
 * Tests the utility for finding the FUNCTION, CLASS, or MODULE that contains a node.
 *
 * Graph structure (backward traversal):
 * ```
 * CALL <- CONTAINS <- SCOPE <- ... <- SCOPE <- HAS_SCOPE <- FUNCTION
 * VARIABLE <- DECLARES <- SCOPE <- ... <- SCOPE <- HAS_SCOPE <- FUNCTION
 * ```
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - implementation comes after.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { findContainingFunction, type CallerInfo } from '@grafema/core';

// =============================================================================
// MOCK BACKEND
// =============================================================================

/**
 * Minimal mock backend that implements the interface required by findContainingFunction.
 *
 * We store nodes and edges in Maps for fast lookup.
 * No real DB operations - all in-memory for fast tests.
 */
class MockGraphBackend {
  private nodes: Map<string, MockNode> = new Map();
  private edges: MockEdge[] = [];

  async addNode(node: MockNode): Promise<void> {
    this.nodes.set(node.id, node);
  }

  async addEdge(edge: MockEdge): Promise<void> {
    this.edges.push(edge);
  }

  async getNode(id: string): Promise<MockNode | null> {
    return this.nodes.get(id) ?? null;
  }

  async getOutgoingEdges(nodeId: string, edgeTypes: string[] | null): Promise<MockEdge[]> {
    return this.edges.filter(
      (e) => e.src === nodeId && (edgeTypes === null || edgeTypes.includes(e.type))
    );
  }

  async getIncomingEdges(nodeId: string, edgeTypes: string[] | null): Promise<MockEdge[]> {
    return this.edges.filter(
      (e) => e.dst === nodeId && (edgeTypes === null || edgeTypes.includes(e.type))
    );
  }
}

interface MockNode {
  id: string;
  type: string;
  name: string;
  file?: string;
  line?: number;
}

interface MockEdge {
  src: string;
  dst: string;
  type: string;
}

// =============================================================================
// TESTS
// =============================================================================

describe('findContainingFunction', () => {
  let backend: MockGraphBackend;

  beforeEach(() => {
    backend = new MockGraphBackend();
  });

  // ===========================================================================
  // TESTS: Basic Containment
  // ===========================================================================

  describe('basic containment', () => {
    /**
     * WHY: Simplest case - CALL directly inside function's scope.
     *
     * Graph:
     * ```
     * FUNCTION -[HAS_SCOPE]-> SCOPE -[CONTAINS]-> CALL
     * ```
     *
     * Backward: CALL <- CONTAINS <- SCOPE <- HAS_SCOPE <- FUNCTION
     */
    it('should find parent FUNCTION for a CALL node', async () => {
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'myFunction', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'helperFunction', file: 'file.js', line: 3 });

      await backend.addEdge({ src: 'func-1', dst: 'scope-1', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-1', dst: 'call-1', type: 'CONTAINS' });

      const container = await findContainingFunction(backend, 'call-1');

      assert.ok(container, 'Should find containing function');
      assert.strictEqual(container.id, 'func-1');
      assert.strictEqual(container.name, 'myFunction');
      assert.strictEqual(container.type, 'FUNCTION');
      assert.strictEqual(container.file, 'file.js');
      assert.strictEqual(container.line, 1);
    });

    /**
     * WHY: CALL nested inside multiple scopes (if-block, loop, etc.)
     * Must traverse up through all nested scopes.
     *
     * Graph:
     * ```
     * FUNCTION -[HAS_SCOPE]-> body -[CONTAINS]-> if_scope -[CONTAINS]-> loop_scope -[CONTAINS]-> CALL
     * ```
     */
    it('should handle multiple scope levels', async () => {
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'deepFunction', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'body-scope', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'if-scope', type: 'SCOPE', name: 'if_branch', file: 'file.js', line: 3 });
      await backend.addNode({ id: 'loop-scope', type: 'SCOPE', name: 'for_body', file: 'file.js', line: 5 });
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'deepCall', file: 'file.js', line: 6 });

      await backend.addEdge({ src: 'func-1', dst: 'body-scope', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'body-scope', dst: 'if-scope', type: 'CONTAINS' });
      await backend.addEdge({ src: 'if-scope', dst: 'loop-scope', type: 'CONTAINS' });
      await backend.addEdge({ src: 'loop-scope', dst: 'call-1', type: 'CONTAINS' });

      const container = await findContainingFunction(backend, 'call-1');

      assert.ok(container, 'Should find containing function');
      assert.strictEqual(container.id, 'func-1');
      assert.strictEqual(container.name, 'deepFunction');
      assert.strictEqual(container.type, 'FUNCTION');
    });

    /**
     * WHY: CALL at top level (module scope) has no containing function.
     * Should return null, not error.
     */
    it('should return null when no container found', async () => {
      // CALL at module level - no function container
      await backend.addNode({ id: 'module-1', type: 'MODULE', name: 'file.js', file: 'file.js' });
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'topLevelCall', file: 'file.js', line: 1 });

      // Module contains call directly (no HAS_SCOPE from function)
      await backend.addEdge({ src: 'module-1', dst: 'call-1', type: 'CONTAINS' });

      const container = await findContainingFunction(backend, 'call-1');

      // MODULE is a valid container type
      assert.ok(container, 'Should find MODULE as container');
      assert.strictEqual(container.type, 'MODULE');
    });

    /**
     * WHY: Node with no incoming edges should return null.
     * Handles orphaned nodes gracefully.
     */
    it('should return null for orphaned node', async () => {
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'orphanCall', file: 'file.js', line: 1 });

      const container = await findContainingFunction(backend, 'call-1');

      assert.strictEqual(container, null, 'Should return null for orphaned node');
    });
  });

  // ===========================================================================
  // TESTS: Container Types
  // ===========================================================================

  describe('container types', () => {
    /**
     * WHY: CLASS is a valid container type (for methods defined in class).
     * Should stop traversal at CLASS boundary.
     */
    it('should find CLASS as container', async () => {
      await backend.addNode({ id: 'class-1', type: 'CLASS', name: 'MyClass', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'class-scope', type: 'SCOPE', name: 'class_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'classLevelCall', file: 'file.js', line: 5 });

      await backend.addEdge({ src: 'class-1', dst: 'class-scope', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'class-scope', dst: 'call-1', type: 'CONTAINS' });

      const container = await findContainingFunction(backend, 'call-1');

      assert.ok(container, 'Should find CLASS as container');
      assert.strictEqual(container.id, 'class-1');
      assert.strictEqual(container.type, 'CLASS');
      assert.strictEqual(container.name, 'MyClass');
    });

    /**
     * WHY: MODULE is a valid container type for top-level code.
     */
    it('should find MODULE as container', async () => {
      await backend.addNode({ id: 'module-1', type: 'MODULE', name: 'index.js', file: 'index.js', line: 1 });
      await backend.addNode({ id: 'module-scope', type: 'SCOPE', name: 'module_body', file: 'index.js', line: 1 });
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'topLevelCall', file: 'index.js', line: 5 });

      await backend.addEdge({ src: 'module-1', dst: 'module-scope', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'module-scope', dst: 'call-1', type: 'CONTAINS' });

      const container = await findContainingFunction(backend, 'call-1');

      assert.ok(container, 'Should find MODULE as container');
      assert.strictEqual(container.type, 'MODULE');
      assert.strictEqual(container.name, 'index.js');
    });

    /**
     * WHY: Method inside class - should find the METHOD, not the CLASS.
     * METHOD is a subtype of FUNCTION for our purposes.
     */
    it('should prefer closest FUNCTION container', async () => {
      await backend.addNode({ id: 'class-1', type: 'CLASS', name: 'MyClass', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'class-scope', type: 'SCOPE', name: 'class_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'method-1', type: 'FUNCTION', name: 'myMethod', file: 'file.js', line: 5 });
      await backend.addNode({ id: 'method-scope', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 5 });
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'callInMethod', file: 'file.js', line: 7 });

      await backend.addEdge({ src: 'class-1', dst: 'class-scope', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'class-scope', dst: 'method-1', type: 'CONTAINS' });
      await backend.addEdge({ src: 'method-1', dst: 'method-scope', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'method-scope', dst: 'call-1', type: 'CONTAINS' });

      const container = await findContainingFunction(backend, 'call-1');

      assert.ok(container, 'Should find method as container');
      assert.strictEqual(container.id, 'method-1');
      assert.strictEqual(container.name, 'myMethod');
      assert.strictEqual(container.type, 'FUNCTION');
    });
  });

  // ===========================================================================
  // TESTS: Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    /**
     * WHY: Non-existent node ID should return null.
     * Don't throw error, just return null.
     */
    it('should return null for non-existent node ID', async () => {
      const container = await findContainingFunction(backend, 'non-existent');

      assert.strictEqual(container, null, 'Should return null for non-existent node');
    });

    /**
     * WHY: Very deep nesting should still work within default maxDepth.
     * Default maxDepth=15 should handle most real-world cases.
     */
    it('should handle deep nesting within maxDepth', async () => {
      // Create 10 nested scopes (within default limit of 15)
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'deepFunc', file: 'file.js', line: 1 });

      let prevScopeId = 'func-1';
      for (let i = 0; i < 10; i++) {
        const scopeId = `scope-${i}`;
        await backend.addNode({ id: scopeId, type: 'SCOPE', name: `scope${i}`, file: 'file.js', line: i + 2 });

        if (i === 0) {
          await backend.addEdge({ src: 'func-1', dst: scopeId, type: 'HAS_SCOPE' });
        } else {
          await backend.addEdge({ src: prevScopeId, dst: scopeId, type: 'CONTAINS' });
        }
        prevScopeId = scopeId;
      }

      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'deepCall', file: 'file.js', line: 15 });
      await backend.addEdge({ src: 'scope-9', dst: 'call-1', type: 'CONTAINS' });

      const container = await findContainingFunction(backend, 'call-1');

      assert.ok(container, 'Should find function even with deep nesting');
      assert.strictEqual(container.id, 'func-1');
    });

    /**
     * WHY: If nesting exceeds maxDepth, should return null.
     * Prevents infinite loops in malformed graphs.
     */
    it('should return null when maxDepth exceeded', async () => {
      // Create nesting deeper than maxDepth=3
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'deepFunc', file: 'file.js', line: 1 });

      let prevScopeId = 'func-1';
      for (let i = 0; i < 5; i++) {
        const scopeId = `scope-${i}`;
        await backend.addNode({ id: scopeId, type: 'SCOPE', name: `scope${i}`, file: 'file.js', line: i + 2 });

        if (i === 0) {
          await backend.addEdge({ src: 'func-1', dst: scopeId, type: 'HAS_SCOPE' });
        } else {
          await backend.addEdge({ src: prevScopeId, dst: scopeId, type: 'CONTAINS' });
        }
        prevScopeId = scopeId;
      }

      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'deepCall', file: 'file.js', line: 10 });
      await backend.addEdge({ src: 'scope-4', dst: 'call-1', type: 'CONTAINS' });

      // With maxDepth=3, should not reach function
      const container = await findContainingFunction(backend, 'call-1', 3);

      assert.strictEqual(container, null, 'Should return null when maxDepth exceeded');
    });

    /**
     * WHY: Anonymous functions should return '<anonymous>' as name.
     */
    it('should handle anonymous function with default name', async () => {
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: '', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'someCall', file: 'file.js', line: 3 });

      await backend.addEdge({ src: 'func-1', dst: 'scope-1', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-1', dst: 'call-1', type: 'CONTAINS' });

      const container = await findContainingFunction(backend, 'call-1');

      assert.ok(container, 'Should find anonymous function');
      assert.strictEqual(container.name, '<anonymous>', 'Should use default name for anonymous function');
    });

    /**
     * WHY: Cycle in graph should be detected and not cause infinite loop.
     * This tests the visited set functionality.
     */
    it('should handle cycles in graph without infinite loop', async () => {
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'scope1', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-2', type: 'SCOPE', name: 'scope2', file: 'file.js', line: 2 });
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'cyclicCall', file: 'file.js', line: 3 });

      // Create a cycle: scope-1 -> scope-2 -> scope-1
      await backend.addEdge({ src: 'scope-2', dst: 'call-1', type: 'CONTAINS' });
      await backend.addEdge({ src: 'scope-1', dst: 'scope-2', type: 'CONTAINS' });
      await backend.addEdge({ src: 'scope-2', dst: 'scope-1', type: 'CONTAINS' }); // Cycle!

      // Should complete without hanging, returning null (no function found)
      const container = await findContainingFunction(backend, 'call-1');

      assert.strictEqual(container, null, 'Should return null for cyclic graph with no function');
    });

    /**
     * WHY: Finding container for METHOD_CALL node (not just CALL).
     */
    it('should find container for METHOD_CALL node', async () => {
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'handler', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'mcall-1', type: 'METHOD_CALL', name: 'json', file: 'file.js', line: 3 });

      await backend.addEdge({ src: 'func-1', dst: 'scope-1', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-1', dst: 'mcall-1', type: 'CONTAINS' });

      const container = await findContainingFunction(backend, 'mcall-1');

      assert.ok(container, 'Should find container for METHOD_CALL');
      assert.strictEqual(container.id, 'func-1');
      assert.strictEqual(container.name, 'handler');
    });

    /**
     * WHY: Finding container for any node type (VARIABLE, etc.)
     * The utility is generic, not limited to calls.
     */
    it('should find container for VARIABLE node', async () => {
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'processor', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'var-1', type: 'VARIABLE', name: 'myVar', file: 'file.js', line: 3 });

      await backend.addEdge({ src: 'func-1', dst: 'scope-1', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-1', dst: 'var-1', type: 'CONTAINS' });

      const container = await findContainingFunction(backend, 'var-1');

      assert.ok(container, 'Should find container for VARIABLE');
      assert.strictEqual(container.name, 'processor');
    });

    /**
     * WHY: VARIABLE nodes are connected to SCOPE via DECLARES edge (not CONTAINS).
     * Must follow DECLARES edges to find containing function.
     *
     * Graph structure:
     * ```
     * FUNCTION -[HAS_SCOPE]-> SCOPE -[DECLARES]-> VARIABLE
     * ```
     */
    it('should find container for VARIABLE via DECLARES edge', async () => {
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'varHandler', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'scope-1', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'var-1', type: 'VARIABLE', name: 'declaredVar', file: 'file.js', line: 3 });

      await backend.addEdge({ src: 'func-1', dst: 'scope-1', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'scope-1', dst: 'var-1', type: 'DECLARES' }); // Real graph structure

      const container = await findContainingFunction(backend, 'var-1');

      assert.ok(container, 'Should find container for VARIABLE via DECLARES edge');
      assert.strictEqual(container.id, 'func-1');
      assert.strictEqual(container.name, 'varHandler');
      assert.strictEqual(container.type, 'FUNCTION');
    });
  });

  // ===========================================================================
  // TESTS: Complex Hierarchies
  // ===========================================================================

  describe('complex hierarchies', () => {
    /**
     * WHY: Arrow function inside method inside class.
     * Should find the closest FUNCTION (arrow function), not the class method.
     */
    it('should find innermost function container', async () => {
      await backend.addNode({ id: 'class-1', type: 'CLASS', name: 'Service', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'class-scope', type: 'SCOPE', name: 'class_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'method-1', type: 'FUNCTION', name: 'process', file: 'file.js', line: 5 });
      await backend.addNode({ id: 'method-scope', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 5 });
      await backend.addNode({ id: 'arrow-1', type: 'FUNCTION', name: 'callback', file: 'file.js', line: 10 });
      await backend.addNode({ id: 'arrow-scope', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 10 });
      await backend.addNode({ id: 'call-1', type: 'CALL', name: 'innerCall', file: 'file.js', line: 12 });

      await backend.addEdge({ src: 'class-1', dst: 'class-scope', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'class-scope', dst: 'method-1', type: 'CONTAINS' });
      await backend.addEdge({ src: 'method-1', dst: 'method-scope', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'method-scope', dst: 'arrow-1', type: 'CONTAINS' });
      await backend.addEdge({ src: 'arrow-1', dst: 'arrow-scope', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'arrow-scope', dst: 'call-1', type: 'CONTAINS' });

      const container = await findContainingFunction(backend, 'call-1');

      assert.ok(container, 'Should find arrow function as container');
      assert.strictEqual(container.id, 'arrow-1');
      assert.strictEqual(container.name, 'callback');
      assert.strictEqual(container.type, 'FUNCTION');
    });

    /**
     * WHY: Call in try-catch block should still find containing function.
     */
    it('should traverse through try-catch scopes', async () => {
      await backend.addNode({ id: 'func-1', type: 'FUNCTION', name: 'handleError', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'func-scope', type: 'SCOPE', name: 'function_body', file: 'file.js', line: 1 });
      await backend.addNode({ id: 'try-scope', type: 'SCOPE', name: 'try_block', file: 'file.js', line: 3 });
      await backend.addNode({ id: 'catch-scope', type: 'SCOPE', name: 'catch_block', file: 'file.js', line: 8 });
      await backend.addNode({ id: 'call-in-catch', type: 'CALL', name: 'reportError', file: 'file.js', line: 9 });

      await backend.addEdge({ src: 'func-1', dst: 'func-scope', type: 'HAS_SCOPE' });
      await backend.addEdge({ src: 'func-scope', dst: 'try-scope', type: 'CONTAINS' });
      await backend.addEdge({ src: 'func-scope', dst: 'catch-scope', type: 'CONTAINS' });
      await backend.addEdge({ src: 'catch-scope', dst: 'call-in-catch', type: 'CONTAINS' });

      const container = await findContainingFunction(backend, 'call-in-catch');

      assert.ok(container, 'Should find function through catch scope');
      assert.strictEqual(container.name, 'handleError');
    });
  });
});
