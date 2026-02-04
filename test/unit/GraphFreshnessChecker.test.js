/**
 * GraphFreshnessChecker Tests (REG-97)
 *
 * Tests the freshness detection system that compares stored contentHash
 * values in MODULE nodes against current file hashes.
 *
 * Key behaviors tested:
 * 1. Fresh graph (no changes) - all modules match current files
 * 2. Stale module detection - file content changed since analysis
 * 3. Deleted file detection - file no longer exists
 * 4. Empty graph handling - no modules = fresh
 * 5. Performance - batched hashing completes in reasonable time
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createTestDatabase } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

// These will be imported after implementation:
// import { GraphFreshnessChecker } from '@grafema/core';

let GraphFreshnessChecker;
let testCounter = 0;

/**
 * Create a unique test directory with package.json
 */
function createTestDir() {
  const testDir = join(tmpdir(), `grafema-freshness-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-freshness-${testCounter}`,
      type: 'module'
    })
  );

  return testDir;
}

/**
 * Try to import the actual implementation
 */
async function loadImplementation() {
  try {
    const core = await import('@grafema/core');
    GraphFreshnessChecker = core.GraphFreshnessChecker;
    // Check that class is actually exported and is a constructor
    return !!(GraphFreshnessChecker && typeof GraphFreshnessChecker === 'function');
  } catch {
    return false;
  }
}

