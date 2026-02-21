/**
 * NodeFactory — New Methods Tests (REG-541)
 *
 * TDD tests for 4 new NodeFactory factory methods required by REG-541:
 * 1. createSystemDbViewRegistration() — SYSTEM_DB_VIEW_REGISTRATION nodes
 * 2. createSystemDbSubscription() — SYSTEM_DB_SUBSCRIPTION nodes
 * 3. createGraphMeta() — GRAPH_META nodes
 * 4. createGuarantee() — GUARANTEE nodes (Datalog-based, from GuaranteeManager)
 *
 * Also tests that NodeFactory.validate() recognizes these 4 new types.
 *
 * These methods do not exist yet — tests define the contract,
 * implementation follows (TDD).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { NodeFactory } from '@grafema/core';

// ============================================================================
// 1. createSystemDbViewRegistration()
// ============================================================================

describe('NodeFactory.createSystemDbViewRegistration', () => {

  it('should return node with type SYSTEM_DB_VIEW_REGISTRATION', () => {
    const node = NodeFactory.createSystemDbViewRegistration(
      '/src/views.js:SYSTEM_DB_VIEW_REGISTRATION:ordersView:42',
      {
        viewName: 'ordersView',
        serverName: 'mainDb',
        callType: 'registerView',
        file: '/src/views.js',
        line: 42,
        column: 4,
      }
    );

    assert.strictEqual(node.type, 'SYSTEM_DB_VIEW_REGISTRATION');
  });

  it('should include viewName, serverName, callType, file, line, column', () => {
    const node = NodeFactory.createSystemDbViewRegistration(
      '/src/views.js:SYSTEM_DB_VIEW_REGISTRATION:usersView:10',
      {
        viewName: 'usersView',
        serverName: 'replicaDb',
        callType: 'addView',
        file: '/src/views.js',
        line: 10,
        column: 8,
      }
    );

    assert.strictEqual(node.viewName, 'usersView');
    assert.strictEqual(node.serverName, 'replicaDb');
    assert.strictEqual(node.callType, 'addView');
    assert.strictEqual(node.file, '/src/views.js');
    assert.strictEqual(node.line, 10);
    assert.strictEqual(node.column, 8);
  });

  it('should return branded node with correct id', () => {
    const nodeId = '/src/views.js:SYSTEM_DB_VIEW_REGISTRATION:ordersView:42';
    const node = NodeFactory.createSystemDbViewRegistration(nodeId, {
      viewName: 'ordersView',
      serverName: 'mainDb',
      callType: 'registerView',
      file: '/src/views.js',
      line: 42,
      column: 4,
    });

    assert.strictEqual(node.id, nodeId);
    // Branded nodes are a type-level concept; at runtime every node from
    // NodeFactory is considered branded. We verify the node has the required
    // BaseNodeRecord fields: id, type, name, file.
    assert.ok(node.id, 'Branded node must have id');
    assert.ok(node.type, 'Branded node must have type');
    assert.ok(typeof node.file === 'string', 'Branded node must have file');
  });

  it('should generate a descriptive name', () => {
    const node = NodeFactory.createSystemDbViewRegistration(
      '/src/views.js:SYSTEM_DB_VIEW_REGISTRATION:ordersView:42',
      {
        viewName: 'ordersView',
        serverName: 'mainDb',
        callType: 'registerView',
        file: '/src/views.js',
        line: 42,
        column: 4,
      }
    );

    // The name should be present and non-empty
    assert.ok(node.name, 'Node should have a name');
    assert.strictEqual(typeof node.name, 'string');
  });

});


// ============================================================================
// 2. createSystemDbSubscription()
// ============================================================================

describe('NodeFactory.createSystemDbSubscription', () => {

  it('should return node with type SYSTEM_DB_SUBSCRIPTION', () => {
    const node = NodeFactory.createSystemDbSubscription(
      '/src/subs.js:SYSTEM_DB_SUBSCRIPTION:15',
      {
        servers: ['server1', 'server2'],
        file: '/src/subs.js',
        line: 15,
        column: 2,
      }
    );

    assert.strictEqual(node.type, 'SYSTEM_DB_SUBSCRIPTION');
  });

  it('should include servers array', () => {
    const node = NodeFactory.createSystemDbSubscription(
      '/src/subs.js:SYSTEM_DB_SUBSCRIPTION:15',
      {
        servers: ['primaryDb', 'replicaDb'],
        file: '/src/subs.js',
        line: 15,
        column: 2,
      }
    );

    assert.ok(Array.isArray(node.servers), 'servers must be an array');
    assert.deepStrictEqual(node.servers, ['primaryDb', 'replicaDb']);
  });

  it('should return branded node with correct file and line', () => {
    const node = NodeFactory.createSystemDbSubscription(
      '/src/subs.js:SYSTEM_DB_SUBSCRIPTION:20',
      {
        servers: ['db1'],
        file: '/src/subs.js',
        line: 20,
        column: 0,
      }
    );

    assert.strictEqual(node.file, '/src/subs.js');
    assert.strictEqual(node.line, 20);
    assert.strictEqual(node.column, 0);
  });

});


// ============================================================================
// 3. createGraphMeta()
// ============================================================================

describe('NodeFactory.createGraphMeta', () => {

  it('should return node with type GRAPH_META', () => {
    const node = NodeFactory.createGraphMeta({
      id: '__graph_meta__',
      projectPath: '/home/user/project',
      analyzedAt: '2026-02-21T12:00:00Z',
    });

    assert.strictEqual(node.type, 'GRAPH_META');
  });

  it('should include id and metadata fields', () => {
    const node = NodeFactory.createGraphMeta({
      id: '__graph_meta__',
      projectPath: '/home/user/project',
      analyzedAt: '2026-02-21T12:00:00Z',
    });

    assert.strictEqual(node.id, '__graph_meta__');
    assert.strictEqual(node.projectPath, '/home/user/project');
    assert.strictEqual(node.analyzedAt, '2026-02-21T12:00:00Z');
  });

  it('should return branded node with required BaseNodeRecord fields', () => {
    const node = NodeFactory.createGraphMeta({
      id: '__graph_meta__',
      projectPath: '/home/user/project',
      analyzedAt: '2026-02-21T12:00:00Z',
    });

    assert.ok(node.id, 'Must have id');
    assert.ok(node.type, 'Must have type');
    assert.strictEqual(typeof node.name, 'string', 'Must have name (can be default)');
    assert.strictEqual(typeof node.file, 'string', 'Must have file (can be empty)');
  });

});


// ============================================================================
// 4. createGuarantee()
// ============================================================================

describe('NodeFactory.createGuarantee', () => {

  it('should return node with type GUARANTEE', () => {
    const node = NodeFactory.createGuarantee({
      id: 'eval-ban',
      rule: 'violation(X) :- node(X, "CALL"), attr(X, "name", "eval").',
      severity: 'error',
      governs: ['**/*.js'],
    });

    assert.strictEqual(node.type, 'GUARANTEE');
  });

  it('should include rule, severity, governs', () => {
    const node = NodeFactory.createGuarantee({
      id: 'no-sync-io',
      name: 'No synchronous IO',
      rule: 'violation(X) :- node(X, "CALL"), attr(X, "name", "readFileSync").',
      severity: 'warning',
      governs: ['src/**/*.js'],
    });

    assert.strictEqual(node.rule, 'violation(X) :- node(X, "CALL"), attr(X, "name", "readFileSync").');
    assert.strictEqual(node.severity, 'warning');
    assert.deepStrictEqual(node.governs, ['src/**/*.js']);
  });

  it('should generate GUARANTEE: prefixed id', () => {
    const node = NodeFactory.createGuarantee({
      id: 'eval-ban',
      rule: 'violation(X) :- node(X, "CALL"), attr(X, "name", "eval").',
    });

    assert.strictEqual(node.id, 'GUARANTEE:eval-ban');
  });

  it('should use default severity when not provided', () => {
    const node = NodeFactory.createGuarantee({
      id: 'test-guarantee',
      rule: 'violation(X) :- node(X, "CALL").',
    });

    // Default severity should be 'warning' (matching GuaranteeManager behavior)
    assert.strictEqual(node.severity, 'warning');
  });

  it('should return branded node', () => {
    const node = NodeFactory.createGuarantee({
      id: 'test',
      rule: 'violation(X) :- node(X, "CALL").',
    });

    assert.ok(node.id, 'Must have id');
    assert.ok(node.type, 'Must have type');
    assert.strictEqual(typeof node.name, 'string');
  });

});


