/**
 * FileExplainer Tests
 *
 * Tests for the FileExplainer class that shows what nodes exist in a file.
 * Based on: _tasks/REG-177/006-don-revised-plan.md
 *
 * Purpose: Help users discover what nodes exist in the graph for a file,
 * displaying semantic IDs so users can query them.
 *
 * Tests:
 * - Returns ANALYZED status for files with nodes in graph
 * - Returns NOT_ANALYZED status for files not in graph
 * - Returns correct node count
 * - Groups nodes by type correctly
 * - Detects scope context (try/catch/if) from semantic IDs
 * - Handles empty graph gracefully
 * - Handles non-existent file gracefully
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// Import will fail initially (TDD - implementation doesn't exist yet)
import { FileExplainer, type FileExplainResult, type EnhancedNode } from '@grafema/core';
import type { GraphBackend, NodeFilter, NodeRecord, EdgeRecord, EdgeType } from '@grafema/types';

// =============================================================================
// Mock GraphBackend for Testing
// =============================================================================

/**
 * Mock GraphBackend that simulates nodes in graph.
 * Allows setting up specific test scenarios.
 */
class MockGraphBackend implements Partial<GraphBackend> {
  private nodes: Map<string, NodeRecord> = new Map();

  /**
   * Add a node to the mock graph
   */
  addMockNode(node: NodeRecord): void {
    this.nodes.set(node.id, node);
  }

  /**
   * Add multiple nodes at once
   */
  addMockNodes(nodes: NodeRecord[]): void {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
  }

  async *queryNodes(filter: NodeFilter): AsyncGenerator<NodeRecord> {
    for (const node of this.nodes.values()) {
      if (filter.type && node.type !== filter.type) continue;
      if (filter.nodeType && node.nodeType !== filter.nodeType) continue;
      if (filter.file && node.file !== filter.file) continue;
      yield node;
    }
  }

  async getAllNodes(filter?: NodeFilter): Promise<NodeRecord[]> {
    const result: NodeRecord[] = [];
    for await (const node of this.queryNodes(filter || {})) {
      result.push(node);
    }
    return result;
  }

  async getNode(id: string): Promise<NodeRecord | null> {
    return this.nodes.get(id) || null;
  }

  async nodeCount(): Promise<number> {
    return this.nodes.size;
  }

  async edgeCount(): Promise<number> {
    return 0;
  }

  async countNodesByType(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const node of this.nodes.values()) {
      const type = node.type || 'UNKNOWN';
      counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
  }

  async countEdgesByType(): Promise<Record<string, number>> {
    return {};
  }

  // Required methods for GraphBackend interface (stubs)
  async addNode(): Promise<void> {}
  async addNodes(): Promise<void> {}
  async addEdge(): Promise<void> {}
  async addEdges(): Promise<void> {}
  async getOutgoingEdges(): Promise<EdgeRecord[]> { return []; }
  async getIncomingEdges(): Promise<EdgeRecord[]> { return []; }
}

// =============================================================================
// Test Helper Functions
// =============================================================================

/**
 * Create a mock node with given properties
 */
function createMockNode(options: {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
  column?: number;
}): NodeRecord {
  return {
    id: options.id,
    type: options.type,
    nodeType: options.type,
    name: options.name,
    file: options.file,
    line: options.line ?? 1,
    column: options.column ?? 0,
    metadata: '{}',
  } as NodeRecord;
}

// =============================================================================
// TESTS: FileExplainer
// =============================================================================

