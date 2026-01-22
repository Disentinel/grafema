/**
 * NetworkRequestNode Unit Tests (REG-109)
 *
 * TDD tests for migrating net:request node creation to NetworkRequestNode factory.
 * Following pattern from ExternalStdioNode (singleton external resource).
 *
 * CRITICAL: Uses type 'net:request' (namespaced string), NOT 'NET_REQUEST'.
 * This matches ExternalStdioNode pattern and NodeKind.NET_REQUEST constant.
 *
 * Verifies:
 * 1. NetworkRequestNode.create() generates singleton node with correct ID
 * 2. Type is 'net:request' (namespaced string)
 * 3. SINGLETON_ID is 'net:request#__network__'
 * 4. Validation rejects wrong type or ID
 * 5. NodeFactory.createNetworkRequest() compatibility
 *
 * Current state (before implementation):
 * - NetworkRequestNode class doesn't exist yet
 * - GraphBuilder creates net:request nodes inline (line 651)
 * - ExpressAnalyzer creates net:request nodes inline (line 84)
 *
 * Target state (after implementation):
 * - NetworkRequestNode.create() produces singleton node
 * - NodeFactory.createNetworkRequest() delegates to NetworkRequestNode
 * - All net:request creation uses NetworkRequestNode factory
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * Tests will FAIL initially - implementation comes after.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NetworkRequestNode, NodeFactory } from '@grafema/core';

// ============================================================================
// 1. NetworkRequestNode.create() contract tests (Unit Tests)
// ============================================================================

describe('NetworkRequestNode (REG-109)', () => {
  describe('NetworkRequestNode.create() contract', () => {
    it('should create singleton node with correct ID', () => {
      const node = NetworkRequestNode.create();

      assert.strictEqual(
        node.id,
        'net:request#__network__',
        'ID must be net:request#__network__ (singleton ID)'
      );
    });

    it('should use type "net:request" (namespaced string)', () => {
      const node = NetworkRequestNode.create();

      assert.strictEqual(
        node.type,
        'net:request',
        'Type must be "net:request" (NOT "NET_REQUEST")'
      );
    });

    it('should set name to __network__', () => {
      const node = NetworkRequestNode.create();

      assert.strictEqual(
        node.name,
        '__network__',
        'Name should be __network__ (singleton name)'
      );
    });

    it('should set file to __builtin__', () => {
      const node = NetworkRequestNode.create();

      assert.strictEqual(
        node.file,
        '__builtin__',
        'File should be __builtin__ (not a source file)'
      );
    });

    it('should set line to 0', () => {
      const node = NetworkRequestNode.create();

      assert.strictEqual(
        node.line,
        0,
        'Line should be 0 (not from source code)'
      );
    });

    it('should take no parameters (singleton pattern)', () => {
      const node = NetworkRequestNode.create();

      assert.ok(node, 'create() should accept zero arguments');
      assert.strictEqual(node.id, 'net:request#__network__');
    });

    it('should preserve all required fields', () => {
      const node = NetworkRequestNode.create();

      assert.ok(node.id, 'Node should have id');
      assert.ok(node.type, 'Node should have type');
      assert.ok(node.name, 'Node should have name');
      assert.ok(node.file, 'Node should have file');
      assert.strictEqual(typeof node.line, 'number', 'Node should have line as number');
    });

    it('should create consistent node on multiple calls', () => {
      const node1 = NetworkRequestNode.create();
      const node2 = NetworkRequestNode.create();

      assert.strictEqual(node1.id, node2.id, 'Multiple calls should produce same ID');
      assert.strictEqual(node1.type, node2.type, 'Multiple calls should produce same type');
      assert.strictEqual(node1.name, node2.name, 'Multiple calls should produce same name');
      assert.strictEqual(node1.file, node2.file, 'Multiple calls should produce same file');
      assert.strictEqual(node1.line, node2.line, 'Multiple calls should produce same line');
    });
  });

  // ============================================================================
  // 2. NetworkRequestNode static constants
  // ============================================================================

  describe('NetworkRequestNode static constants', () => {
    it('should have TYPE constant set to "net:request"', () => {
      assert.strictEqual(
        NetworkRequestNode.TYPE,
        'net:request',
        'TYPE constant must be "net:request"'
      );
    });

    it('should have SINGLETON_ID constant', () => {
      assert.strictEqual(
        NetworkRequestNode.SINGLETON_ID,
        'net:request#__network__',
        'SINGLETON_ID must match expected format'
      );
    });

    it('should use SINGLETON_ID in create()', () => {
      const node = NetworkRequestNode.create();

      assert.strictEqual(
        node.id,
        NetworkRequestNode.SINGLETON_ID,
        'create() should use SINGLETON_ID constant'
      );
    });

    it('should use TYPE in create()', () => {
      const node = NetworkRequestNode.create();

      assert.strictEqual(
        node.type,
        NetworkRequestNode.TYPE,
        'create() should use TYPE constant'
      );
    });
  });

  // ============================================================================
  // 3. NetworkRequestNode.validate() tests
  // ============================================================================

  describe('NetworkRequestNode.validate()', () => {
    it('should pass validation for valid node', () => {
      const node = NetworkRequestNode.create();
      const errors = NetworkRequestNode.validate(node);

      assert.strictEqual(
        errors.length,
        0,
        'Valid node should have no validation errors'
      );
    });

    it('should reject node with wrong type', () => {
      const invalidNode = {
        ...NetworkRequestNode.create(),
        type: 'WRONG_TYPE'
      };

      const errors = NetworkRequestNode.validate(invalidNode);

      assert.ok(
        errors.length > 0,
        'Should return errors for wrong type'
      );
      assert.ok(
        errors.some(err => err.includes('type')),
        'Error message should mention type'
      );
    });

    it('should reject node with wrong ID', () => {
      const invalidNode = {
        ...NetworkRequestNode.create(),
        id: 'wrong:id'
      };

      const errors = NetworkRequestNode.validate(invalidNode);

      assert.ok(
        errors.length > 0,
        'Should return errors for wrong ID'
      );
      assert.ok(
        errors.some(err => err.includes('ID') || err.includes('id')),
        'Error message should mention ID'
      );
    });

    it('should reject node with NET_REQUEST type instead of net:request', () => {
      const invalidNode = {
        ...NetworkRequestNode.create(),
        type: 'NET_REQUEST'
      };

      const errors = NetworkRequestNode.validate(invalidNode);

      assert.ok(
        errors.length > 0,
        'Should reject NET_REQUEST type (must be net:request)'
      );
    });
  });

  // ============================================================================
  // 4. NodeFactory.createNetworkRequest() integration
  // ============================================================================

  describe('NodeFactory.createNetworkRequest() integration', () => {
    it('should exist as factory method', () => {
      assert.strictEqual(
        typeof NodeFactory.createNetworkRequest,
        'function',
        'NodeFactory should have createNetworkRequest method'
      );
    });

    it('should produce same result as NetworkRequestNode.create()', () => {
      const directNode = NetworkRequestNode.create();
      const factoryNode = NodeFactory.createNetworkRequest();

      assert.strictEqual(factoryNode.id, directNode.id, 'IDs should match');
      assert.strictEqual(factoryNode.type, directNode.type, 'Types should match');
      assert.strictEqual(factoryNode.name, directNode.name, 'Names should match');
      assert.strictEqual(factoryNode.file, directNode.file, 'Files should match');
      assert.strictEqual(factoryNode.line, directNode.line, 'Lines should match');
    });

    it('should take no parameters (singleton pattern)', () => {
      const node = NodeFactory.createNetworkRequest();

      assert.ok(node, 'createNetworkRequest() should accept zero arguments');
      assert.strictEqual(node.id, 'net:request#__network__');
    });
  });

  // ============================================================================
  // 5. NodeFactory.validate() integration
  // ============================================================================

  describe('NodeFactory.validate() integration', () => {
    it('should validate net:request nodes', () => {
      const node = NetworkRequestNode.create();
      const errors = NodeFactory.validate(node);

      assert.strictEqual(
        errors.length,
        0,
        'NodeFactory should validate net:request nodes without errors'
      );
    });

    it('should reject net:request node with wrong type', () => {
      const invalidNode = {
        ...NetworkRequestNode.create(),
        type: 'WRONG_TYPE'
      };

      const errors = NodeFactory.validate(invalidNode);

      assert.ok(
        errors.length > 0,
        'NodeFactory should reject node with wrong type'
      );
    });

    it('should use NetworkRequestNode validator for net:request type', () => {
      const node = NetworkRequestNode.create();
      const factoryErrors = NodeFactory.validate(node);
      const directErrors = NetworkRequestNode.validate(node);

      assert.strictEqual(
        factoryErrors.length,
        directErrors.length,
        'NodeFactory should use NetworkRequestNode validator'
      );
    });
  });

  // ============================================================================
  // 6. Singleton pattern verification
  // ============================================================================

  describe('Singleton pattern verification', () => {
    it('should not accept parameters that change identity', () => {
      // NetworkRequestNode is a singleton - all calls produce the same node
      const node1 = NetworkRequestNode.create();
      const node2 = NetworkRequestNode.create();

      assert.strictEqual(
        node1.id,
        node2.id,
        'Singleton should always have same ID'
      );
    });

    it('should follow ExternalStdioNode singleton pattern', () => {
      // Both should be singletons with similar structure
      const networkNode = NetworkRequestNode.create();

      assert.ok(
        networkNode.id.includes('#'),
        'Singleton ID should use # separator (like net:stdio#__stdio__)'
      );
      assert.ok(
        networkNode.id.includes('__network__'),
        'Singleton ID should include __network__ marker'
      );
      assert.strictEqual(
        networkNode.file,
        '__builtin__',
        'Singleton should use __builtin__ file (like ExternalStdioNode)'
      );
    });

    it('should use namespaced type format (net:*)', () => {
      const node = NetworkRequestNode.create();

      assert.ok(
        node.type.startsWith('net:'),
        'Type should use net: namespace (like net:stdio)'
      );
    });
  });

  // ============================================================================
  // 7. Documentation and intent verification
  // ============================================================================

  describe('Documentation and intent', () => {
    it('should be distinct from HTTP_REQUEST type', () => {
      const networkNode = NetworkRequestNode.create();

      // net:request is a singleton system resource
      // HTTP_REQUEST is for individual call sites
      assert.notStrictEqual(
        networkNode.type,
        'HTTP_REQUEST',
        'net:request and HTTP_REQUEST are different types'
      );
      assert.strictEqual(
        networkNode.type,
        'net:request',
        'NetworkRequestNode should use net:request type'
      );
    });

    it('should represent external network as system resource', () => {
      const node = NetworkRequestNode.create();

      // Singleton representing external system (not source code)
      assert.strictEqual(node.file, '__builtin__');
      assert.strictEqual(node.line, 0);
      assert.ok(
        node.name.includes('__network__'),
        'Name should indicate network system resource'
      );
    });

    it('should be queryable via net:* namespace', () => {
      const node = NetworkRequestNode.create();

      assert.ok(
        node.type.match(/^net:/),
        'Type should match net:* namespace pattern for queries'
      );
    });
  });
});
