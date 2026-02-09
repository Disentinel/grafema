/**
 * PathValidator TDD Tests
 *
 * ЦЕЛЬ: PathValidator проверяет безопасность рефакторинга через path equivalence
 *
 * КОНЦЕПЦИЯ (из INCREMENTAL_ANALYSIS_DESIGN.md):
 * 1. Трассируем пути от main версии до endpoints (DATABASE, HTTP, EXTERNAL)
 * 2. Трассируем пути от __local версии до тех же endpoints
 * 3. Сравниваем: если все пути сохранились → safe, если нет → breaking change
 *
 * ENDPOINTS:
 * - EXTERNAL: DATABASE_QUERY, HTTP_REQUEST, FILESYSTEM, NETWORK
 * - MODULE_BOUNDARY: exported functions
 * - SIDE_EFFECTS: console.log, process.exit и т.д.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { PathValidator } from '@grafema/core';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { versionManager } from '@grafema/core';

after(cleanupAllTestDatabases);

describe('PathValidator', () => {
  let db;
  let backend;
  let pathValidator;

  before(async () => {
    db = await createTestDatabase();
    backend = db.backend;
    pathValidator = new PathValidator(backend);
  });

  after(async () => {
    if (backend) {
      await backend.close();
    }
  });

  describe('Scenario 1: Safe Refactoring - All Paths Preserved', () => {
    /**
     * MAIN version:
     *   processOrder(id) → db.query → sendEmail
     *
     * LOCAL version (refactored with helper):
     *   processOrder(id) → fetchOrder → db.query
     *                    → sendEmail
     *
     * Result: SAFE (все endpoints достижимы)
     */
    it('should pass when all critical paths are preserved', async () => {
      await backend.clear();

      // Setup main version
      const mainFunction = versionManager.enrichNodeWithVersion({
        type: 'FUNCTION',
        name: 'processOrder',
        file: 'orders.js',
        params: ['id']
      }, 'main');

      const mainDbQuery = versionManager.enrichNodeWithVersion({
        type: 'db:query',
        name: 'SELECT * FROM orders',
        query: 'SELECT * FROM orders WHERE id = ?',
        operation: 'SELECT'
      }, 'main');

      const mainEmail = versionManager.enrichNodeWithVersion({
        type: 'EXTERNAL',
        name: 'sendEmail',
        service: 'email'
      }, 'main');

      await backend.addNode(mainFunction);
      await backend.addNode(mainDbQuery);
      await backend.addNode(mainEmail);

      await backend.addEdge({ type: 'CALLS', src: mainFunction.id, dst: mainDbQuery.id });
      await backend.addEdge({ type: 'CALLS', src: mainFunction.id, dst: mainEmail.id });

      // Setup local version (refactored)
      const localFunction = versionManager.enrichNodeWithVersion({
        type: 'FUNCTION',
        name: 'processOrder',
        file: 'orders.js',
        params: ['id']
      }, '__local');

      const localHelper = versionManager.enrichNodeWithVersion({
        type: 'FUNCTION',
        name: 'fetchOrder',
        file: 'orders.js',
        params: ['id']
      }, '__local');

      await backend.addNode(localFunction);
      await backend.addNode(localHelper);

      // Local version still reaches same endpoints (через helper)
      await backend.addEdge({ type: 'CALLS', src: localFunction.id, dst: localHelper.id });
      await backend.addEdge({ type: 'CALLS', src: localHelper.id, dst: mainDbQuery.id });
      await backend.addEdge({ type: 'CALLS', src: localFunction.id, dst: mainEmail.id });

      // Test
      const result = await pathValidator.checkPathEquivalence('processOrder', 'orders.js');

      assert.strictEqual(result.safe, true);
      assert.strictEqual(result.severity, 'info');
      assert.match(result.message, /safe refactoring/i);
      assert.strictEqual(result.endpointsChecked, 2); // db.query + sendEmail
    });
  });

  describe('Scenario 2: Breaking Change - Path Removed', () => {
    /**
     * MAIN version:
     *   processOrder(id) → db.query → sendEmail
     *
     * LOCAL version (broken):
     *   processOrder(id) → sendEmail
     *                    (забыли db.query!)
     *
     * Result: UNSAFE (critical endpoint removed)
     */
    it('should fail when critical path is removed', async () => {
      await backend.clear();

      // Setup main version
      const mainFunction = versionManager.enrichNodeWithVersion({
        type: 'FUNCTION',
        name: 'processOrder',
        file: 'orders.js',
        params: ['id']
      }, 'main');

      const mainDbQuery = versionManager.enrichNodeWithVersion({
        type: 'db:query',
        name: 'SELECT * FROM orders',
        query: 'SELECT * FROM orders WHERE id = ?',
        operation: 'SELECT'
      }, 'main');

      const mainEmail = versionManager.enrichNodeWithVersion({
        type: 'EXTERNAL',
        name: 'sendEmail',
        service: 'email'
      }, 'main');

      await backend.addNode(mainFunction);
      await backend.addNode(mainDbQuery);
      await backend.addNode(mainEmail);

      await backend.addEdge({ type: 'CALLS', src: mainFunction.id, dst: mainDbQuery.id });
      await backend.addEdge({ type: 'CALLS', src: mainFunction.id, dst: mainEmail.id });

      // Setup local version (BROKEN - no db.query)
      const localFunction = versionManager.enrichNodeWithVersion({
        type: 'FUNCTION',
        name: 'processOrder',
        file: 'orders.js',
        params: ['id']
      }, '__local');

      await backend.addNode(localFunction);
      await backend.addEdge({ type: 'CALLS', src: localFunction.id, dst: mainEmail.id });

      // Test
      const result = await pathValidator.checkPathEquivalence('processOrder', 'orders.js');

      assert.strictEqual(result.safe, false);
      assert.strictEqual(result.severity, 'error');
      assert.match(result.message, /breaking change/i);
      assert.ok(result.missing);
      assert.strictEqual(result.missing.length, 1);
      // DATABASE_QUERY is now mapped to 'db:query'
      assert.strictEqual(result.missing[0].type, 'db:query');
      // The reason message is "Endpoint no longer reachable: <name>"
      assert.match(result.missing[0].reason, /no longer reachable/i);
    });
  });

  describe('Scenario 3: Warning - New Behavior Added', () => {
    /**
     * MAIN version:
     *   processOrder(id) → db.query
     *
     * LOCAL version (new behavior):
     *   processOrder(id) → db.query
     *                    → logAudit (NEW!)
     *
     * Result: SAFE but WARNING (new endpoint added)
     */
    it('should warn when new behavior is added', async () => {
      await backend.clear();

      // Setup main version
      const mainFunction = versionManager.enrichNodeWithVersion({
        type: 'FUNCTION',
        name: 'processOrder',
        file: 'orders.js',
        params: ['id']
      }, 'main');

      const mainDbQuery = versionManager.enrichNodeWithVersion({
        type: 'db:query',
        name: 'SELECT * FROM orders',
        query: 'SELECT * FROM orders WHERE id = ?'
      }, 'main');

      await backend.addNode(mainFunction);
      await backend.addNode(mainDbQuery);
      await backend.addEdge({ type: 'CALLS', src: mainFunction.id, dst: mainDbQuery.id });

      // Setup local version (NEW behavior)
      const localFunction = versionManager.enrichNodeWithVersion({
        type: 'FUNCTION',
        name: 'processOrder',
        file: 'orders.js',
        params: ['id']
      }, '__local');

      const localAudit = versionManager.enrichNodeWithVersion({
        type: 'db:query',
        name: 'INSERT INTO audit',
        query: 'INSERT INTO audit_log (action) VALUES (?)'
      }, '__local');

      await backend.addNode(localFunction);
      await backend.addNode(localAudit);

      await backend.addEdge({ type: 'CALLS', src: localFunction.id, dst: mainDbQuery.id });
      await backend.addEdge({ type: 'CALLS', src: localFunction.id, dst: localAudit.id });

      // Test
      const result = await pathValidator.checkPathEquivalence('processOrder', 'orders.js');

      assert.strictEqual(result.safe, true);
      assert.strictEqual(result.severity, 'warning');
      assert.match(result.message, /new behavior/i);
      assert.ok(result.added);
      assert.strictEqual(result.added.length, 1);
      // The reason message is "New <type> added: <name>"
      assert.match(result.added[0].reason, /new.*(query|endpoint)/i);
    });
  });

  describe('Scenario 4: Function Deleted', () => {
    /**
     * MAIN version:
     *   deleteUser(id) → db.delete
     *
     * LOCAL version:
     *   (function deleted)
     *
     * Result: UNSAFE (function no longer exists)
     */
    it('should fail when function is deleted', async () => {
      await backend.clear();

      // Setup main version
      const mainFunction = versionManager.enrichNodeWithVersion({
        type: 'FUNCTION',
        name: 'deleteUser',
        file: 'users.js',
        params: ['id']
      }, 'main');

      await backend.addNode(mainFunction);

      // NO local version (deleted)

      // Test
      const result = await pathValidator.checkPathEquivalence('deleteUser', 'users.js');

      assert.strictEqual(result.safe, false);
      assert.strictEqual(result.severity, 'error');
      assert.strictEqual(result.deleted, true);
      assert.match(result.message, /function deleted/i);
    });
  });

  describe('Scenario 5: New Function Added', () => {
    /**
     * MAIN version:
     *   (no function)
     *
     * LOCAL version:
     *   updateUser(id, data) → db.update (NEW!)
     *
     * Result: SAFE (new function, nothing to compare)
     */
    it('should pass when new function is added', async () => {
      await backend.clear();

      // NO main version (new function)

      // Setup local version
      const localFunction = versionManager.enrichNodeWithVersion({
        type: 'FUNCTION',
        name: 'updateUser',
        file: 'users.js',
        params: ['id', 'data']
      }, '__local');

      await backend.addNode(localFunction);

      // Test
      const result = await pathValidator.checkPathEquivalence('updateUser', 'users.js');

      assert.strictEqual(result.safe, true);
      assert.strictEqual(result.severity, 'info');
      assert.match(result.message, /new function/i);
    });
  });

  describe('Scenario 6: Module Boundary - Exported Function', () => {
    /**
     * MAIN version:
     *   internalHelper → exportedApi (exported!)
     *
     * LOCAL version:
     *   internalHelper (забыли вызвать exportedApi)
     *
     * Result: UNSAFE (exported function no longer called)
     */
    it('should detect when exported function is no longer called', async () => {
      await backend.clear();

      // Setup main version
      const mainHelper = versionManager.enrichNodeWithVersion({
        type: 'FUNCTION',
        name: 'internalHelper',
        file: 'api.js',
        exported: false
      }, 'main');

      const mainExported = versionManager.enrichNodeWithVersion({
        type: 'FUNCTION',
        name: 'exportedApi',
        file: 'api.js',
        exported: true // MODULE BOUNDARY!
      }, 'main');

      await backend.addNode(mainHelper);
      await backend.addNode(mainExported);
      await backend.addEdge({ type: 'CALLS', src: mainHelper.id, dst: mainExported.id });

      // Setup local version (BROKEN)
      const localHelper = versionManager.enrichNodeWithVersion({
        type: 'FUNCTION',
        name: 'internalHelper',
        file: 'api.js',
        exported: false
      }, '__local');

      await backend.addNode(localHelper);
      // NO edge to exportedApi!

      // Test
      const result = await pathValidator.checkPathEquivalence('internalHelper', 'api.js');

      assert.strictEqual(result.safe, false);
      assert.strictEqual(result.severity, 'error');
      assert.ok(result.missing);
      assert.strictEqual(result.missing[0].type, 'FUNCTION');
      assert.match(result.missing[0].reason, /exported.*no longer called/i);
    });
  });

  describe('Edge Cases', () => {
    it('should handle functions with no endpoints', async () => {
      await backend.clear();

      // Pure function без endpoints
      const mainFunction = versionManager.enrichNodeWithVersion({
        type: 'FUNCTION',
        name: 'pureHelper',
        file: 'utils.js',
        params: []
      }, 'main');

      const localFunction = versionManager.enrichNodeWithVersion({
        type: 'FUNCTION',
        name: 'pureHelper',
        file: 'utils.js',
        params: []
      }, '__local');

      await backend.addNode(mainFunction);
      await backend.addNode(localFunction);

      const result = await pathValidator.checkPathEquivalence('pureHelper', 'utils.js');

      assert.strictEqual(result.safe, true);
      assert.strictEqual(result.endpointsChecked, 0);
    });

    it('should handle deep call chains', async () => {
      await backend.clear();

      // MAIN: a → b → c → db.query
      const mainA = versionManager.enrichNodeWithVersion({ type: 'FUNCTION', name: 'a', file: 'test.js' }, 'main');
      const mainB = versionManager.enrichNodeWithVersion({ type: 'FUNCTION', name: 'b', file: 'test.js' }, 'main');
      const mainC = versionManager.enrichNodeWithVersion({ type: 'FUNCTION', name: 'c', file: 'test.js' }, 'main');
      const mainDb = versionManager.enrichNodeWithVersion({ type: 'db:query', name: 'query', query: 'SELECT 1' }, 'main');

      await backend.addNode(mainA);
      await backend.addNode(mainB);
      await backend.addNode(mainC);
      await backend.addNode(mainDb);

      await backend.addEdge({ type: 'CALLS', src: mainA.id, dst: mainB.id });
      await backend.addEdge({ type: 'CALLS', src: mainB.id, dst: mainC.id });
      await backend.addEdge({ type: 'CALLS', src: mainC.id, dst: mainDb.id });

      // LOCAL: a → b → c → db.query (same)
      const localA = versionManager.enrichNodeWithVersion({ type: 'FUNCTION', name: 'a', file: 'test.js' }, '__local');

      await backend.addNode(localA);
      await backend.addEdge({ type: 'CALLS', src: localA.id, dst: mainB.id });

      const result = await pathValidator.checkPathEquivalence('a', 'test.js');

      assert.strictEqual(result.safe, true);
      assert.strictEqual(result.endpointsChecked, 1);
    });
  });
});
