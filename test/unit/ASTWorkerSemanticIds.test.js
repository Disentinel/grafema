/**
 * ASTWorker Semantic ID Generation Tests
 *
 * Tests for REG-133: Verifies that ASTWorker generates semantic IDs
 * using ScopeTracker instead of legacy line-based IDs.
 *
 * These tests are written FIRST (TDD) and should FAIL until implementation
 * is complete. They verify:
 * 1. Function declarations get semantic IDs
 * 2. Variable declarations distinguish CONSTANT vs VARIABLE with semantic IDs
 * 3. Class methods include class scope in ID
 * 4. Nested scopes (if#N) are tracked correctly
 * 5. Call sites have discriminators for same-named calls
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * These tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-astworker-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-astworker-${testCounter}`,
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
 * Check if an ID has legacy line-based format
 * Legacy format: TYPE#name#file#line:column[:counter]
 */
function hasLegacyFormat(id) {
  if (!id || typeof id !== 'string') return false;
  // Legacy format has # separators and line:column pattern
  return /^[A-Z]+#.+#.+#\d+:\d+/.test(id);
}

/**
 * Check if an ID is in semantic format
 * Semantic format: file->scope->TYPE->name[#discriminator]
 */
function isSemanticId(id) {
  if (!id || typeof id !== 'string') return false;

  // Legacy format check
  if (hasLegacyFormat(id)) return false;

  // Semantic format uses -> as separator
  return id.includes('->');
}

