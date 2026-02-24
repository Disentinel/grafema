/**
 * Class Field Arrow Deduplication Tests (REG-562)
 *
 * Bug: `class A { field = x => x }` produces TWO FUNCTION nodes instead of one.
 * ClassVisitor.ClassProperty creates a FUNCTION node named 'field', and
 * FunctionVisitor.ArrowFunctionExpression creates a second anonymous FUNCTION node
 * for the same arrow expression.
 *
 * Fix: FunctionVisitor.ArrowFunctionExpression adds a guard to skip class field
 * arrows (ClassProperty/ClassPrivateProperty parent), deferring to ClassVisitor
 * which is authoritative for class members.
 *
 * These tests verify:
 * 1. Basic class field arrow produces exactly 1 FUNCTION node
 * 2. Class field with multiple params produces exactly 1 FUNCTION node
 * 3. Multiple class fields produce exactly 1 FUNCTION node each
 * 4. Static class field produces exactly 1 FUNCTION node
 * 5. Private class field produces exactly 1 FUNCTION node
 * 6. Nested arrow inside class field body produces 2 FUNCTION nodes (outer + inner)
 * 7. Class field arrow alongside class method — no extra FUNCTION from FunctionVisitor
 * 8. Class expression (not declaration) produces exactly 1 FUNCTION node
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * These tests will FAIL before the fix is applied.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-classfield-dedup-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-classfield-dedup-${testCounter}`,
      type: 'module'
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

describe('Class Field Arrow Deduplication (REG-562)', () => {
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

  // ==========================================================================
  // Test 1: Basic class field arrow
  // ==========================================================================
  it('should produce exactly 1 FUNCTION node for basic class field arrow', async () => {
    await setupTest(backend, {
      'index.js': `
class A {
  field = x => x;
}
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');

    // ClassVisitor should create exactly 1 FUNCTION node named 'field'
    const namedField = allFunctions.filter(n => n.name === 'field');
    assert.strictEqual(
      namedField.length,
      1,
      `ClassVisitor should create exactly 1 FUNCTION node named 'field', ` +
      `got ${namedField.length}`
    );

    // Total FUNCTION count must be exactly 1 (no duplicate from FunctionVisitor)
    assert.strictEqual(
      allFunctions.length,
      1,
      `Expected exactly 1 FUNCTION node for class field arrow, ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });

  // ==========================================================================
  // Test 2: Class field with multiple params
  // ==========================================================================
  it('should produce exactly 1 FUNCTION node for class field arrow with multiple params', async () => {
    await setupTest(backend, {
      'index.js': `
class A {
  handler = (e, ctx) => this.handle(e, ctx);
}
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');

    const namedHandler = allFunctions.filter(n => n.name === 'handler');
    assert.strictEqual(
      namedHandler.length,
      1,
      `ClassVisitor should create exactly 1 FUNCTION node named 'handler'`
    );

    assert.strictEqual(
      allFunctions.length,
      1,
      `Expected exactly 1 FUNCTION node for multi-param class field arrow, ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });

  // ==========================================================================
  // Test 3: Multiple class fields
  // ==========================================================================
  it('should produce exactly 2 FUNCTION nodes for two class field arrows', async () => {
    await setupTest(backend, {
      'index.js': `
class A {
  f1 = x => x;
  f2 = y => y;
}
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');

    const f1 = allFunctions.filter(n => n.name === 'f1');
    const f2 = allFunctions.filter(n => n.name === 'f2');

    assert.strictEqual(f1.length, 1, 'Should have exactly 1 FUNCTION node for f1');
    assert.strictEqual(f2.length, 1, 'Should have exactly 1 FUNCTION node for f2');

    // Total: exactly 2 FUNCTION nodes — one per field, no duplicates
    assert.strictEqual(
      allFunctions.length,
      2,
      `Expected exactly 2 FUNCTION nodes (one per class field), ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });

  // ==========================================================================
  // Test 4: Static class field
  // ==========================================================================
  it('should produce exactly 1 FUNCTION node for static class field arrow', async () => {
    await setupTest(backend, {
      'index.js': `
class A {
  static field = x => x;
}
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');

    const namedField = allFunctions.filter(n => n.name === 'field');
    assert.strictEqual(
      namedField.length,
      1,
      `ClassVisitor should create exactly 1 FUNCTION node named 'field' (static)`
    );

    assert.strictEqual(
      allFunctions.length,
      1,
      `Expected exactly 1 FUNCTION node for static class field arrow, ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });

  // ==========================================================================
  // Test 5: Private class field (ClassPrivateProperty in Babel)
  // ==========================================================================
  it('should produce exactly 1 FUNCTION node for private class field arrow', async () => {
    await setupTest(backend, {
      'index.js': `
class A {
  #privateField = x => x;
}
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');

    // ClassVisitor names private fields with # prefix: '#privateField'
    const namedPrivate = allFunctions.filter(n => n.name === '#privateField');
    assert.strictEqual(
      namedPrivate.length,
      1,
      `ClassVisitor should create exactly 1 FUNCTION node named '#privateField', ` +
      `got ${namedPrivate.length}. All functions: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );

    assert.strictEqual(
      allFunctions.length,
      1,
      `Expected exactly 1 FUNCTION node for private class field arrow, ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });

  // ==========================================================================
  // Test 6: Nested arrow inside class field body
  // ==========================================================================
  it('should produce exactly 2 FUNCTION nodes for class field arrow with nested inner arrow', async () => {
    await setupTest(backend, {
      'index.js': `
class A {
  field = () => {
    const inner = x => x;
    return inner;
  };
}
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');

    // ClassVisitor creates FUNCTION 'field' for the outer arrow
    const namedField = allFunctions.filter(n => n.name === 'field');
    assert.strictEqual(
      namedField.length,
      1,
      `ClassVisitor should create exactly 1 FUNCTION node named 'field' (outer arrow)`
    );

    // NestedFunctionHandler (via analyzeFunctionBody) creates FUNCTION for inner arrow
    // Total = 2: outer 'field' + inner arrow
    assert.strictEqual(
      allFunctions.length,
      2,
      `Expected exactly 2 FUNCTION nodes (outer class field + inner nested arrow), ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });

  // ==========================================================================
  // Test 7: Class field arrow alongside class method
  // ==========================================================================
  it('should produce correct FUNCTION nodes for class with both method and field arrow', async () => {
    await setupTest(backend, {
      'index.js': `
class A {
  method() {}
  field = x => x;
}
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');

    // ClassVisitor creates 'method' and 'field'
    const methodFunc = allFunctions.filter(n => n.name === 'method');
    const fieldFunc = allFunctions.filter(n => n.name === 'field');

    assert.strictEqual(methodFunc.length, 1, 'Should have exactly 1 FUNCTION node for method');
    assert.strictEqual(fieldFunc.length, 1, 'Should have exactly 1 FUNCTION node for field');

    // Total: exactly 2 FUNCTION nodes — one method + one field, no FunctionVisitor duplicate
    assert.strictEqual(
      allFunctions.length,
      2,
      `Expected exactly 2 FUNCTION nodes (method + field), ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });

  // ==========================================================================
  // Test 8: Class expression (not declaration)
  // ==========================================================================
  it('should produce exactly 1 FUNCTION node for class expression field arrow', async () => {
    await setupTest(backend, {
      'index.js': `
const A = class {
  field = x => x;
};
`
    });

    const allNodes = await backend.getAllNodes();
    const allFunctions = allNodes.filter(n => n.type === 'FUNCTION');

    const namedField = allFunctions.filter(n => n.name === 'field');
    assert.strictEqual(
      namedField.length,
      1,
      `ClassVisitor should create exactly 1 FUNCTION node named 'field' in class expression`
    );

    assert.strictEqual(
      allFunctions.length,
      1,
      `Expected exactly 1 FUNCTION node for class expression field arrow, ` +
      `got ${allFunctions.length}: ${allFunctions.map(n => `${n.name}:${n.id}`).join(', ')}`
    );
  });
});
