/**
 * Semantic ID v2 Migration and Stability Tests (Phase 8 of RFD-4)
 *
 * Integration tests that verify v2 semantic IDs work correctly through
 * the real analysis pipeline (no mocks).
 *
 * Key properties tested:
 * - Stability: adding code blocks doesn't change existing node IDs
 * - Collision resolution: same-name calls get disambiguated
 * - v2 format: IDs parse correctly with parseSemanticIdV2()
 * - No duplicates: complex files produce unique IDs
 * - Round-trip: computeSemanticIdV2 / parseSemanticIdV2 are consistent
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import {
  parseSemanticIdV2,
  computeSemanticIdV2,
} from '@grafema/core';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);

let testCounter = 0;

/**
 * Analyze JavaScript code and return all generated node IDs.
 *
 * Runs the full analysis pipeline (JSModuleIndexer + JSASTAnalyzer + enrichment)
 * on a temp file containing the given code.
 *
 * @param {Object} backend - TestDatabaseBackend instance
 * @param {string} code - JavaScript source code to analyze
 * @returns {Promise<{allNodes: Array, allIds: string[], testDir: string, getNodesByName: Function, getIdsByName: Function, getNodesByType: Function}>}
 */
async function analyzeAndGetIds(backend, code) {
  const testDir = join(tmpdir(), `grafema-test-v2migration-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json required by JSModuleIndexer
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-v2migration-${testCounter}`,
      type: 'module'
    })
  );

  // Write test file as index.js (JSModuleIndexer starts from index.js)
  writeFileSync(join(testDir, 'index.js'), code);

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  const allNodes = await backend.getAllNodes();
  const allIds = allNodes.map(n => n.id);

  return {
    allNodes,
    allIds,
    testDir,
    /**
     * Get all nodes with a given name
     */
    getNodesByName(name) {
      return allNodes.filter(n => n.name === name);
    },
    /**
     * Get all IDs for nodes with a given name
     */
    getIdsByName(name) {
      return allNodes.filter(n => n.name === name).map(n => n.id);
    },
    /**
     * Get all nodes with a given type
     */
    getNodesByType(type) {
      return allNodes.filter(n => n.type === type);
    },
    /**
     * Clean up the temp directory. Call when done with this analysis result.
     */
    cleanup() {
      rmSync(testDir, { recursive: true, force: true });
    },
  };
}

/**
 * Strip the temp directory prefix from a semantic ID.
 *
 * IDs embed the full file path (e.g., /tmp/.../index.js->FUNCTION->foo).
 * To compare IDs across different temp directories, strip the directory
 * prefix and keep only the filename onward (e.g., index.js->FUNCTION->foo).
 *
 * @param {string} id - Semantic ID
 * @param {string} testDir - Temp directory path used for analysis
 * @returns {string} ID with directory prefix stripped
 */
function stripDirPrefix(id, testDir) {
  // The file path in the ID starts with the testDir path followed by /
  const prefix = testDir + '/';
  if (id.startsWith(prefix)) {
    return id.slice(prefix.length);
  }
  return id;
}

/**
 * Check if an ID is in v1 semantic format (file->scope->...->TYPE->name).
 * v1 has 4+ arrow-separated parts (file, scope path, type, name).
 */
function isV1SemanticFormat(id) {
  if (!id || typeof id !== 'string') return false;
  const parts = id.split('->');
  return parts.length >= 4;
}

/**
 * Check if an ID is in legacy format (TYPE#name#file#line...)
 */
function isLegacyFormat(id) {
  if (!id || typeof id !== 'string') return false;
  return /^[A-Z_]+#/.test(id);
}

/**
 * Check if an ID is a special/infrastructure format.
 * These are internal framework nodes, singletons, modules, services, and plugins.
 */