// ============================================================================
// 5. NodeFactory.validate() — new types
// ============================================================================

describe('NodeFactory.validate() — new types', () => {

  it('should NOT return errors for SYSTEM_DB_VIEW_REGISTRATION', () => {
    const node = NodeFactory.createSystemDbViewRegistration(
      '/src/views.js:SYSTEM_DB_VIEW_REGISTRATION:ordersView:42',
      {
        viewName: 'ordersView',
        serverName: 'mainDb',
        callType: 'registerView',
        file: '/src/views.js',
        line: 42,
        column: 4,
      }
    );

    const errors = NodeFactory.validate(node);
    assert.deepStrictEqual(errors, [], `Expected no errors for SYSTEM_DB_VIEW_REGISTRATION, got: ${errors.join(', ')}`);
  });

  it('should NOT return errors for SYSTEM_DB_SUBSCRIPTION', () => {
    const node = NodeFactory.createSystemDbSubscription(
      '/src/subs.js:SYSTEM_DB_SUBSCRIPTION:15',
      {
        servers: ['db1'],
        file: '/src/subs.js',
        line: 15,
        column: 2,
      }
    );

    const errors = NodeFactory.validate(node);
    assert.deepStrictEqual(errors, [], `Expected no errors for SYSTEM_DB_SUBSCRIPTION, got: ${errors.join(', ')}`);
  });

  it('should NOT return errors for GRAPH_META', () => {
    const node = NodeFactory.createGraphMeta({
      id: '__graph_meta__',
      projectPath: '/home/user/project',
      analyzedAt: '2026-02-21T12:00:00Z',
    });

    const errors = NodeFactory.validate(node);
    assert.deepStrictEqual(errors, [], `Expected no errors for GRAPH_META, got: ${errors.join(', ')}`);
  });

  it('should NOT return errors for GUARANTEE', () => {
    const node = NodeFactory.createGuarantee({
      id: 'test-validate',
      rule: 'violation(X) :- node(X, "CALL").',
      severity: 'error',
      governs: ['**/*.js'],
    });

    const errors = NodeFactory.validate(node);
    assert.deepStrictEqual(errors, [], `Expected no errors for GUARANTEE, got: ${errors.join(', ')}`);
  });

});