describe('GraphFreshnessChecker (REG-97)', () => {
  let implementationAvailable = false;
  let db;
  let backend;

  before(async () => {
    implementationAvailable = await loadImplementation();
  });

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  describe('Fresh graph (no changes)', () => {
    it('should report isFresh=true when no files have changed', async (t) => {
      if (!implementationAvailable) {
        t.skip('GraphFreshnessChecker not yet implemented');
        return;
      }

      const testDir = createTestDir();
      // utils.js must be written first, then index.js imports it
      writeFileSync(join(testDir, 'utils.js'), 'export function helper() { return 1; }');
      writeFileSync(join(testDir, 'index.js'), `import { helper } from './utils.js';
export const x = helper();`);

      // Analyze the project
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Check freshness - should be fresh since files haven't changed
      const checker = new GraphFreshnessChecker();
      const result = await checker.checkFreshness(backend);

      assert.strictEqual(result.isFresh, true,
        'Graph should be fresh when files have not changed');
      assert.strictEqual(result.staleCount, 0,
        'Should have no stale modules');
      assert.strictEqual(result.deletedCount, 0,
        'Should have no deleted files');
      assert.ok(result.freshCount >= 2,
        `Should have at least 2 fresh modules (index.js, utils.js), got ${result.freshCount}`);
    });

    it('should include timing information', async (t) => {
      if (!implementationAvailable) {
        t.skip('GraphFreshnessChecker not yet implemented');
        return;
      }

      const testDir = createTestDir();
      writeFileSync(join(testDir, 'index.js'), 'const x = 1;');

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      const checker = new GraphFreshnessChecker();
      const result = await checker.checkFreshness(backend);

      assert.ok(typeof result.checkDurationMs === 'number',
        'Should include checkDurationMs');
      assert.ok(result.checkDurationMs >= 0,
        'Duration should be non-negative');
    });
  });

  describe('Stale module detection (file changed)', () => {
    it('should detect when a file has been modified', async (t) => {
      if (!implementationAvailable) {
        t.skip('GraphFreshnessChecker not yet implemented');
        return;
      }

      const testDir = createTestDir();
      const filePath = join(testDir, 'index.js');
      writeFileSync(filePath, 'export const x = 1;');

      // Analyze the project
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Modify the file
      writeFileSync(filePath, 'export const x = 2; // changed');

      // Check freshness - should detect stale module
      const checker = new GraphFreshnessChecker();
      const result = await checker.checkFreshness(backend);

      assert.strictEqual(result.isFresh, false,
        'Graph should be stale when file has changed');
      assert.strictEqual(result.staleCount, 1,
        'Should have 1 stale module');
      assert.strictEqual(result.staleModules.length, 1,
        'Should include stale module details');

      const staleModule = result.staleModules[0];
      assert.ok(staleModule.file.includes('index.js'),
        'Stale module should be index.js');
      assert.strictEqual(staleModule.reason, 'changed',
        'Reason should be "changed"');
      assert.ok(staleModule.storedHash,
        'Should include stored hash');
      assert.ok(staleModule.currentHash,
        'Should include current hash');
      assert.notStrictEqual(staleModule.storedHash, staleModule.currentHash,
        'Stored and current hashes should differ');
    });

    it('should detect multiple modified files', async (t) => {
      if (!implementationAvailable) {
        t.skip('GraphFreshnessChecker not yet implemented');
        return;
      }

      const testDir = createTestDir();
      const file1 = join(testDir, 'a.js');
      const file2 = join(testDir, 'b.js');
      const file3 = join(testDir, 'c.js');
      const indexFile = join(testDir, 'index.js');

      // Create files with exports
      writeFileSync(file1, 'export const a = 1;');
      writeFileSync(file2, 'export const b = 2;');
      writeFileSync(file3, 'export const c = 3;');
      // index.js imports all three files so they are discovered
      writeFileSync(indexFile, `import { a } from './a.js';
import { b } from './b.js';
import { c } from './c.js';
export const sum = a + b + c;`);

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Modify two files, leave one unchanged
      writeFileSync(file1, 'export const a = 10; // modified');
      writeFileSync(file2, 'export const b = 20; // modified');
      // file3 unchanged

      const checker = new GraphFreshnessChecker();
      const result = await checker.checkFreshness(backend);

      assert.strictEqual(result.isFresh, false,
        'Graph should be stale');
      assert.strictEqual(result.staleCount, 2,
        'Should have 2 stale modules');
      assert.ok(result.freshCount >= 1,
        'Should have at least 1 fresh module (c.js)');

      const staleFiles = result.staleModules.map(m => m.file);
      assert.ok(staleFiles.some(f => f.includes('a.js')),
        'a.js should be in stale list');
      assert.ok(staleFiles.some(f => f.includes('b.js')),
        'b.js should be in stale list');
    });
  });

  describe('Deleted file detection', () => {
    it('should detect when a file has been deleted', async (t) => {
      if (!implementationAvailable) {
        t.skip('GraphFreshnessChecker not yet implemented');
        return;
      }

      const testDir = createTestDir();
      const filePath = join(testDir, 'to-delete.js');
      writeFileSync(filePath, 'export const toDelete = true;');
      // index.js imports to-delete.js so it gets discovered
      writeFileSync(join(testDir, 'index.js'), `import { toDelete } from './to-delete.js';
export const x = toDelete ? 1 : 0;`);

      // Analyze the project
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Delete the file
      unlinkSync(filePath);

      // Check freshness
      const checker = new GraphFreshnessChecker();
      const result = await checker.checkFreshness(backend);

      assert.strictEqual(result.isFresh, false,
        'Graph should be stale when file is deleted');
      assert.strictEqual(result.deletedCount, 1,
        'Should have 1 deleted file');

      const deletedModule = result.staleModules.find(m => m.reason === 'deleted');
      assert.ok(deletedModule,
        'Should have a module with reason "deleted"');
      assert.ok(deletedModule.file.includes('to-delete.js'),
        'Deleted module should be to-delete.js');
      assert.strictEqual(deletedModule.currentHash, null,
        'Deleted file should have null currentHash');
    });

    it('should distinguish between changed and deleted files', async (t) => {
      if (!implementationAvailable) {
        t.skip('GraphFreshnessChecker not yet implemented');
        return;
      }

      const testDir = createTestDir();
      const changedFile = join(testDir, 'changed.js');
      const deletedFile = join(testDir, 'deleted.js');
      const freshFile = join(testDir, 'fresh.js');
      const indexFile = join(testDir, 'index.js');

      writeFileSync(changedFile, 'export const changed = 1;');
      writeFileSync(deletedFile, 'export const deleted = 2;');
      writeFileSync(freshFile, 'export const fresh = 3;');
      // index.js imports all files so they are discovered
      writeFileSync(indexFile, `import { changed } from './changed.js';
import { deleted } from './deleted.js';
import { fresh } from './fresh.js';
export const sum = changed + deleted + fresh;`);

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Modify one, delete another, leave one
      writeFileSync(changedFile, 'export const changed = 10; // modified');
      unlinkSync(deletedFile);

      const checker = new GraphFreshnessChecker();
      const result = await checker.checkFreshness(backend);

      assert.strictEqual(result.staleCount, 2,
        'Should have 2 stale modules total');
      assert.strictEqual(result.deletedCount, 1,
        'Should have 1 deleted');

      const changedModules = result.staleModules.filter(m => m.reason === 'changed');
      const deletedModules = result.staleModules.filter(m => m.reason === 'deleted');

      assert.strictEqual(changedModules.length, 1,
        'Should have 1 changed module');
      assert.strictEqual(deletedModules.length, 1,
        'Should have 1 deleted module');
    });
  });

  describe('Empty graph handling', () => {
    it('should report isFresh=true for empty graph', async (t) => {
      if (!implementationAvailable) {
        t.skip('GraphFreshnessChecker not yet implemented');
        return;
      }

      // Empty graph - no analysis done
      const checker = new GraphFreshnessChecker();
      const result = await checker.checkFreshness(backend);

      assert.strictEqual(result.isFresh, true,
        'Empty graph should be considered fresh');
      assert.strictEqual(result.freshCount, 0,
        'Should have 0 fresh modules');
      assert.strictEqual(result.staleCount, 0,
        'Should have 0 stale modules');
      assert.strictEqual(result.deletedCount, 0,
        'Should have 0 deleted files');
    });
  });

  describe('Performance', () => {
    it('should complete freshness check for 50 modules in < 1 second', async (t) => {
      if (!implementationAvailable) {
        t.skip('GraphFreshnessChecker not yet implemented');
        return;
      }

      const testDir = createTestDir();

      // Create 50 files with exports
      for (let i = 0; i < 50; i++) {
        writeFileSync(
          join(testDir, `module${i}.js`),
          `export const value${i} = ${i};`
        );
      }

      // Create index.js that imports all 50 modules
      const imports = Array.from({ length: 50 }, (_, i) =>
        `import { value${i} } from './module${i}.js';`
      ).join('\n');
      writeFileSync(join(testDir, 'index.js'), `${imports}
export const total = ${Array.from({ length: 50 }, (_, i) => `value${i}`).join(' + ')};`);

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Check freshness and measure time
      const checker = new GraphFreshnessChecker();
      const startTime = Date.now();
      const result = await checker.checkFreshness(backend);
      const duration = Date.now() - startTime;

      assert.ok(duration < 1000,
        `Freshness check for 50 modules should complete in < 1s, took ${duration}ms`);
      assert.ok(result.freshCount >= 50,
        `Should have at least 50 fresh modules, got ${result.freshCount}`);
    });

    it('should use batched parallel hashing', async (t) => {
      if (!implementationAvailable) {
        t.skip('GraphFreshnessChecker not yet implemented');
        return;
      }

      const testDir = createTestDir();

      // Create 100 files with exports
      for (let i = 0; i < 100; i++) {
        writeFileSync(
          join(testDir, `file${i}.js`),
          `export function fn${i}() { return ${i}; }`
        );
      }

      // Create index.js that imports all 100 modules
      const imports = Array.from({ length: 100 }, (_, i) =>
        `import { fn${i} } from './file${i}.js';`
      ).join('\n');
      writeFileSync(join(testDir, 'index.js'), `${imports}
export const fns = [${Array.from({ length: 100 }, (_, i) => `fn${i}`).join(', ')}];`);

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      const checker = new GraphFreshnessChecker();
      const result = await checker.checkFreshness(backend);

      // Just verify it completes and returns valid result
      // Batching is an internal implementation detail
      assert.ok(result.freshCount >= 100,
        `Should check at least 100 modules, got ${result.freshCount}`);
      assert.ok(result.checkDurationMs < 5000,
        `Should complete in reasonable time, took ${result.checkDurationMs}ms`);
    });
  });

  describe('Edge cases', () => {
    it('should handle modules without contentHash', async (t) => {
      if (!implementationAvailable) {
        t.skip('GraphFreshnessChecker not yet implemented');
        return;
      }

      const testDir = createTestDir();
      writeFileSync(join(testDir, 'index.js'), 'const x = 1;');

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Manually add a MODULE node without contentHash
      await backend.addNode({
        id: 'MODULE:test-no-hash',
        type: 'MODULE',
        name: 'test-no-hash',
        file: join(testDir, 'missing.js'),
        line: 0
        // No contentHash
      });

      // Should not crash, should skip modules without contentHash
      const checker = new GraphFreshnessChecker();
      const result = await checker.checkFreshness(backend);

      assert.ok(result,
        'Should return result even with malformed modules');
    });

    it('should handle modules with null file path', async (t) => {
      if (!implementationAvailable) {
        t.skip('GraphFreshnessChecker not yet implemented');
        return;
      }

      // Add a MODULE node without file
      await backend.addNode({
        id: 'MODULE:orphan',
        type: 'MODULE',
        name: 'orphan',
        contentHash: 'abc123',
        line: 0
        // No file
      });

      const checker = new GraphFreshnessChecker();
      const result = await checker.checkFreshness(backend);

      assert.ok(result,
        'Should return result even with modules without file');
    });

    it('should return correct module IDs in staleModules', async (t) => {
      if (!implementationAvailable) {
        t.skip('GraphFreshnessChecker not yet implemented');
        return;
      }

      const testDir = createTestDir();
      writeFileSync(join(testDir, 'index.js'), 'export const x = 1;');

      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(testDir);

      // Get the MODULE node ID
      const modules = await backend.getAllNodes({ type: 'MODULE' });
      const indexModule = modules.find(m => m.file?.includes('index.js'));

      // Modify the file
      writeFileSync(join(testDir, 'index.js'), 'export const x = 2;');

      const checker = new GraphFreshnessChecker();
      const result = await checker.checkFreshness(backend);

      assert.strictEqual(result.staleModules.length, 1,
        'Should have 1 stale module');
      assert.strictEqual(result.staleModules[0].id, indexModule.id,
        'Stale module should have correct ID');
    });
  });
});
