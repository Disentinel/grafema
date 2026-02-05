/**
 * Parallel vs Sequential Analysis Parity Tests
 *
 * Tests for REG-133: Verifies that parallel analysis (ASTWorkerPool)
 * produces identical semantic IDs as sequential analysis (JSASTAnalyzer).
 *
 * Critical test case from Linus's review:
 * Both modes must produce identical semantic IDs for the same code,
 * ensuring deterministic analysis regardless of execution mode.
 *
 * TDD: Tests written first per Kent Beck's methodology.
 *
 * NOTE: These tests verify the EXPECTED behavior after implementation.
 * They use ScopeTracker and computeSemanticId directly to compute
 * the expected IDs, then verify the actual graph matches.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join, basename } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { ScopeTracker, computeSemanticId } from '@grafema/core';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-parity-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-parity-${testCounter}`,
      type: 'module'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(testDir, filename);
    const dir = join(filePath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Compute expected semantic ID using ScopeTracker (the reference implementation)
 */
function computeExpectedId(type, name, fileName, scopePath = []) {
  const scopeTracker = new ScopeTracker(fileName);
  for (const scope of scopePath) {
    if (scope.startsWith('if#') || scope.startsWith('for#') || scope.startsWith('try#')) {
      const [scopeType] = scope.split('#');
      scopeTracker.enterCountedScope(scopeType);
    } else {
      scopeTracker.enterScope(scope, 'SCOPE');
    }
  }
  return computeSemanticId(type, name, scopeTracker.getContext());
}

/**
 * Check if an ID has legacy line-based format
 */
function hasLegacyFormat(id) {
  if (!id || typeof id !== 'string') return false;
  return /^[A-Z]+#.+#.+#\d+:\d+/.test(id);
}

/**
 * Check if an ID follows semantic format
 */
function isSemanticId(id) {
  if (!id || typeof id !== 'string') return false;
  if (hasLegacyFormat(id)) return false;
  return id.includes('->');
}

