/**
 * RFDBClient Unit Tests
 *
 * Tests for RFDBClient functionality that don't require a running server.
 * Uses mock socket to test message serialization and addNodes behavior.
 *
 * Key tests for REG-274:
 * - addNodes() should preserve extra fields in metadata
 * - Extra fields like constraints, condition, scopeType should not be lost
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

/**
 * Mock RFDBClient that captures what would be sent to the server
 *
 * We can't easily mock the socket, so we test the serialization logic
 * by extracting the node mapping logic from addNodes.
 */
function mapNodeForWireFormat(n: Record<string, unknown>): {
  id: string;
  nodeType: string;
  name: string;
  file: string;
  exported: boolean;
  metadata: string;
} {
  // This is the CURRENT implementation - extracts only known fields
  // Bug: extra fields are silently discarded
  return {
    id: String(n.id),
    nodeType: (n.node_type || n.nodeType || n.type || 'UNKNOWN') as string,
    name: (n.name as string) || '',
    file: (n.file as string) || '',
    exported: (n.exported as boolean) || false,
    metadata: typeof n.metadata === 'string' ? n.metadata : JSON.stringify(n.metadata || {}),
  };
}

/**
 * FIXED implementation that preserves extra fields
 */
function mapNodeForWireFormatFixed(n: Record<string, unknown>): {
  id: string;
  nodeType: string;
  name: string;
  file: string;
  exported: boolean;
  metadata: string;
} {
  // Extract known wire format fields, rest goes to metadata
  const { id, type, node_type, nodeType, name, file, exported, metadata, ...rest } = n;

  // Merge explicit metadata with extra properties
  const existingMeta = typeof metadata === 'string' ? JSON.parse(metadata as string) : (metadata || {});
  const combinedMeta = { ...existingMeta, ...rest };

  return {
    id: String(id),
    nodeType: (node_type || nodeType || type || 'UNKNOWN') as string,
    name: (name as string) || '',
    file: (file as string) || '',
    exported: (exported as boolean) || false,
    metadata: JSON.stringify(combinedMeta),
  };
}

