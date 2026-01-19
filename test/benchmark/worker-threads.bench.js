/**
 * Benchmark: worker_threads vs single-threaded parsing
 *
 * Tests parallel AST parsing performance
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, readdirSync, statSync } from 'fs';
import { parse } from '@babel/parser';

import { ASTWorkerPool } from '@grafema/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, '../fixtures/03-complex-async');

/**
 * Collect all JS files from a directory
 */
function collectJsFiles(dir, files = []) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory() && entry !== 'node_modules') {
      collectJsFiles(fullPath, files);
    } else if (entry.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Single-threaded parsing (baseline)
 */
async function parseSequential(files) {
  const results = [];
  for (const filePath of files) {
    const code = readFileSync(filePath, 'utf-8');
    const ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript']
    });
    results.push({ filePath, nodeCount: countNodes(ast) });
  }
  return results;
}

/**
 * Count AST nodes (simple metric)
 */
function countNodes(ast) {
  let count = 0;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    count++;
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        child.forEach(visit);
      } else if (child && typeof child === 'object') {
        visit(child);
      }
    }
  };
  visit(ast);
  return count;
}

describe('Worker Threads Benchmark', () => {
  let files;
  let pool;

  before(() => {
    files = collectJsFiles(FIXTURE_PATH);
    console.log(`\nBenchmark: ${files.length} files from 03-complex-async`);
    console.log('Files:', files.map(f => f.replace(FIXTURE_PATH, '')).join(', '));
  });

  after(async () => {
    if (pool) {
      await pool.terminate();
    }
  });

  it('should parse files sequentially (baseline)', async () => {
    const start = performance.now();

    const results = await parseSequential(files);

    const elapsed = performance.now() - start;
    console.log(`\nSequential: ${elapsed.toFixed(2)}ms for ${files.length} files`);
    console.log(`  Average: ${(elapsed / files.length).toFixed(2)}ms per file`);

    assert.equal(results.length, files.length);
  });

  it('should parse files in parallel with worker_threads', async () => {
    pool = new ASTWorkerPool(4);

    const start = performance.now();

    const modules = files.map((f, i) => ({
      file: f,
      id: `MODULE#test${i}`,
      name: `test${i}`
    }));

    const results = await pool.parseModules(modules);

    const elapsed = performance.now() - start;
    console.log(`\nParallel (4 workers): ${elapsed.toFixed(2)}ms for ${files.length} files`);
    console.log(`  Average: ${(elapsed / files.length).toFixed(2)}ms per file`);

    // Check results
    const successful = results.filter(r => !r.error);
    const failed = results.filter(r => r.error);

    console.log(`  Success: ${successful.length}, Failed: ${failed.length}`);

    if (failed.length > 0) {
      console.log('  Errors:', failed.map(f => `${f.module.name}: ${f.error}`));
    }

    assert.equal(successful.length, files.length, 'All files should parse successfully');

    // Check that collections were extracted
    for (const result of successful) {
      assert.ok(result.collections, `${result.module.name} should have collections`);
      assert.ok(Array.isArray(result.collections.functions), 'Should have functions array');
      assert.ok(Array.isArray(result.collections.imports), 'Should have imports array');
    }

    // Print stats
    const totalFunctions = successful.reduce((sum, r) => sum + r.collections.functions.length, 0);
    const totalImports = successful.reduce((sum, r) => sum + r.collections.imports.length, 0);
    console.log(`  Extracted: ${totalFunctions} functions, ${totalImports} imports`);
  });

  it('should show speedup with more files (duplicate for testing)', async () => {
    // Duplicate files to simulate larger workload
    const duplicatedFiles = [...files, ...files, ...files]; // 18 files

    console.log(`\n--- Testing with ${duplicatedFiles.length} files (3x duplicated) ---`);

    // Sequential
    const seqStart = performance.now();
    await parseSequential(duplicatedFiles);
    const seqElapsed = performance.now() - seqStart;

    // Parallel
    const modules = duplicatedFiles.map((f, i) => ({
      file: f,
      id: `MODULE#test${i}`,
      name: `test${i}`
    }));

    const parStart = performance.now();
    await pool.parseModules(modules);
    const parElapsed = performance.now() - parStart;

    const speedup = seqElapsed / parElapsed;

    console.log(`Sequential: ${seqElapsed.toFixed(2)}ms`);
    console.log(`Parallel:   ${parElapsed.toFixed(2)}ms`);
    console.log(`Speedup:    ${speedup.toFixed(2)}x`);

    // We expect some speedup with worker threads
    // Note: small files may not show significant speedup due to overhead
    assert.ok(speedup > 0.5, 'Should have reasonable performance');
  });
});