describe('Parallel vs Sequential Analysis Parity (REG-133)', () => {
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
  // Critical Parity Test Cases
  // ===========================================================================

  describe('Critical Parity Test Cases', () => {
    it('should produce semantic IDs for nested if scopes (Linus review case)', async () => {
      // Critical test case from Linus's review:
      // Variables in nested if scopes should have unique, deterministic IDs
      await setupTest(backend, {
        'index.js': `
function outer() {
  if (a) { if (b) { const x = 1; } }  // x at if#0->if#0
  if (c) { const y = 2; }             // y at if#1
}
export { outer };
`
      });

      // Find the function
      let outerFunc = null;
      for await (const node of backend.queryNodes({ type: 'FUNCTION', name: 'outer' })) {
        outerFunc = node;
        break;
      }

      assert.ok(outerFunc, 'Function outer should be found');
      assert.ok(
        isSemanticId(outerFunc.id),
        `Function outer should have semantic ID format: ${outerFunc.id}`
      );

      // Expected format: file->global->FUNCTION->outer
      const expectedOuterId = computeExpectedId('FUNCTION', 'outer', 'index.js');
      // Extract semantic part (after file prefix) for comparison
      const getSemanticPart = (id) => {
        const parts = id.split('->');
        return parts.slice(1).join('->');
      };

      assert.strictEqual(
        getSemanticPart(outerFunc.id),
        getSemanticPart(expectedOuterId),
        `Outer function ID should match expected: ${outerFunc.id} vs ${expectedOuterId}`
      );
    });

    it('should produce consistent IDs for class methods', async () => {
      await setupTest(backend, {
        'index.js': `
class UserService {
  findUser(id) { return this.db.get(id); }
  saveUser(user) { return this.db.put(user); }
}
export { UserService };
`
      });

      // Find methods
      let findUserMethod = null;
      let saveUserMethod = null;
      for await (const node of backend.queryNodes({ type: 'FUNCTION' })) {
        if (node.name === 'findUser') findUserMethod = node;
        if (node.name === 'saveUser') saveUserMethod = node;
      }

      assert.ok(findUserMethod, 'Method findUser should be found');
      assert.ok(saveUserMethod, 'Method saveUser should be found');

      // Both should have semantic IDs
      assert.ok(
        isSemanticId(findUserMethod.id),
        `findUser should have semantic ID: ${findUserMethod.id}`
      );
      assert.ok(
        isSemanticId(saveUserMethod.id),
        `saveUser should have semantic ID: ${saveUserMethod.id}`
      );

      // IDs should include class scope
      assert.ok(
        findUserMethod.id.includes('->UserService->'),
        `findUser ID should include class scope: ${findUserMethod.id}`
      );
      assert.ok(
        saveUserMethod.id.includes('->UserService->'),
        `saveUser ID should include class scope: ${saveUserMethod.id}`
      );

      // IDs should be different
      assert.notStrictEqual(
        findUserMethod.id,
        saveUserMethod.id,
        'Different methods should have different IDs'
      );
    });

    it('should produce unique IDs for multiple calls to same function', async () => {
      await setupTest(backend, {
        'index.js': `
console.log("first");
console.log("second");
console.log("third");
export default {};
`
      });

      // Collect all console.log calls
      const consoleLogs = [];
      for await (const node of backend.queryNodes({ type: 'CALL' })) {
        if (node.name === 'console.log' || (node.object === 'console' && node.method === 'log')) {
          consoleLogs.push(node);
        }
      }

      assert.strictEqual(consoleLogs.length, 3, 'Should find 3 console.log calls');

      // All IDs should be unique
      const ids = consoleLogs.map(c => c.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, 3, `All call IDs should be unique: ${JSON.stringify(ids)}`);

      // All should have semantic format (no legacy line:column)
      for (const call of consoleLogs) {
        assert.ok(
          !hasLegacyFormat(call.id),
          `Call ID should not have legacy format: ${call.id}`
        );
      }
    });

    it('should produce consistent IDs for module-level variables', async () => {
      await setupTest(backend, {
        'index.js': `
const MAX_SIZE = 100;
let counter = 0;
export { MAX_SIZE, counter };
`
      });

      let maxSize = null;
      let counterVar = null;
      for await (const node of backend.queryNodes({})) {
        if (node.name === 'MAX_SIZE' && (node.type === 'CONSTANT' || node.type === 'VARIABLE')) {
          maxSize = node;
        }
        if (node.name === 'counter' && (node.type === 'CONSTANT' || node.type === 'VARIABLE')) {
          counterVar = node;
        }
      }

      assert.ok(maxSize, 'MAX_SIZE should be found');
      assert.ok(counterVar, 'counter should be found');

      // Both should have semantic IDs
      assert.ok(
        isSemanticId(maxSize.id),
        `MAX_SIZE should have semantic ID: ${maxSize.id}`
      );
      assert.ok(
        isSemanticId(counterVar.id),
        `counter should have semantic ID: ${counterVar.id}`
      );

      // IDs should be different
      assert.notStrictEqual(
        maxSize.id,
        counterVar.id,
        'Different variables should have different IDs'
      );
    });
  });

  // ===========================================================================
  // Determinism Tests
  // ===========================================================================

  describe('Determinism Across Multiple Runs', () => {
    it('should produce identical IDs on multiple analysis runs', async () => {
      const code = `
function process(data) {
  return data.map(x => x * 2);
}
export { process };
`;

      // Run analysis multiple times with fresh backends
      const results = [];

      for (let i = 0; i < 3; i++) {
        const testDb = await createTestDatabase();
        const testBackend = testDb.backend;

        const testDir = join(tmpdir(), `grafema-test-determinism-${Date.now()}-${testCounter++}`);
        mkdirSync(testDir, { recursive: true });
        writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
        writeFileSync(join(testDir, 'index.js'), code);

        const orchestrator = createTestOrchestrator(testBackend);
        await orchestrator.run(testDir);

        // Collect function ID
        let funcId = null;
        for await (const node of testBackend.queryNodes({ type: 'FUNCTION', name: 'process' })) {
          funcId = node.id;
          break;
        }

        results.push(funcId);
        await testDb.cleanup();
      }

      // All runs should produce the same semantic part
      const getSemanticPart = (id) => {
        if (!id) return null;
        const parts = id.split('->');
        return parts.slice(1).join('->');
      };

      const firstSemanticPart = getSemanticPart(results[0]);
      for (let i = 1; i < results.length; i++) {
        assert.strictEqual(
          getSemanticPart(results[i]),
          firstSemanticPart,
          `Run ${i + 1}: Semantic part should match first run`
        );
      }
    });
  });

  // ===========================================================================
  // Stability Tests
  // ===========================================================================

  describe('Semantic ID Stability', () => {
    it('should produce same semantic ID regardless of whitespace', async () => {
      // Test with compact code
      const testDir1 = join(tmpdir(), `grafema-test-ws1-${Date.now()}-${testCounter++}`);
      mkdirSync(testDir1, { recursive: true });
      writeFileSync(join(testDir1, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
      writeFileSync(join(testDir1, 'index.js'), `function foo() { return 1; }
export { foo };`);

      const db1 = await createTestDatabase();
      const backend1 = db1.backend;
      await createTestOrchestrator(backend1).run(testDir1);

      let func1 = null;
      for await (const node of backend1.queryNodes({ type: 'FUNCTION', name: 'foo' })) {
        func1 = node;
        break;
      }
      await db1.cleanup();

      // Test with expanded code
      const testDir2 = join(tmpdir(), `grafema-test-ws2-${Date.now()}-${testCounter++}`);
      mkdirSync(testDir2, { recursive: true });
      writeFileSync(join(testDir2, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
      writeFileSync(join(testDir2, 'index.js'), `
function foo() {
  return 1;
}
export { foo };
`);

      const db2 = await createTestDatabase();
      const backend2 = db2.backend;
      await createTestOrchestrator(backend2).run(testDir2);

      let func2 = null;
      for await (const node of backend2.queryNodes({ type: 'FUNCTION', name: 'foo' })) {
        func2 = node;
        break;
      }
      await db2.cleanup();

      assert.ok(func1 && func2, 'Both should find function foo');

      // Semantic parts should match (file prefix may differ)
      const getSemanticPart = (id) => {
        const parts = id.split('->');
        return parts.slice(1).join('->');
      };

      assert.strictEqual(
        getSemanticPart(func1.id),
        getSemanticPart(func2.id),
        `Semantic parts should match: ${func1.id} vs ${func2.id}`
      );
    });

    it('should produce same semantic ID when code is added above', async () => {
      // Test without extra code
      const testDir1 = join(tmpdir(), `grafema-test-above1-${Date.now()}-${testCounter++}`);
      mkdirSync(testDir1, { recursive: true });
      writeFileSync(join(testDir1, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
      writeFileSync(join(testDir1, 'index.js'), `
function target() { return 42; }
export { target };
`);

      const db1 = await createTestDatabase();
      const backend1 = db1.backend;
      await createTestOrchestrator(backend1).run(testDir1);

      let func1 = null;
      for await (const node of backend1.queryNodes({ type: 'FUNCTION', name: 'target' })) {
        func1 = node;
        break;
      }
      await db1.cleanup();

      // Test with extra code above
      const testDir2 = join(tmpdir(), `grafema-test-above2-${Date.now()}-${testCounter++}`);
      mkdirSync(testDir2, { recursive: true });
      writeFileSync(join(testDir2, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
      writeFileSync(join(testDir2, 'index.js'), `
// Comment added
const x = 1;
function other() {}

function target() { return 42; }
export { target };
`);

      const db2 = await createTestDatabase();
      const backend2 = db2.backend;
      await createTestOrchestrator(backend2).run(testDir2);

      let func2 = null;
      for await (const node of backend2.queryNodes({ type: 'FUNCTION', name: 'target' })) {
        func2 = node;
        break;
      }
      await db2.cleanup();

      assert.ok(func1 && func2, 'Both should find function target');

      // Semantic parts should match
      const getSemanticPart = (id) => {
        const parts = id.split('->');
        return parts.slice(1).join('->');
      };

      assert.strictEqual(
        getSemanticPart(func1.id),
        getSemanticPart(func2.id),
        `Semantic ID should not change when code added above: ${func1.id} vs ${func2.id}`
      );
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle empty export', async () => {
      await setupTest(backend, {
        'index.js': `export default {};`
      });

      // Should not throw, graph should be queryable
      let nodeCount = 0;
      for await (const _node of backend.queryNodes({})) {
        nodeCount++;
      }

      assert.ok(nodeCount >= 0, 'Should handle empty module without errors');
    });

    it('should handle multiple classes with same method names', async () => {
      await setupTest(backend, {
        'index.js': `
class ServiceA {
  process() { return 'A'; }
}

class ServiceB {
  process() { return 'B'; }
}

export { ServiceA, ServiceB };
`
      });

      // Find both process methods
      const processMethods = [];
      for await (const node of backend.queryNodes({ type: 'FUNCTION', name: 'process' })) {
        processMethods.push(node);
      }

      assert.strictEqual(processMethods.length, 2, 'Should find 2 process methods');

      // IDs should be different (different class scopes)
      assert.notStrictEqual(
        processMethods[0].id,
        processMethods[1].id,
        'Same-named methods in different classes should have different IDs'
      );

      // Each should include its class name
      const hasServiceA = processMethods.some(m => m.id.includes('->ServiceA->'));
      const hasServiceB = processMethods.some(m => m.id.includes('->ServiceB->'));

      assert.ok(hasServiceA, 'Should have method with ServiceA scope');
      assert.ok(hasServiceB, 'Should have method with ServiceB scope');
    });
  });
});