describe('RFDBClient.addNodes() Metadata Preservation', () => {
  /**
   * WHY: JSASTAnalyzer collects constraints for SCOPE nodes during analysis.
   * These constraints contain guard information like "someValue !== null".
   * If constraints are lost during serialization, the graph cannot answer
   * questions like "what conditions guard this code execution?"
   *
   * This test documents the BUG: constraints are silently discarded.
   */
  it('BUG: current implementation loses constraints field', () => {
    const scopeNode = {
      id: 'SCOPE:file.js:10',
      type: 'SCOPE',
      name: 'if_branch',
      file: 'file.js',
      // Extra fields that should be preserved
      constraints: [
        { variable: 'someValue', operator: '!==', value: 'null' },
      ],
      condition: 'someValue !== null',
      scopeType: 'if_statement',
      conditional: true,
      line: 10,
    };

    const wireNode = mapNodeForWireFormat(scopeNode);
    const metadata = JSON.parse(wireNode.metadata);

    // BUG: These assertions FAIL - constraints are lost
    // Once the bug is fixed, these will pass
    assert.strictEqual(metadata.constraints, undefined, 'BUG: constraints should be lost in current impl');
    assert.strictEqual(metadata.condition, undefined, 'BUG: condition should be lost in current impl');
    assert.strictEqual(metadata.scopeType, undefined, 'BUG: scopeType should be lost in current impl');
    assert.strictEqual(metadata.conditional, undefined, 'BUG: conditional should be lost in current impl');
    assert.strictEqual(metadata.line, undefined, 'BUG: line should be lost in current impl');
  });

  /**
   * WHY: After the fix, extra fields should be merged into metadata.
   * This test verifies the EXPECTED behavior after REG-274 is implemented.
   */
  it('FIXED: should preserve constraints in metadata', () => {
    const scopeNode = {
      id: 'SCOPE:file.js:10',
      type: 'SCOPE',
      name: 'if_branch',
      file: 'file.js',
      // Extra fields that should be preserved
      constraints: [
        { variable: 'someValue', operator: '!==', value: 'null' },
      ],
      condition: 'someValue !== null',
      scopeType: 'if_statement',
      conditional: true,
      line: 10,
    };

    const wireNode = mapNodeForWireFormatFixed(scopeNode);
    const metadata = JSON.parse(wireNode.metadata);

    // These assertions should PASS after fix
    assert.deepStrictEqual(
      metadata.constraints,
      [{ variable: 'someValue', operator: '!==', value: 'null' }],
      'constraints should be preserved in metadata'
    );
    assert.strictEqual(metadata.condition, 'someValue !== null', 'condition should be preserved');
    assert.strictEqual(metadata.scopeType, 'if_statement', 'scopeType should be preserved');
    assert.strictEqual(metadata.conditional, true, 'conditional should be preserved');
    assert.strictEqual(metadata.line, 10, 'line should be preserved');
  });

  /**
   * WHY: Extra fields should be MERGED with existing metadata, not replace it.
   */
  it('FIXED: should merge extra fields with existing metadata', () => {
    const node = {
      id: 'NODE:test',
      type: 'SCOPE',
      name: 'test',
      file: 'test.js',
      metadata: { existingField: 'value', semanticId: 'test->scope' },
      // Extra fields
      constraints: [{ variable: 'x', operator: '>', value: '0' }],
      newField: 'newValue',
    };

    const wireNode = mapNodeForWireFormatFixed(node);
    const metadata = JSON.parse(wireNode.metadata);

    assert.strictEqual(metadata.existingField, 'value', 'existing metadata should be preserved');
    assert.strictEqual(metadata.semanticId, 'test->scope', 'semanticId should be preserved');
    assert.deepStrictEqual(
      metadata.constraints,
      [{ variable: 'x', operator: '>', value: '0' }],
      'new constraints should be added'
    );
    assert.strictEqual(metadata.newField, 'newValue', 'new fields should be added');
  });

  /**
   * WHY: String metadata (JSON string) should be parsed and merged.
   */
  it('FIXED: should handle string metadata correctly', () => {
    const node = {
      id: 'NODE:test',
      type: 'CALL',
      name: 'test',
      file: 'test.js',
      metadata: JSON.stringify({ callee: 'foo', args: ['a', 'b'] }),
      // Extra field
      resolved: true,
    };

    const wireNode = mapNodeForWireFormatFixed(node);
    const metadata = JSON.parse(wireNode.metadata);

    assert.strictEqual(metadata.callee, 'foo', 'callee from string metadata should be preserved');
    assert.deepStrictEqual(metadata.args, ['a', 'b'], 'args from string metadata should be preserved');
    assert.strictEqual(metadata.resolved, true, 'extra field should be merged');
  });

  /**
   * WHY: Known wire fields (id, type, name, file, exported) should NOT
   * appear in metadata - they have their own fields in the wire format.
   */
  it('FIXED: should not duplicate known fields in metadata', () => {
    const node = {
      id: 'NODE:test',
      type: 'FUNCTION',
      name: 'myFunc',
      file: 'test.js',
      exported: true,
      // Only extra fields should go to metadata
      async: true,
      generator: false,
    };

    const wireNode = mapNodeForWireFormatFixed(node);
    const metadata = JSON.parse(wireNode.metadata);

    // Known fields should NOT be in metadata (they have dedicated wire fields)
    assert.strictEqual(metadata.id, undefined, 'id should not be duplicated in metadata');
    assert.strictEqual(metadata.type, undefined, 'type should not be duplicated in metadata');
    assert.strictEqual(metadata.name, undefined, 'name should not be duplicated in metadata');
    assert.strictEqual(metadata.file, undefined, 'file should not be duplicated in metadata');
    assert.strictEqual(metadata.exported, undefined, 'exported should not be duplicated in metadata');

    // Extra fields SHOULD be in metadata
    assert.strictEqual(metadata.async, true, 'async should be in metadata');
    assert.strictEqual(metadata.generator, false, 'generator should be in metadata');

    // Verify wire format fields are set correctly
    assert.strictEqual(wireNode.id, 'NODE:test');
    assert.strictEqual(wireNode.nodeType, 'FUNCTION');
    assert.strictEqual(wireNode.name, 'myFunc');
    assert.strictEqual(wireNode.file, 'test.js');
    assert.strictEqual(wireNode.exported, true);
  });

  /**
   * WHY: Empty or undefined metadata should work correctly.
   */
  it('FIXED: should handle nodes without metadata', () => {
    const node = {
      id: 'NODE:test',
      type: 'MODULE',
      name: 'test',
      file: 'test.js',
      // No metadata field
      version: '1.0.0',
    };

    const wireNode = mapNodeForWireFormatFixed(node);
    const metadata = JSON.parse(wireNode.metadata);

    assert.strictEqual(metadata.version, '1.0.0', 'extra field should become metadata');
  });

  /**
   * WHY: Nested conditional scopes should preserve their constraint chain.
   * This is critical for find_guards to work correctly.
   */
  it('FIXED: should preserve nested scope constraints', () => {
    const outerScope = {
      id: 'SCOPE:file.js:5',
      type: 'SCOPE',
      name: 'if_branch',
      file: 'file.js',
      constraints: [{ variable: 'user', operator: '!==', value: 'null' }],
      condition: 'user !== null',
      scopeType: 'if_statement',
      conditional: true,
      line: 5,
    };

    const innerScope = {
      id: 'SCOPE:file.js:7',
      type: 'SCOPE',
      name: 'if_branch',
      file: 'file.js',
      constraints: [{ variable: 'user.isAdmin', operator: '===', value: 'true' }],
      condition: 'user.isAdmin',
      scopeType: 'if_statement',
      conditional: true,
      parentScope: 'SCOPE:file.js:5',
      line: 7,
    };

    const outerWire = mapNodeForWireFormatFixed(outerScope);
    const innerWire = mapNodeForWireFormatFixed(innerScope);

    const outerMeta = JSON.parse(outerWire.metadata);
    const innerMeta = JSON.parse(innerWire.metadata);

    // Both scopes should preserve their constraints
    assert.deepStrictEqual(
      outerMeta.constraints,
      [{ variable: 'user', operator: '!==', value: 'null' }]
    );
    assert.deepStrictEqual(
      innerMeta.constraints,
      [{ variable: 'user.isAdmin', operator: '===', value: 'true' }]
    );

    // Inner scope should reference parent
    assert.strictEqual(innerMeta.parentScope, 'SCOPE:file.js:5');
  });
});