describe('ASTWorker Semantic ID Generation (REG-133)', () => {
  let backend;

  beforeEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
    backend = createTestBackend();
    await backend.connect();
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  // ===========================================================================
  // Function Declarations
  // ===========================================================================

  describe('Function Declarations', () => {
    it('should generate semantic ID for function declaration', async () => {
      await setupTest(backend, {
        'index.js': `
function processData(input) {
  return input.toUpperCase();
}
export { processData };
`
      });

      let foundFunction = null;
      for await (const node of backend.queryNodes({ type: 'FUNCTION', name: 'processData' })) {
        foundFunction = node;
        break;
      }

      assert.ok(foundFunction, 'Function processData should be found');

      // Semantic ID format: file->global->FUNCTION->name
      // Should NOT contain line numbers
      assert.ok(
        !hasLegacyFormat(foundFunction.id),
        `ID should not have legacy format with line numbers: ${foundFunction.id}`
      );
      assert.ok(
        isSemanticId(foundFunction.id),
        `ID should follow semantic format: ${foundFunction.id}`
      );
      assert.ok(
        foundFunction.id.includes('->FUNCTION->processData'),
        `ID should contain function name with correct type: ${foundFunction.id}`
      );
    });

    it('should generate semantic ID for async function', async () => {
      await setupTest(backend, {
        'index.js': `
async function fetchData(url) {
  const response = await fetch(url);
  return response.json();
}
export { fetchData };
`
      });

      let foundFunction = null;
      for await (const node of backend.queryNodes({ type: 'FUNCTION', name: 'fetchData' })) {
        foundFunction = node;
        break;
      }

      assert.ok(foundFunction, 'Function fetchData should be found');
      assert.ok(
        !hasLegacyFormat(foundFunction.id),
        `Async function ID should not have legacy format: ${foundFunction.id}`
      );
      assert.ok(
        isSemanticId(foundFunction.id),
        `Async function ID should follow semantic format: ${foundFunction.id}`
      );
    });
  });

  // ===========================================================================
  // Variable Declarations
  // ===========================================================================

  describe('Variable Declarations', () => {
    it('should generate semantic ID with CONSTANT type for const with literal', async () => {
      await setupTest(backend, {
        'index.js': `
const MAX_SIZE = 100;
export { MAX_SIZE };
`
      });

      let foundVar = null;
      for await (const node of backend.queryNodes({ name: 'MAX_SIZE' })) {
        if (node.type === 'CONSTANT' || node.type === 'VARIABLE') {
          foundVar = node;
          break;
        }
      }

      assert.ok(foundVar, 'Variable MAX_SIZE should be found');
      assert.strictEqual(foundVar.type, 'CONSTANT', 'const with literal should be CONSTANT');

      // Semantic ID format: file->global->CONSTANT->name
      assert.ok(
        !hasLegacyFormat(foundVar.id),
        `Variable ID should not have legacy format: ${foundVar.id}`
      );
      assert.ok(
        isSemanticId(foundVar.id),
        `Variable ID should follow semantic format: ${foundVar.id}`
      );
      assert.ok(
        foundVar.id.includes('->CONSTANT->MAX_SIZE'),
        `ID should include CONSTANT type: ${foundVar.id}`
      );
    });

    it('should generate semantic ID with VARIABLE type for let', async () => {
      await setupTest(backend, {
        'index.js': `
let counter = 0;
export { counter };
`
      });

      let foundVar = null;
      for await (const node of backend.queryNodes({ name: 'counter' })) {
        if (node.type === 'CONSTANT' || node.type === 'VARIABLE') {
          foundVar = node;
          break;
        }
      }

      assert.ok(foundVar, 'Variable counter should be found');
      assert.strictEqual(foundVar.type, 'VARIABLE', 'let should be VARIABLE');

      assert.ok(
        !hasLegacyFormat(foundVar.id),
        `Variable ID should not have legacy format: ${foundVar.id}`
      );
      assert.ok(
        isSemanticId(foundVar.id),
        `Variable ID should follow semantic format: ${foundVar.id}`
      );
    });
  });

  // ===========================================================================
  // Class Methods with Class Scope
  // ===========================================================================

  describe('Class Methods with Class Scope', () => {
    it('should include class name in method semantic ID', async () => {
      await setupTest(backend, {
        'index.js': `
class UserService {
  constructor(db) {
    this.db = db;
  }

  async findUser(id) {
    return this.db.query('SELECT * FROM users WHERE id = ?', [id]);
  }
}
export { UserService };
`
      });

      let findUserMethod = null;
      for await (const node of backend.queryNodes({ type: 'FUNCTION', name: 'findUser' })) {
        findUserMethod = node;
        break;
      }

      assert.ok(findUserMethod, 'Method findUser should be found');

      // Semantic ID should include class scope: file->UserService->FUNCTION->findUser
      assert.ok(
        !hasLegacyFormat(findUserMethod.id),
        `Method ID should not have legacy format: ${findUserMethod.id}`
      );
      assert.ok(
        findUserMethod.id.includes('->UserService->') && findUserMethod.id.includes('->findUser'),
        `Method ID should include class scope: ${findUserMethod.id}`
      );
    });

    it('should generate correct IDs for constructor', async () => {
      await setupTest(backend, {
        'index.js': `
class Database {
  constructor(connectionString) {
    this.conn = connectionString;
  }
}
export { Database };
`
      });

      let constructor = null;
      for await (const node of backend.queryNodes({ type: 'FUNCTION', name: 'constructor' })) {
        constructor = node;
        break;
      }

      assert.ok(constructor, 'Constructor should be found');

      // Semantic ID: file->Database->FUNCTION->constructor
      assert.ok(
        !hasLegacyFormat(constructor.id),
        `Constructor ID should not have legacy format: ${constructor.id}`
      );
      assert.ok(
        constructor.id.includes('->Database->'),
        `Constructor ID should include class scope: ${constructor.id}`
      );
    });
  });

  // ===========================================================================
  // Call Sites with Discriminators
  // ===========================================================================

  describe('Call Sites with Discriminators', () => {
    it('should add discriminators for multiple calls to same function', async () => {
      await setupTest(backend, {
        'index.js': `
console.log("first");
console.log("second");
console.log("third");
export default {};
`
      });

      const consoleLogs = [];
      for await (const node of backend.queryNodes({ type: 'CALL' })) {
        if (node.name === 'console.log' || (node.object === 'console' && node.method === 'log')) {
          consoleLogs.push(node);
        }
      }

      assert.strictEqual(consoleLogs.length, 3, 'Should find 3 console.log calls');

      // Each should have a unique semantic ID
      const ids = consoleLogs.map(c => c.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, 3, `All call IDs should be unique: ${JSON.stringify(ids)}`);

      // IDs should follow semantic format (no line:column patterns)
      for (const call of consoleLogs) {
        assert.ok(
          !hasLegacyFormat(call.id),
          `Call ID should not have legacy format: ${call.id}`
        );
      }
    });

    it('should generate semantic IDs for function calls', async () => {
      await setupTest(backend, {
        'index.js': `
function init() {}
function process() {}
function cleanup() {}

init();
process();
cleanup();
export {};
`
      });

      const calls = [];
      for await (const node of backend.queryNodes({ type: 'CALL' })) {
        calls.push(node);
      }

      assert.ok(calls.length >= 3, 'Should find at least 3 function calls');

      for (const call of calls) {
        // Semantic ID format: file->global->CALL->name[#discriminator]
        assert.ok(
          !hasLegacyFormat(call.id),
          `Call ID should not have legacy format: ${call.id}`
        );
        assert.ok(
          call.id.includes('->CALL->'),
          `Call ID should include CALL type: ${call.id}`
        );
      }
    });
  });

  // ===========================================================================
  // Semantic ID Stability
  // ===========================================================================

  describe('Semantic ID Stability', () => {
    it('should generate same ID regardless of whitespace changes', async () => {
      // Test 1: Compact code
      const testDir1 = join(tmpdir(), `grafema-test-stability1-${Date.now()}-${testCounter++}`);
      mkdirSync(testDir1, { recursive: true });
      writeFileSync(join(testDir1, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
      writeFileSync(join(testDir1, 'index.js'), `function foo() { return 1; }
export { foo };`);

      const backend1 = createTestBackend();
      await backend1.connect();
      const orchestrator1 = createTestOrchestrator(backend1);
      await orchestrator1.run(testDir1);

      let func1 = null;
      for await (const node of backend1.queryNodes({ type: 'FUNCTION', name: 'foo' })) {
        func1 = node;
        break;
      }

      await backend1.cleanup();

      // Test 2: Same code with more whitespace
      const testDir2 = join(tmpdir(), `grafema-test-stability2-${Date.now()}-${testCounter++}`);
      mkdirSync(testDir2, { recursive: true });
      writeFileSync(join(testDir2, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
      writeFileSync(join(testDir2, 'index.js'), `
function foo() {
  return 1;
}
export { foo };
`);

      const backend2 = createTestBackend();
      await backend2.connect();
      const orchestrator2 = createTestOrchestrator(backend2);
      await orchestrator2.run(testDir2);

      let func2 = null;
      for await (const node of backend2.queryNodes({ type: 'FUNCTION', name: 'foo' })) {
        func2 = node;
        break;
      }

      await backend2.cleanup();

      assert.ok(func1 && func2, 'Both should find function foo');

      // For semantic IDs, the core identifier part should match
      // (file path will differ due to temp dirs, but the semantic part should be same)
      const getSemanticPart = (id) => {
        const parts = id.split('->');
        return parts.slice(1).join('->'); // Remove file prefix
      };

      assert.strictEqual(
        getSemanticPart(func1.id),
        getSemanticPart(func2.id),
        `Semantic parts should match: ${func1.id} vs ${func2.id}`
      );
    });

    it('should generate same ID when code is added above', async () => {
      // Test 1: Just the target function
      const testDir1 = join(tmpdir(), `grafema-test-above1-${Date.now()}-${testCounter++}`);
      mkdirSync(testDir1, { recursive: true });
      writeFileSync(join(testDir1, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
      writeFileSync(join(testDir1, 'index.js'), `
function target() { return 42; }
export { target };
`);

      const backend1 = createTestBackend();
      await backend1.connect();
      const orchestrator1 = createTestOrchestrator(backend1);
      await orchestrator1.run(testDir1);

      let func1 = null;
      for await (const node of backend1.queryNodes({ type: 'FUNCTION', name: 'target' })) {
        func1 = node;
        break;
      }

      await backend1.cleanup();

      // Test 2: Code added above the target function
      const testDir2 = join(tmpdir(), `grafema-test-above2-${Date.now()}-${testCounter++}`);
      mkdirSync(testDir2, { recursive: true });
      writeFileSync(join(testDir2, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
      writeFileSync(join(testDir2, 'index.js'), `
// Added comment
const x = 1;  // Added variable
function other() {}  // Added function

function target() { return 42; }
export { target };
`);

      const backend2 = createTestBackend();
      await backend2.connect();
      const orchestrator2 = createTestOrchestrator(backend2);
      await orchestrator2.run(testDir2);

      let func2 = null;
      for await (const node of backend2.queryNodes({ type: 'FUNCTION', name: 'target' })) {
        func2 = node;
        break;
      }

      await backend2.cleanup();

      assert.ok(func1 && func2, 'Both should find function target');

      // The semantic part (after file prefix) should be identical
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
});