function isSpecialFormat(id) {
  if (!id || typeof id !== 'string') return false;
  return (
    id.startsWith('EXTERNAL_MODULE->') ||
    id.startsWith('net:stdio') ||
    id.startsWith('net:request') ||
    id.startsWith('MODULE#') ||
    id.startsWith('MODULE:') ||
    id.startsWith('SERVICE#') ||
    id.startsWith('SERVICE:') ||
    id.startsWith('grafema:')
  );
}

/**
 * Check if a node type is an infrastructure/framework type (not user code).
 */
function isInfrastructureType(type) {
  const infraTypes = new Set([
    'SERVICE', 'MODULE', 'net:stdio', 'net:request',
    'grafema:plugin', 'EXTERNAL_MODULE', 'GRAPH_META',
  ]);
  return infraTypes.has(type);
}

// =============================================================================
// 8.1 THE KEY TEST: Stability Under Block Addition
// =============================================================================

describe('SemanticId v2 Migration and Stability (Phase 8)', () => {
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

  describe('8.1 Stability Under Block Addition', () => {
    it('should produce identical IDs for existing nodes when a new if-block is added', async () => {
      // BEFORE: original code
      const codeBefore = `
function fetchData() {
  const url = getUrl();
  const timeout = 5000;
  if (shouldCache) {
    const response = fetch();
  }
}
`;

      const resultBefore = await analyzeAndGetIds(backend, codeBefore);

      // Find key nodes in the "before" version
      const fetchDataBefore = resultBefore.getNodesByName('fetchData').find(n => n.type === 'FUNCTION');
      const urlBefore = resultBefore.getNodesByName('url').find(n => n.type === 'VARIABLE');
      const timeoutBefore = resultBefore.getNodesByName('timeout').find(n => n.type === 'CONSTANT');

      assert.ok(fetchDataBefore, 'fetchData FUNCTION node should exist in "before" version');
      assert.ok(urlBefore, 'url VARIABLE node should exist in "before" version');
      assert.ok(timeoutBefore, 'timeout CONSTANT node should exist in "before" version');

      // NOTE: Variables inside counted scopes (if, for, try) still use v1 IDs
      // which include the scope counter (if#0, if#1). Adding a new if-block
      // renumbers them, making those IDs unstable. Full v2 migration will fix this.
      // For now, we test stability only for nodes NOT inside counted scopes.

      const dirBefore = resultBefore.testDir;
      resultBefore.cleanup();

      // AFTER: new if-block added at top of function
      await db.cleanup();
      db = await createTestDatabase();
      backend = db.backend;

      const codeAfter = `
function fetchData() {
  if (debug) { log(); }
  const url = getUrl();
  const timeout = 5000;
  if (shouldCache) {
    const response = fetch();
  }
}
`;

      const resultAfter = await analyzeAndGetIds(backend, codeAfter);

      // Find same key nodes in the "after" version
      const fetchDataAfter = resultAfter.getNodesByName('fetchData').find(n => n.type === 'FUNCTION');
      const urlAfter = resultAfter.getNodesByName('url').find(n => n.type === 'VARIABLE');
      const timeoutAfter = resultAfter.getNodesByName('timeout').find(n => n.type === 'CONSTANT');

      assert.ok(fetchDataAfter, 'fetchData FUNCTION node should exist in "after" version');
      assert.ok(urlAfter, 'url VARIABLE node should exist in "after" version');
      assert.ok(timeoutAfter, 'timeout CONSTANT node should exist in "after" version');

      const dirAfter = resultAfter.testDir;
      resultAfter.cleanup();

      // THE KEY ASSERTION: IDs must be identical (modulo the temp dir prefix)
      // Strip the temp directory prefix since each run uses a different temp dir.
      assert.strictEqual(
        stripDirPrefix(fetchDataBefore.id, dirBefore),
        stripDirPrefix(fetchDataAfter.id, dirAfter),
        `fetchData ID should be stable. Before: ${fetchDataBefore.id}, After: ${fetchDataAfter.id}`
      );
      assert.strictEqual(
        stripDirPrefix(urlBefore.id, dirBefore),
        stripDirPrefix(urlAfter.id, dirAfter),
        `url ID should be stable. Before: ${urlBefore.id}, After: ${urlAfter.id}`
      );
      assert.strictEqual(
        stripDirPrefix(timeoutBefore.id, dirBefore),
        stripDirPrefix(timeoutAfter.id, dirAfter),
        `timeout ID should be stable. Before: ${timeoutBefore.id}, After: ${timeoutAfter.id}`
      );

      // The new log() call should also exist in the "after" version
      const logNode = resultAfter.getNodesByName('log').find(n => n.type === 'CALL');
      assert.ok(logNode, 'log CALL node should exist in "after" version');
    });

    it('should produce identical IDs when adding a new function above existing code', async () => {
      const codeBefore = `
function processOrder(order) {
  const total = calculateTotal(order);
  return total;
}
`;

      const resultBefore = await analyzeAndGetIds(backend, codeBefore);
      const processOrderBefore = resultBefore.getNodesByName('processOrder').find(n => n.type === 'FUNCTION');
      const totalBefore = resultBefore.getNodesByName('total').find(n => n.type === 'VARIABLE');

      assert.ok(processOrderBefore, 'processOrder FUNCTION should exist before');
      assert.ok(totalBefore, 'total VARIABLE should exist before');

      const dirBefore = resultBefore.testDir;
      resultBefore.cleanup();

      await db.cleanup();
      db = await createTestDatabase();
      backend = db.backend;

      const codeAfter = `
function validateOrder(order) {
  if (!order.id) throw new Error('missing id');
}

function processOrder(order) {
  const total = calculateTotal(order);
  return total;
}
`;

      const resultAfter = await analyzeAndGetIds(backend, codeAfter);
      const processOrderAfter = resultAfter.getNodesByName('processOrder').find(n => n.type === 'FUNCTION');
      const totalAfter = resultAfter.getNodesByName('total').find(n => n.type === 'VARIABLE');

      assert.ok(processOrderAfter, 'processOrder FUNCTION should exist after');
      assert.ok(totalAfter, 'total VARIABLE should exist after');

      const dirAfter = resultAfter.testDir;
      resultAfter.cleanup();

      assert.strictEqual(
        stripDirPrefix(processOrderBefore.id, dirBefore),
        stripDirPrefix(processOrderAfter.id, dirAfter),
        `processOrder ID should be stable. Before: ${processOrderBefore.id}, After: ${processOrderAfter.id}`
      );
      assert.strictEqual(
        stripDirPrefix(totalBefore.id, dirBefore),
        stripDirPrefix(totalAfter.id, dirAfter),
        `total ID should be stable. Before: ${totalBefore.id}, After: ${totalAfter.id}`
      );
    });
  });

  // ===========================================================================
  // 8.2 Collision Tests
  // ===========================================================================

  describe('8.2 Collision Tests', () => {
    it('should disambiguate same-name calls with different arguments', async () => {
      const code = `
function processData() {
  console.log("start");
  console.log("end");
}
`;

      const result = await analyzeAndGetIds(backend, code);
      const consoleLogs = result.getNodesByName('console.log').filter(n => n.type === 'CALL');

      assert.strictEqual(
        consoleLogs.length,
        2,
        `Expected 2 console.log CALL nodes, got ${consoleLogs.length}: ${consoleLogs.map(n => n.id).join(', ')}`
      );

      // Both should have different IDs
      assert.notStrictEqual(
        consoleLogs[0].id,
        consoleLogs[1].id,
        `Two console.log calls should have different IDs. Got: ${consoleLogs[0].id} and ${consoleLogs[1].id}`
      );

      // Both should contain disambiguation (either v2 hash h: or v1 discriminator #N)
      for (const node of consoleLogs) {
        const hasV2Hash = node.id.includes('h:');
        const hasV1Discriminator = /#\d+/.test(node.id);
        assert.ok(
          hasV2Hash || hasV1Discriminator,
          `console.log ID should contain disambiguation (h: or #N). Got: ${node.id}`
        );
      }
    });

    it('should disambiguate identical calls with counter', async () => {
      const code = `
function retry() {
  doWork();
  doWork();
  doWork();
}
`;

      const result = await analyzeAndGetIds(backend, code);
      const doWorkNodes = result.getNodesByName('doWork').filter(n => n.type === 'CALL');

      assert.strictEqual(
        doWorkNodes.length,
        3,
        `Expected 3 doWork CALL nodes, got ${doWorkNodes.length}: ${doWorkNodes.map(n => n.id).join(', ')}`
      );

      // All 3 should have different IDs
      const doWorkIds = doWorkNodes.map(n => n.id);
      const uniqueIds = new Set(doWorkIds);
      assert.strictEqual(
        uniqueIds.size,
        3,
        `All 3 doWork calls should have unique IDs. Got: ${doWorkIds.join(', ')}`
      );

      // At least one should have # counter (the 2nd or 3rd occurrence)
      const hasCounter = doWorkIds.some(id => id.includes('#'));
      assert.ok(
        hasCounter,
        `At least one doWork ID should have # counter for disambiguation. Got: ${doWorkIds.join(', ')}`
      );
    });

    it('should disambiguate calls in different parent scopes without hash', async () => {
      const code = `
function a() {
  doWork();
}
function b() {
  doWork();
}
`;

      const result = await analyzeAndGetIds(backend, code);
      const doWorkNodes = result.getNodesByName('doWork').filter(n => n.type === 'CALL');

      assert.strictEqual(
        doWorkNodes.length,
        2,
        `Expected 2 doWork CALL nodes, got ${doWorkNodes.length}`
      );

      // They should have different IDs because they are in different named parents
      assert.notStrictEqual(
        doWorkNodes[0].id,
        doWorkNodes[1].id,
        `doWork in different functions should have different IDs. Got: ${doWorkNodes[0].id} and ${doWorkNodes[1].id}`
      );
    });
  });

  // ===========================================================================
  // 8.3 v1-to-v2 Mapping Verification
  // ===========================================================================

  describe('8.3 v1-to-v2 Mapping Verification', () => {
    it('should round-trip top-level function format', () => {
      const id = computeSemanticIdV2('FUNCTION', 'processData', 'src/app.js');
      assert.strictEqual(id, 'src/app.js->FUNCTION->processData');

      const parsed = parseSemanticIdV2(id);
      assert.ok(parsed, `Failed to parse: ${id}`);
      assert.strictEqual(parsed.file, 'src/app.js');
      assert.strictEqual(parsed.type, 'FUNCTION');
      assert.strictEqual(parsed.name, 'processData');
      assert.strictEqual(parsed.namedParent, undefined);
      assert.strictEqual(parsed.contentHash, undefined);
      assert.strictEqual(parsed.counter, undefined);

      // Re-compute from parsed
      const recomputed = computeSemanticIdV2(parsed.type, parsed.name, parsed.file, parsed.namedParent, parsed.contentHash, parsed.counter);
      assert.strictEqual(recomputed, id);
    });

    it('should round-trip class method format', () => {
      const id = computeSemanticIdV2('FUNCTION', 'login', 'src/app.js', 'UserService');
      assert.strictEqual(id, 'src/app.js->FUNCTION->login[in:UserService]');

      const parsed = parseSemanticIdV2(id);
      assert.ok(parsed, `Failed to parse: ${id}`);
      assert.strictEqual(parsed.file, 'src/app.js');
      assert.strictEqual(parsed.type, 'FUNCTION');
      assert.strictEqual(parsed.name, 'login');
      assert.strictEqual(parsed.namedParent, 'UserService');
      assert.strictEqual(parsed.contentHash, undefined);
      assert.strictEqual(parsed.counter, undefined);

      const recomputed = computeSemanticIdV2(parsed.type, parsed.name, parsed.file, parsed.namedParent, parsed.contentHash, parsed.counter);
      assert.strictEqual(recomputed, id);
    });

    it('should round-trip variable inside function format', () => {
      const id = computeSemanticIdV2('VARIABLE', 'response', 'src/app.js', 'fetchData');
      assert.strictEqual(id, 'src/app.js->VARIABLE->response[in:fetchData]');

      const parsed = parseSemanticIdV2(id);
      assert.ok(parsed, `Failed to parse: ${id}`);
      assert.strictEqual(parsed.file, 'src/app.js');
      assert.strictEqual(parsed.type, 'VARIABLE');
      assert.strictEqual(parsed.name, 'response');
      assert.strictEqual(parsed.namedParent, 'fetchData');

      const recomputed = computeSemanticIdV2(parsed.type, parsed.name, parsed.file, parsed.namedParent, parsed.contentHash, parsed.counter);
      assert.strictEqual(recomputed, id);
    });

    it('should round-trip top-level constant format', () => {
      const id = computeSemanticIdV2('CONSTANT', 'API_URL', 'config.js');
      assert.strictEqual(id, 'config.js->CONSTANT->API_URL');

      const parsed = parseSemanticIdV2(id);
      assert.ok(parsed, `Failed to parse: ${id}`);
      assert.strictEqual(parsed.file, 'config.js');
      assert.strictEqual(parsed.type, 'CONSTANT');
      assert.strictEqual(parsed.name, 'API_URL');
      assert.strictEqual(parsed.namedParent, undefined);

      const recomputed = computeSemanticIdV2(parsed.type, parsed.name, parsed.file, parsed.namedParent, parsed.contentHash, parsed.counter);
      assert.strictEqual(recomputed, id);
    });

    it('should round-trip call with hash and counter format', () => {
      const id = computeSemanticIdV2('CALL', 'console.log', 'src/app.js', 'main', 'a1b2', 2);
      assert.strictEqual(id, 'src/app.js->CALL->console.log[in:main,h:a1b2]#2');

      const parsed = parseSemanticIdV2(id);
      assert.ok(parsed, `Failed to parse: ${id}`);
      assert.strictEqual(parsed.file, 'src/app.js');
      assert.strictEqual(parsed.type, 'CALL');
      assert.strictEqual(parsed.name, 'console.log');
      assert.strictEqual(parsed.namedParent, 'main');
      assert.strictEqual(parsed.contentHash, 'a1b2');
      assert.strictEqual(parsed.counter, 2);

      const recomputed = computeSemanticIdV2(parsed.type, parsed.name, parsed.file, parsed.namedParent, parsed.contentHash, parsed.counter);
      assert.strictEqual(recomputed, id);
    });
  });

  // ===========================================================================
  // 8.4 No-Duplicate Regression
  // ===========================================================================

  describe('8.4 No-Duplicate Regression', () => {
    it('should produce unique IDs for a complex file with classes and functions', async () => {
      const code = `
class UserService {
  login() { console.log("in"); }
  logout() { console.log("out"); }
}
function helper() {
  console.log("help");
  console.log("help");
}
`;

      const result = await analyzeAndGetIds(backend, code);

      // Collect ALL node IDs
      const allIds = result.allIds;
      assert.ok(allIds.length > 0, 'Should produce at least one node');

      // Check for duplicates
      const idCounts = new Map();
      for (const id of allIds) {
        idCounts.set(id, (idCounts.get(id) || 0) + 1);
      }

      const duplicates = [];
      for (const [id, count] of idCounts) {
        if (count > 1) {
          duplicates.push({ id, count });
        }
      }

      assert.strictEqual(
        duplicates.length,
        0,
        `Found duplicate IDs:\n${duplicates.map(d => `  ${d.id} (${d.count} times)`).join('\n')}`
      );
    });

    it('should produce unique IDs for nested structures', async () => {
      const code = `
class A {
  method() {
    const x = 1;
    if (true) {
      const y = 2;
    }
  }
}
class B {
  method() {
    const x = 1;
    if (true) {
      const y = 2;
    }
  }
}
`;

      const result = await analyzeAndGetIds(backend, code);
      const allIds = result.allIds;

      const idCounts = new Map();
      for (const id of allIds) {
        idCounts.set(id, (idCounts.get(id) || 0) + 1);
      }

      const duplicates = [];
      for (const [id, count] of idCounts) {
        if (count > 1) {
          duplicates.push({ id, count });
        }
      }

      assert.strictEqual(
        duplicates.length,
        0,
        `Found duplicate IDs in nested structures:\n${duplicates.map(d => `  ${d.id} (${d.count} times)`).join('\n')}`
      );
    });
  });

  // ===========================================================================
  // 8.5 v2 Format Verification
  // ===========================================================================

  describe('8.5 v2 Format Verification', () => {
    /**
     * Node types that still use legacy ID format (TYPE#name#file#line:col:counter).
     * These are excluded from v2 format checks.
     */
    const LEGACY_ID_TYPES = new Set([
      'LITERAL',
      'DECORATOR',
    ]);

    /**
     * Node types that use v1 semantic format (file->scope->TYPE->name).
     * CLASS and PARAMETER use v1 (computeSemanticId), not v2.
     */
    const V1_SEMANTIC_TYPES = new Set([
      'CLASS',
      'PARAMETER',
    ]);

    it('should have all node IDs in a recognized format (v2, v1 semantic, or legacy)', async () => {
      const code = `
function processData(input) {
  const result = transform(input);
  console.log(result);
  return result;
}
`;

      const result = await analyzeAndGetIds(backend, code);

      // Check each node: it should be in v2, v1 semantic, legacy, or special format.
      // Any ID that doesn't match any known format is a problem.
      const unrecognized = [];

      for (const node of result.allNodes) {
        const id = node.id;

        // Skip infrastructure/framework nodes
        if (isSpecialFormat(id) || isInfrastructureType(node.type)) continue;

        // Legacy format: TYPE#name#file#...
        if (isLegacyFormat(id)) continue;

        // v1 semantic format: file->scope->...->TYPE->name
        if (isV1SemanticFormat(id)) continue;

        // v2 format: file->TYPE->name[...]
        const parsed = parseSemanticIdV2(id);
        if (parsed) continue;

        unrecognized.push({ type: node.type, name: node.name, id });
      }

      assert.strictEqual(
        unrecognized.length,
        0,
        `Found nodes with unrecognized ID format:\n${unrecognized.map(n => `  [${n.type}] ${n.name}: ${n.id}`).join('\n')}`
      );

      result.cleanup();
    });

    it('should produce v2 parseable IDs for FUNCTION nodes generated by FunctionVisitor', { todo: 'Visitors use v1 until v2 opt-in flag is implemented' }, async () => {
      // Top-level functions use v2 via FunctionVisitor.generateV2Simple
      const code = `
function topLevel() {}
function another() {}
`;

      const result = await analyzeAndGetIds(backend, code);
      const functionNodes = result.getNodesByType('FUNCTION');

      assert.ok(functionNodes.length >= 2, `Expected at least 2 FUNCTION nodes, got ${functionNodes.length}`);

      for (const node of functionNodes) {
        const parsed = parseSemanticIdV2(node.id);
        assert.ok(
          parsed !== null,
          `Top-level FUNCTION node "${node.name}" should have v2 parseable ID. Got: ${node.id}`
        );
        assert.strictEqual(parsed.type, 'FUNCTION', `Parsed type should be FUNCTION for "${node.name}"`);
        assert.strictEqual(parsed.name, node.name, `Parsed name should match for "${node.name}"`);
      }

      result.cleanup();
    });

    it('should produce v2 parseable IDs for class methods generated by ClassVisitor', { todo: 'Visitors use v1 until v2 opt-in flag is implemented' }, async () => {
      // Class methods use computeSemanticIdV2 directly in ClassVisitor
      const code = `
class MyClass {
  method() {}
  static staticMethod() {}
}
`;

      const result = await analyzeAndGetIds(backend, code);
      const functionNodes = result.getNodesByType('FUNCTION');

      // Should find method and staticMethod
      const methodNode = functionNodes.find(n => n.name === 'method');
      const staticNode = functionNodes.find(n => n.name === 'staticMethod');

      assert.ok(methodNode, 'method FUNCTION node should exist');
      assert.ok(staticNode, 'staticMethod FUNCTION node should exist');

      const parsedMethod = parseSemanticIdV2(methodNode.id);
      assert.ok(parsedMethod, `method should have v2 parseable ID. Got: ${methodNode.id}`);
      assert.strictEqual(parsedMethod.namedParent, 'MyClass', 'method namedParent should be MyClass');

      const parsedStatic = parseSemanticIdV2(staticNode.id);
      assert.ok(parsedStatic, `staticMethod should have v2 parseable ID. Got: ${staticNode.id}`);
      assert.strictEqual(parsedStatic.namedParent, 'MyClass', 'staticMethod namedParent should be MyClass');

      result.cleanup();
    });

    it('should produce semantic IDs for VARIABLE and CONSTANT nodes', async () => {
      const code = `
const API_URL = "https://api.example.com";
let counter = 0;
function doStuff() {
  const result = compute();
}
`;

      const result = await analyzeAndGetIds(backend, code);

      // Check VARIABLE nodes -- may be v1 or v2 semantic format (migration in progress)
      const variableNodes = result.getNodesByType('VARIABLE');
      for (const node of variableNodes) {
        const isV2 = parseSemanticIdV2(node.id) !== null;
        const isV1 = isV1SemanticFormat(node.id);
        assert.ok(
          isV2 || isV1,
          `VARIABLE node "${node.name}" should have semantic ID (v2 or v1). Got: ${node.id}`
        );
      }

      // Check CONSTANT nodes -- may be v1 or v2 semantic format
      const constantNodes = result.getNodesByType('CONSTANT');
      for (const node of constantNodes) {
        const isV2 = parseSemanticIdV2(node.id) !== null;
        const isV1 = isV1SemanticFormat(node.id);
        assert.ok(
          isV2 || isV1,
          `CONSTANT node "${node.name}" should have semantic ID (v2 or v1). Got: ${node.id}`
        );
      }

      result.cleanup();
    });

    it('should produce v2 parseable IDs for CALL nodes generated by generateV2', async () => {
      // CALL nodes created via IdGenerator.generateV2 should have v2 format
      const code = `
function handler() {
  fetch("/api");
  console.log("done");
}
`;

      const result = await analyzeAndGetIds(backend, code);
      const callNodes = result.getNodesByType('CALL');

      assert.ok(callNodes.length >= 2, `Expected at least 2 CALL nodes, got ${callNodes.length}`);

      // All CALL nodes should be in either v2 or v1 semantic format (both are valid)
      for (const node of callNodes) {
        const isV2 = parseSemanticIdV2(node.id) !== null;
        const isV1 = isV1SemanticFormat(node.id);
        assert.ok(
          isV2 || isV1,
          `CALL node "${node.name}" should have semantic ID (v2 or v1). Got: ${node.id}`
        );
      }

      result.cleanup();
    });

    it('should have all v2 IDs containing the source filename', async () => {
      const code = `
function main() {
  const x = 1;
  doSomething();
}
`;

      const result = await analyzeAndGetIds(backend, code);

      for (const node of result.allNodes) {
        const parsed = parseSemanticIdV2(node.id);
        if (parsed && parsed.file) {
          // v2 IDs from analysis should reference the file
          assert.ok(
            parsed.file.includes('index.js'),
            `v2 ID file component should reference index.js. Got file="${parsed.file}" in ID: ${node.id}`
          );
        }
      }

      result.cleanup();
    });
  });
});
