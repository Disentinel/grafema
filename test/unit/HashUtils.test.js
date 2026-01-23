/**
 * HashUtils Tests (REG-97)
 *
 * Tests the unified hash computation utilities:
 * - calculateContentHash(): consistent hashing, different input = different hash
 * - calculateFileHash(): file exists, file doesn't exist
 * - calculateFileHashAsync(): same behavior as sync version
 *
 * HashUtils consolidates 6 duplicate hash implementations across the codebase
 * into a single source of truth.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// These will be imported after implementation:
// import { calculateContentHash, calculateFileHash, calculateFileHashAsync } from '@grafema/core';

// Temporary stubs for TDD - tests written before implementation
let calculateContentHash;
let calculateFileHash;
let calculateFileHashAsync;

let testDir;
let testCounter = 0;

/**
 * Create a unique test directory
 */
function createTestDir() {
  const dir = join(tmpdir(), `grafema-hash-utils-${Date.now()}-${testCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Try to import the actual implementation
 * If not available, tests will be skipped with clear message
 */
async function loadImplementation() {
  try {
    const core = await import('@grafema/core');
    calculateContentHash = core.calculateContentHash;
    calculateFileHash = core.calculateFileHash;
    calculateFileHashAsync = core.calculateFileHashAsync;
    // Check that all functions are actually exported
    return !!(calculateContentHash && calculateFileHash && calculateFileHashAsync);
  } catch {
    return false;
  }
}

describe('HashUtils (REG-97)', () => {
  let implementationAvailable = false;

  before(async () => {
    implementationAvailable = await loadImplementation();
    testDir = createTestDir();
  });

  after(() => {
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('calculateContentHash()', () => {
    it('should return consistent hash for same content', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      const content = 'function hello() { return "world"; }';
      const hash1 = calculateContentHash(content);
      const hash2 = calculateContentHash(content);

      assert.strictEqual(hash1, hash2,
        'Same content should always produce the same hash');
    });

    it('should return different hash for different content', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      const content1 = 'function hello() { return "world"; }';
      const content2 = 'function hello() { return "universe"; }';
      const hash1 = calculateContentHash(content1);
      const hash2 = calculateContentHash(content2);

      assert.notStrictEqual(hash1, hash2,
        'Different content should produce different hashes');
    });

    it('should return a 64-character hex string (SHA-256)', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      const content = 'test content';
      const hash = calculateContentHash(content);

      assert.strictEqual(hash.length, 64,
        'SHA-256 hash should be 64 hex characters');
      assert.match(hash, /^[a-f0-9]+$/,
        'Hash should contain only hex characters');
    });

    it('should handle empty string', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      const hash = calculateContentHash('');
      assert.ok(hash, 'Should return hash for empty string');
      assert.strictEqual(hash.length, 64,
        'Empty string hash should still be 64 characters');
    });

    it('should handle unicode content', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      const content = 'const greeting = "Hello, World! \u{1F44B}";';
      const hash = calculateContentHash(content);

      assert.strictEqual(hash.length, 64,
        'Unicode content hash should be 64 characters');
    });

    it('should handle multiline content', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      const content = `
        function multiline() {
          const a = 1;
          const b = 2;
          return a + b;
        }
      `;
      const hash = calculateContentHash(content);

      assert.strictEqual(hash.length, 64,
        'Multiline content hash should be 64 characters');
    });
  });

  describe('calculateFileHash()', () => {
    it('should return hash for existing file', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      const filePath = join(testDir, 'existing-file.js');
      const content = 'export const value = 42;';
      writeFileSync(filePath, content);

      const hash = calculateFileHash(filePath);

      assert.ok(hash, 'Should return hash for existing file');
      assert.strictEqual(hash.length, 64,
        'File hash should be 64 characters');

      // Verify consistency with calculateContentHash
      const contentHash = calculateContentHash(content);
      assert.strictEqual(hash, contentHash,
        'File hash should match content hash');
    });

    it('should return null for non-existing file', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      const filePath = join(testDir, 'non-existing-file.js');
      const hash = calculateFileHash(filePath);

      assert.strictEqual(hash, null,
        'Should return null for non-existing file');
    });

    it('should return null for unreadable file', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      // Try to read a directory as a file - this should fail
      const hash = calculateFileHash(testDir);

      // On some systems reading a directory might throw, on others return null
      // Either way, should not crash and should return null
      assert.strictEqual(hash, null,
        'Should return null for unreadable path');
    });

    it('should handle empty file', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      const filePath = join(testDir, 'empty-file.js');
      writeFileSync(filePath, '');

      const hash = calculateFileHash(filePath);

      assert.ok(hash, 'Should return hash for empty file');
      assert.strictEqual(hash.length, 64,
        'Empty file hash should be 64 characters');
    });
  });

  describe('calculateFileHashAsync()', () => {
    it('should return same hash as sync version', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      const filePath = join(testDir, 'async-test.js');
      const content = 'const asyncTest = true;';
      writeFileSync(filePath, content);

      const syncHash = calculateFileHash(filePath);
      const asyncHash = await calculateFileHashAsync(filePath);

      assert.strictEqual(asyncHash, syncHash,
        'Async hash should match sync hash');
    });

    it('should return null for non-existing file', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      const filePath = join(testDir, 'non-existing-async.js');
      const hash = await calculateFileHashAsync(filePath);

      assert.strictEqual(hash, null,
        'Should return null for non-existing file');
    });

    it('should handle concurrent reads of same file', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      const filePath = join(testDir, 'concurrent-test.js');
      const content = 'export function concurrent() { return true; }';
      writeFileSync(filePath, content);

      // Read the same file 10 times concurrently
      const promises = Array(10).fill(null).map(() =>
        calculateFileHashAsync(filePath)
      );
      const hashes = await Promise.all(promises);

      // All hashes should be identical
      const uniqueHashes = new Set(hashes);
      assert.strictEqual(uniqueHashes.size, 1,
        'Concurrent reads should return identical hashes');
    });

    it('should handle concurrent reads of different files', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      // Create multiple files
      const files = [];
      for (let i = 0; i < 5; i++) {
        const filePath = join(testDir, `batch-file-${i}.js`);
        const content = `export const value${i} = ${i};`;
        writeFileSync(filePath, content);
        files.push({ path: filePath, content });
      }

      // Read all files concurrently
      const promises = files.map(f => calculateFileHashAsync(f.path));
      const hashes = await Promise.all(promises);

      // All hashes should be unique (different content)
      const uniqueHashes = new Set(hashes);
      assert.strictEqual(uniqueHashes.size, files.length,
        'Different files should have different hashes');

      // Verify each hash matches its content
      for (let i = 0; i < files.length; i++) {
        const expectedHash = calculateContentHash(files[i].content);
        assert.strictEqual(hashes[i], expectedHash,
          `File ${i} hash should match its content hash`);
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle file with special characters in name', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      const filePath = join(testDir, 'file with spaces.js');
      writeFileSync(filePath, 'const x = 1;');

      const hash = calculateFileHash(filePath);
      assert.ok(hash, 'Should hash file with spaces in name');

      const asyncHash = await calculateFileHashAsync(filePath);
      assert.ok(asyncHash, 'Should async hash file with spaces in name');
    });

    it('should handle very large content', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      // Create 1MB of content
      const largeContent = 'x'.repeat(1024 * 1024);
      const hash = calculateContentHash(largeContent);

      assert.strictEqual(hash.length, 64,
        'Large content hash should be 64 characters');
    });

    it('should detect whitespace-only changes', async (t) => {
      if (!implementationAvailable) {
        t.skip('HashUtils not yet implemented');
        return;
      }

      const content1 = 'const x = 1;';
      const content2 = 'const x = 1; ';  // trailing space
      const content3 = 'const x = 1;\n'; // trailing newline

      const hash1 = calculateContentHash(content1);
      const hash2 = calculateContentHash(content2);
      const hash3 = calculateContentHash(content3);

      assert.notStrictEqual(hash1, hash2,
        'Trailing space should change hash');
      assert.notStrictEqual(hash1, hash3,
        'Trailing newline should change hash');
      assert.notStrictEqual(hash2, hash3,
        'Space vs newline should be different');
    });
  });
});