describe('FileExplainer', () => {
  const testDir = join(process.cwd(), 'test-fixtures', 'file-explainer');
  const testFile = 'src/app.ts';
  const fullTestFilePath = join(testDir, testFile);

  beforeEach(() => {
    // Clean slate for each test
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(fullTestFilePath, '// test file content');
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  // ===========================================================================
  // TESTS: Status detection
  // ===========================================================================

  describe('Status detection', () => {
    it('should return ANALYZED status when file has nodes in graph', async () => {
      const graph = new MockGraphBackend();
      graph.addMockNode(createMockNode({
        id: `${testFile}->MODULE`,
        type: 'MODULE',
        name: 'app.ts',
        file: testFile,
      }));

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      assert.strictEqual(result.status, 'ANALYZED');
    });

    it('should return NOT_ANALYZED status when file has no nodes in graph', async () => {
      const graph = new MockGraphBackend();
      // Empty graph - no nodes for this file

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      assert.strictEqual(result.status, 'NOT_ANALYZED');
    });

    it('should return NOT_ANALYZED when graph has nodes but not for this file', async () => {
      const graph = new MockGraphBackend();
      // Add node for different file
      graph.addMockNode(createMockNode({
        id: 'other/file.ts->MODULE',
        type: 'MODULE',
        name: 'file.ts',
        file: 'other/file.ts',
      }));

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      assert.strictEqual(result.status, 'NOT_ANALYZED');
    });
  });

  // ===========================================================================
  // TESTS: Node counting
  // ===========================================================================

  describe('Node counting', () => {
    it('should return correct total node count', async () => {
      const graph = new MockGraphBackend();
      graph.addMockNodes([
        createMockNode({
          id: `${testFile}->MODULE`,
          type: 'MODULE',
          name: 'app.ts',
          file: testFile,
        }),
        createMockNode({
          id: `${testFile}->global->FUNCTION->hello`,
          type: 'FUNCTION',
          name: 'hello',
          file: testFile,
          line: 3,
        }),
        createMockNode({
          id: `${testFile}->global->FUNCTION->world`,
          type: 'FUNCTION',
          name: 'world',
          file: testFile,
          line: 7,
        }),
      ]);

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      assert.strictEqual(result.totalCount, 3);
    });

    it('should return 0 count for file with no nodes', async () => {
      const graph = new MockGraphBackend();

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      assert.strictEqual(result.totalCount, 0);
    });
  });

  // ===========================================================================
  // TESTS: Grouping by type
  // ===========================================================================

  describe('Grouping by type', () => {
    it('should group nodes by type correctly', async () => {
      const graph = new MockGraphBackend();
      graph.addMockNodes([
        createMockNode({
          id: `${testFile}->MODULE`,
          type: 'MODULE',
          name: 'app.ts',
          file: testFile,
        }),
        createMockNode({
          id: `${testFile}->global->FUNCTION->foo`,
          type: 'FUNCTION',
          name: 'foo',
          file: testFile,
        }),
        createMockNode({
          id: `${testFile}->global->FUNCTION->bar`,
          type: 'FUNCTION',
          name: 'bar',
          file: testFile,
        }),
        createMockNode({
          id: `${testFile}->global->VARIABLE->x`,
          type: 'VARIABLE',
          name: 'x',
          file: testFile,
        }),
      ]);

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      assert.ok(result.byType, 'Should have byType grouping');
      assert.strictEqual(result.byType['MODULE'], 1);
      assert.strictEqual(result.byType['FUNCTION'], 2);
      assert.strictEqual(result.byType['VARIABLE'], 1);
    });

    it('should handle namespaced types in grouping', async () => {
      const graph = new MockGraphBackend();
      graph.addMockNodes([
        createMockNode({
          id: `${testFile}->MODULE`,
          type: 'MODULE',
          name: 'app.ts',
          file: testFile,
        }),
        createMockNode({
          id: `${testFile}->global->FUNCTION->handler->http:request->/api/users#0`,
          type: 'http:request',
          name: '/api/users',
          file: testFile,
        }),
      ]);

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      assert.strictEqual(result.byType['http:request'], 1);
    });
  });

  // ===========================================================================
  // TESTS: Scope context detection
  // ===========================================================================

  describe('Scope context detection (enhanceWithContext)', () => {
    it('should detect try block scope from semantic ID', async () => {
      const graph = new MockGraphBackend();
      graph.addMockNode(createMockNode({
        id: `${testFile}->fetchData->try#0->VARIABLE->response`,
        type: 'VARIABLE',
        name: 'response',
        file: testFile,
        line: 5,
      }));

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      const node = result.nodes[0] as EnhancedNode;
      assert.ok(node.context, 'Should have context annotation');
      assert.strictEqual(
        node.context,
        'inside try block',
        `Context should be exact. Got: ${node.context}`
      );
    });

    it('should detect catch block scope from semantic ID', async () => {
      const graph = new MockGraphBackend();
      graph.addMockNode(createMockNode({
        id: `${testFile}->fetchData->catch#0->VARIABLE->error`,
        type: 'VARIABLE',
        name: 'error',
        file: testFile,
        line: 10,
      }));

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      const node = result.nodes[0] as EnhancedNode;
      assert.ok(node.context, 'Should have context annotation');
      assert.strictEqual(
        node.context,
        'inside catch block',
        `Context should be exact. Got: ${node.context}`
      );
    });

    it('should detect if block scope from semantic ID', async () => {
      const graph = new MockGraphBackend();
      graph.addMockNode(createMockNode({
        id: `${testFile}->processData->if#0->VARIABLE->result`,
        type: 'VARIABLE',
        name: 'result',
        file: testFile,
        line: 15,
      }));

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      const node = result.nodes[0] as EnhancedNode;
      assert.ok(node.context, 'Should have context annotation');
      assert.strictEqual(
        node.context,
        'inside conditional',
        `Context should be exact. Got: ${node.context}`
      );
    });

    it('should not add context for nodes without special scope', async () => {
      const graph = new MockGraphBackend();
      graph.addMockNode(createMockNode({
        id: `${testFile}->global->FUNCTION->simple`,
        type: 'FUNCTION',
        name: 'simple',
        file: testFile,
        line: 1,
      }));

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      const node = result.nodes[0] as EnhancedNode;
      assert.strictEqual(node.context, undefined, 'Should not have context for regular nodes');
    });

    it('should detect nested scopes (try inside function)', async () => {
      const graph = new MockGraphBackend();
      graph.addMockNode(createMockNode({
        id: `${testFile}->fetchInvitations->try#0->VARIABLE->data`,
        type: 'VARIABLE',
        name: 'data',
        file: testFile,
        line: 44,
      }));

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      const node = result.nodes[0] as EnhancedNode;
      assert.ok(node.context, 'Should detect nested try scope');
    });
  });

  // ===========================================================================
  // TESTS: Result structure
  // ===========================================================================

  describe('Result structure', () => {
    it('should return complete FileExplainResult structure', async () => {
      const graph = new MockGraphBackend();
      graph.addMockNodes([
        createMockNode({
          id: `${testFile}->MODULE`,
          type: 'MODULE',
          name: 'app.ts',
          file: testFile,
        }),
        createMockNode({
          id: `${testFile}->global->FUNCTION->hello`,
          type: 'FUNCTION',
          name: 'hello',
          file: testFile,
          line: 3,
        }),
      ]);

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      // Verify complete structure
      assert.ok(typeof result.file === 'string', 'Should have file path');
      assert.strictEqual(result.file, testFile);

      assert.ok(typeof result.status === 'string', 'Should have status');
      assert.ok(['ANALYZED', 'NOT_ANALYZED'].includes(result.status));

      assert.ok(typeof result.totalCount === 'number', 'Should have totalCount');

      assert.ok(Array.isArray(result.nodes), 'Should have nodes array');

      assert.ok(typeof result.byType === 'object', 'Should have byType grouping');
    });

    it('should include semantic IDs in nodes for querying', async () => {
      const semanticId = `${testFile}->global->FUNCTION->hello`;
      const graph = new MockGraphBackend();
      graph.addMockNode(createMockNode({
        id: semanticId,
        type: 'FUNCTION',
        name: 'hello',
        file: testFile,
        line: 3,
      }));

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      const node = result.nodes[0];
      assert.strictEqual(node.id, semanticId, 'Node should include semantic ID');
    });

    it('should include line numbers when available', async () => {
      const graph = new MockGraphBackend();
      graph.addMockNode(createMockNode({
        id: `${testFile}->global->FUNCTION->hello`,
        type: 'FUNCTION',
        name: 'hello',
        file: testFile,
        line: 42,
        column: 5,
      }));

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      const node = result.nodes[0];
      assert.strictEqual(node.line, 42, 'Should include line number');
    });
  });

  // ===========================================================================
  // TESTS: Edge cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle empty graph gracefully', async () => {
      const graph = new MockGraphBackend();

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      assert.strictEqual(result.status, 'NOT_ANALYZED');
      assert.strictEqual(result.totalCount, 0);
      assert.deepStrictEqual(result.nodes, []);
      assert.deepStrictEqual(result.byType, {});
    });

    it('should handle file path with spaces', async () => {
      const fileWithSpaces = 'src/my file.ts';
      const graph = new MockGraphBackend();
      graph.addMockNode(createMockNode({
        id: `${fileWithSpaces}->MODULE`,
        type: 'MODULE',
        name: 'my file.ts',
        file: fileWithSpaces,
      }));

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(fileWithSpaces);

      assert.strictEqual(result.status, 'ANALYZED');
      assert.strictEqual(result.file, fileWithSpaces);
    });

    it('should handle deeply nested semantic IDs', async () => {
      const deepId = `${testFile}->ClassA->methodB->innerFunc->try#0->catch#0->if#1->VARIABLE->deep`;
      const graph = new MockGraphBackend();
      graph.addMockNode(createMockNode({
        id: deepId,
        type: 'VARIABLE',
        name: 'deep',
        file: testFile,
        line: 100,
      }));

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      assert.strictEqual(result.totalCount, 1);
      const node = result.nodes[0] as EnhancedNode;
      // Should detect multiple scopes
      assert.ok(node.context, 'Should have context for deeply nested scope');
    });

    it('should handle semantic ID parsing failures gracefully', async () => {
      const malformedId = 'not-a-valid-semantic-id';
      const graph = new MockGraphBackend();
      graph.addMockNode(createMockNode({
        id: malformedId,
        type: 'UNKNOWN',
        name: 'unknown',
        file: testFile,
      }));

      const explainer = new FileExplainer(graph as unknown as GraphBackend);

      // Should not throw, just return node without context
      const result = await explainer.explain(testFile);
      assert.strictEqual(result.totalCount, 1);
    });

    it('should sort nodes by type and then by name', async () => {
      const graph = new MockGraphBackend();
      graph.addMockNodes([
        createMockNode({
          id: `${testFile}->global->VARIABLE->z`,
          type: 'VARIABLE',
          name: 'z',
          file: testFile,
        }),
        createMockNode({
          id: `${testFile}->global->FUNCTION->alpha`,
          type: 'FUNCTION',
          name: 'alpha',
          file: testFile,
        }),
        createMockNode({
          id: `${testFile}->global->FUNCTION->beta`,
          type: 'FUNCTION',
          name: 'beta',
          file: testFile,
        }),
        createMockNode({
          id: `${testFile}->MODULE`,
          type: 'MODULE',
          name: 'app.ts',
          file: testFile,
        }),
      ]);

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(testFile);

      // Verify sort order: by type first, then by name within type
      assert.strictEqual(result.nodes.length, 4);

      // Expected order: FUNCTION (alpha, beta), MODULE, VARIABLE
      assert.strictEqual(result.nodes[0].type, 'FUNCTION', 'First should be FUNCTION');
      assert.strictEqual(result.nodes[0].name, 'alpha', 'First function should be alpha');
      assert.strictEqual(result.nodes[1].type, 'FUNCTION', 'Second should be FUNCTION');
      assert.strictEqual(result.nodes[1].name, 'beta', 'Second function should be beta');
      assert.strictEqual(result.nodes[2].type, 'MODULE', 'Third should be MODULE');
      assert.strictEqual(result.nodes[3].type, 'VARIABLE', 'Fourth should be VARIABLE');
    });
  });

  // ===========================================================================
  // TESTS: Real-world scenario (from REG-177 user report)
  // ===========================================================================

  describe('Real-world scenario: try/catch variables', () => {
    it('should explain file with try/catch variables correctly', async () => {
      // This mimics the user report from REG-177
      const invitationsFile = 'src/pages/Invitations.tsx';
      const graph = new MockGraphBackend();

      graph.addMockNodes([
        createMockNode({
          id: `${invitationsFile}->MODULE`,
          type: 'MODULE',
          name: 'Invitations.tsx',
          file: invitationsFile,
        }),
        createMockNode({
          id: `${invitationsFile}->global->FUNCTION->Invitations`,
          type: 'FUNCTION',
          name: 'Invitations',
          file: invitationsFile,
          line: 12,
        }),
        createMockNode({
          id: `${invitationsFile}->global->FUNCTION->fetchInvitations`,
          type: 'FUNCTION',
          name: 'fetchInvitations',
          file: invitationsFile,
          line: 35,
        }),
        // The key nodes that users couldn't find
        createMockNode({
          id: `${invitationsFile}->fetchInvitations->try#0->VARIABLE->response`,
          type: 'VARIABLE',
          name: 'response',
          file: invitationsFile,
          line: 43,
        }),
        createMockNode({
          id: `${invitationsFile}->fetchInvitations->try#0->VARIABLE->data`,
          type: 'VARIABLE',
          name: 'data',
          file: invitationsFile,
          line: 44,
        }),
        createMockNode({
          id: `${invitationsFile}->fetchInvitations->catch#0->VARIABLE->error`,
          type: 'VARIABLE',
          name: 'error',
          file: invitationsFile,
          line: 46,
        }),
      ]);

      const explainer = new FileExplainer(graph as unknown as GraphBackend);
      const result = await explainer.explain(invitationsFile);

      // Verify the user's problem is solved
      assert.strictEqual(result.status, 'ANALYZED');
      assert.strictEqual(result.totalCount, 6);

      // Find the 'response' variable
      const responseNode = result.nodes.find(n => n.name === 'response') as EnhancedNode;
      assert.ok(responseNode, 'Should find response variable');
      assert.ok(responseNode.id.includes('try#0'), 'Semantic ID should show try scope');
      assert.ok(responseNode.context?.includes('try'), 'Context should indicate try block');

      // Find the 'error' variable
      const errorNode = result.nodes.find(n => n.name === 'error') as EnhancedNode;
      assert.ok(errorNode, 'Should find error variable');
      assert.ok(errorNode.context?.includes('catch'), 'Context should indicate catch block');
    });
  });
});
