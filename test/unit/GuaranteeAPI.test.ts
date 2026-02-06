/**
 * Tests for GuaranteeAPI (contract-based guarantees)
 *
 * Tests:
 * - Creating contract-based guarantees
 * - Finding/listing guarantees with filters
 * - Updating guarantees
 * - Deleting guarantees
 * - GOVERNS edges management
 * - Schema validation (checkGuarantee)
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase } from '../helpers/TestRFDB.js';
import { GuaranteeAPI, type GuaranteeGraphBackend, GuaranteeNode } from '@grafema/core';

describe('GuaranteeAPI', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'];
  let api: GuaranteeAPI;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
    api = new GuaranteeAPI(backend as unknown as GuaranteeGraphBackend);
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  describe('createGuarantee()', () => {
    it('should create a guarantee:queue node', async () => {
      const guarantee = await api.createGuarantee({
        type: 'guarantee:queue',
        name: 'orders',
        priority: 'critical',
        status: 'active',
        description: 'Orders queue contract',
      });

      assert.strictEqual(guarantee.id, 'guarantee:queue#orders');
      assert.strictEqual(guarantee.type, 'guarantee:queue');
      assert.strictEqual(guarantee.priority, 'critical');
      assert.strictEqual(guarantee.status, 'active');

      // Verify node exists in graph
      const node = await backend.getNode('guarantee:queue#orders');
      assert.ok(node, 'Guarantee node should exist in graph');
    });

    it('should create a guarantee:api node', async () => {
      const guarantee = await api.createGuarantee({
        type: 'guarantee:api',
        name: 'rate-limit',
        priority: 'important',
        status: 'discovered',
      });

      assert.strictEqual(guarantee.id, 'guarantee:api#rate-limit');
      assert.strictEqual(guarantee.type, 'guarantee:api');
    });

    it('should create guarantee with schema', async () => {
      const guarantee = await api.createGuarantee({
        type: 'guarantee:queue',
        name: 'events',
        schema: {
          type: 'object',
          required: ['eventType', 'timestamp'],
          properties: {
            eventType: { type: 'string' },
            timestamp: { type: 'number' },
          },
        },
      });

      assert.ok(guarantee.schema, 'Should have schema');
      assert.deepStrictEqual(guarantee.schema.required, ['eventType', 'timestamp']);
    });

    it('should use default values for optional fields', async () => {
      const guarantee = await api.createGuarantee({
        type: 'guarantee:queue',
        name: 'default-test',
      });

      assert.strictEqual(guarantee.priority, 'observed');
      assert.strictEqual(guarantee.status, 'discovered');
    });

    it('should reject invalid type', async () => {
      await assert.rejects(
        () => api.createGuarantee({
          type: 'invalid:type' as 'guarantee:queue',
          name: 'test',
        }),
        /Invalid guarantee type/
      );
    });
  });

  describe('getGuarantee()', () => {
    it('should get guarantee by ID', async () => {
      await api.createGuarantee({
        type: 'guarantee:queue',
        name: 'test-get',
        priority: 'critical',
      });

      const guarantee = await api.getGuarantee('guarantee:queue#test-get');
      assert.ok(guarantee);
      assert.strictEqual(guarantee.name, 'test-get');
      assert.strictEqual(guarantee.priority, 'critical');
    });

    it('should return null for non-existent guarantee', async () => {
      const guarantee = await api.getGuarantee('guarantee:queue#nonexistent');
      assert.strictEqual(guarantee, null);
    });
  });

  describe('findGuarantees()', () => {
    beforeEach(async () => {
      // Create test guarantees
      await api.createGuarantee({ type: 'guarantee:queue', name: 'q1', priority: 'critical', status: 'active' });
      await api.createGuarantee({ type: 'guarantee:queue', name: 'q2', priority: 'important', status: 'active' });
      await api.createGuarantee({ type: 'guarantee:api', name: 'a1', priority: 'critical', status: 'discovered' });
    });

    it('should find all guarantees', async () => {
      const guarantees = await api.findGuarantees();
      assert.strictEqual(guarantees.length, 3);
    });

    it('should filter by type', async () => {
      const guarantees = await api.findGuarantees({ type: 'guarantee:queue' });
      assert.strictEqual(guarantees.length, 2);
    });

    it('should filter by priority', async () => {
      const guarantees = await api.findGuarantees({ priority: 'critical' });
      assert.strictEqual(guarantees.length, 2);
    });

    it('should filter by status', async () => {
      const guarantees = await api.findGuarantees({ status: 'active' });
      assert.strictEqual(guarantees.length, 2);
    });

    it('should filter by multiple criteria', async () => {
      const guarantees = await api.findGuarantees({
        type: 'guarantee:queue',
        priority: 'critical',
      });
      assert.strictEqual(guarantees.length, 1);
      assert.strictEqual(guarantees[0].name, 'q1');
    });
  });

  describe('updateGuarantee()', () => {
    it('should update guarantee fields', async () => {
      await api.createGuarantee({
        type: 'guarantee:queue',
        name: 'update-test',
        priority: 'observed',
        status: 'discovered',
      });

      const updated = await api.updateGuarantee('guarantee:queue#update-test', {
        priority: 'critical',
        status: 'active',
        description: 'Updated description',
      });

      assert.strictEqual(updated.priority, 'critical');
      assert.strictEqual(updated.status, 'active');
      assert.strictEqual(updated.description, 'Updated description');
    });

    it('should reject update for non-existent guarantee', async () => {
      await assert.rejects(
        () => api.updateGuarantee('guarantee:queue#nonexistent', { priority: 'critical' }),
        /not found/
      );
    });
  });

  describe('deleteGuarantee()', () => {
    it('should delete guarantee', async () => {
      await api.createGuarantee({
        type: 'guarantee:queue',
        name: 'delete-test',
      });

      const deleted = await api.deleteGuarantee('guarantee:queue#delete-test');
      assert.strictEqual(deleted, true);

      const guarantee = await api.getGuarantee('guarantee:queue#delete-test');
      assert.strictEqual(guarantee, null);
    });

    it('should return false for non-existent guarantee', async () => {
      const deleted = await api.deleteGuarantee('guarantee:queue#nonexistent');
      assert.strictEqual(deleted, false);
    });
  });

  describe('GOVERNS edges', () => {
    it('should create GOVERNS edges on guarantee creation', async () => {
      // First create a target node
      await backend.addNode({
        id: 'MODULE:test-module',
        type: 'MODULE',
        name: 'test-module',
        file: '/test/module.js',
      });

      await api.createGuarantee({
        type: 'guarantee:queue',
        name: 'governs-test',
        governs: ['MODULE:test-module'],
      });

      const governed = await api.getGoverned('guarantee:queue#governs-test');
      assert.strictEqual(governed.length, 1);
      assert.strictEqual(governed[0], 'MODULE:test-module');
    });

    it('should add GOVERNS edge manually', async () => {
      await api.createGuarantee({
        type: 'guarantee:queue',
        name: 'manual-governs',
      });

      await backend.addNode({
        id: 'FUNCTION:test-fn',
        type: 'FUNCTION',
        name: 'test-fn',
        file: '/test/fn.js',
      });

      await api.addGoverns('guarantee:queue#manual-governs', 'FUNCTION:test-fn');

      const governed = await api.getGoverned('guarantee:queue#manual-governs');
      assert.ok(governed.includes('FUNCTION:test-fn'));
    });

    it('should get governing guarantees for a node', async () => {
      await backend.addNode({
        id: 'MODULE:governed-module',
        type: 'MODULE',
        name: 'governed-module',
        file: '/test/governed.js',
      });

      await api.createGuarantee({
        type: 'guarantee:queue',
        name: 'gov1',
        governs: ['MODULE:governed-module'],
      });

      await api.createGuarantee({
        type: 'guarantee:api',
        name: 'gov2',
        governs: ['MODULE:governed-module'],
      });

      const governing = await api.getGoverningGuarantees('MODULE:governed-module');
      assert.strictEqual(governing.length, 2);
    });

    it('should remove GOVERNS edge', async () => {
      await backend.addNode({
        id: 'MODULE:remove-test',
        type: 'MODULE',
        name: 'remove-test',
        file: '/test/remove.js',
      });

      await api.createGuarantee({
        type: 'guarantee:queue',
        name: 'remove-governs',
        governs: ['MODULE:remove-test'],
      });

      await api.removeGoverns('guarantee:queue#remove-governs', 'MODULE:remove-test');

      const governed = await api.getGoverned('guarantee:queue#remove-governs');
      assert.strictEqual(governed.length, 0);
    });

    it('should delete GOVERNS edges when deleting guarantee', async () => {
      await backend.addNode({
        id: 'MODULE:cleanup-test',
        type: 'MODULE',
        name: 'cleanup-test',
        file: '/test/cleanup.js',
      });

      await api.createGuarantee({
        type: 'guarantee:queue',
        name: 'cleanup-governs',
        governs: ['MODULE:cleanup-test'],
      });

      await api.deleteGuarantee('guarantee:queue#cleanup-governs');

      // Check that incoming GOVERNS edges are removed
      const incomingEdges = await backend.getIncomingEdges('MODULE:cleanup-test', ['GOVERNS']);
      assert.strictEqual(incomingEdges.length, 0);
    });
  });

  describe('checkGuarantee()', () => {
    it('should pass for guarantee without schema', async () => {
      await api.createGuarantee({
        type: 'guarantee:queue',
        name: 'no-schema',
      });

      const result = await api.checkGuarantee('guarantee:queue#no-schema');
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.errors.length, 0);
    });

    it('should validate governed nodes against schema', async () => {
      // Create nodes first (before guarantee with governs)
      await backend.addNode({
        id: 'NODE:valid',
        type: 'VARIABLE',
        name: 'valid-node',
        file: '/test/valid.js',
      });

      await backend.addNode({
        id: 'NODE:invalid',
        type: 'VARIABLE',
        file: '/test/invalid.js',
        // name is missing
      });

      // Create guarantee with schema that references the existing nodes
      await api.createGuarantee({
        type: 'guarantee:queue',
        name: 'schema-check',
        schema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
          },
        },
        governs: ['NODE:valid', 'NODE:invalid'],
      });

      const result = await api.checkGuarantee('guarantee:queue#schema-check');
      // The check validates node structure against schema
      assert.strictEqual(result.validatedCount, 2);
    });

    it('should report invalid schema', async () => {
      await api.createGuarantee({
        type: 'guarantee:queue',
        name: 'invalid-schema',
        schema: {
          type: 'invalid-type-that-does-not-exist',
        },
      });

      const result = await api.checkGuarantee('guarantee:queue#invalid-schema');
      assert.strictEqual(result.passed, false);
      assert.ok(result.errors.some(e => e.includes('Invalid schema')));
    });
  });

  describe('checkAllGuarantees()', () => {
    it('should check all guarantees and return summary', async () => {
      await api.createGuarantee({ type: 'guarantee:queue', name: 'check-all-1' });
      await api.createGuarantee({ type: 'guarantee:api', name: 'check-all-2' });

      const result = await api.checkAllGuarantees();
      assert.strictEqual(result.total, 2);
      assert.strictEqual(result.passed, 2);
      assert.strictEqual(result.failed, 0);
      assert.strictEqual(result.results.length, 2);
    });
  });

  describe('GuaranteeNode helpers', () => {
    it('should parse ID correctly', () => {
      const parsed = GuaranteeNode.parseId('guarantee:queue#orders');
      assert.ok(parsed);
      assert.strictEqual(parsed.namespace, 'queue');
      assert.strictEqual(parsed.name, 'orders');
    });

    it('should return null for invalid ID', () => {
      assert.strictEqual(GuaranteeNode.parseId('invalid'), null);
      assert.strictEqual(GuaranteeNode.parseId('GUARANTEE:test'), null);
    });

    it('should build ID from components', () => {
      const id = GuaranteeNode.buildId('api', 'rate-limit');
      assert.strictEqual(id, 'guarantee:api#rate-limit');
    });

    it('should validate guarantee node', () => {
      const validNode = GuaranteeNode.create('queue', 'test', {
        priority: 'critical',
        status: 'active',
      });
      const errors = GuaranteeNode.validate(validNode);
      assert.strictEqual(errors.length, 0);
    });

    it('should report validation errors', () => {
      const invalidNode = {
        id: 'guarantee:queue#test',
        type: 'INVALID' as 'guarantee:queue',
        name: 'test',
        file: '',
        priority: 'invalid' as 'critical',
        status: 'invalid' as 'active',
      };
      const errors = GuaranteeNode.validate(invalidNode);
      assert.ok(errors.length > 0);
    });
  });
});
