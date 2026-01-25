/**
 * Test for code with no HTTP requests
 * REG-233: FetchAnalyzer should not create net:request node when no HTTP requests exist
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { TestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { FetchAnalyzer } from '@grafema/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, '../fixtures/08-no-http-requests');

describe('No HTTP Requests Analysis (REG-233)', () => {
  let backend;
  let orchestrator;

  beforeEach(async () => {
    backend = new TestBackend();
    await backend.connect();
    orchestrator = createTestOrchestrator(backend, {
      extraPlugins: [new FetchAnalyzer()]
    });
  });

  afterEach(async () => {
    if (backend) await backend.cleanup();
  });

  it('should not create net:request singleton when no HTTP requests exist', async () => {
    await orchestrator.run(FIXTURE_PATH);

    const allNodes = await backend.getAllNodes();
    const netRequestNodes = allNodes.filter(n => n.type === 'net:request');

    assert.strictEqual(
      netRequestNodes.length,
      0,
      'Should not create net:request node when no HTTP requests found'
    );
  });

  it('should not create http:request nodes for console.log calls', async () => {
    await orchestrator.run(FIXTURE_PATH);

    const allNodes = await backend.getAllNodes();
    const httpRequestNodes = allNodes.filter(n => n.type === 'http:request');

    assert.strictEqual(
      httpRequestNodes.length,
      0,
      'Should not create http:request nodes for console.log calls'
    );
  });

  it('should still analyze modules and functions correctly', async () => {
    await orchestrator.run(FIXTURE_PATH);

    const allNodes = await backend.getAllNodes();

    const modules = allNodes.filter(n => n.type === 'MODULE');
    assert.strictEqual(modules.length, 1, 'Should have 1 module');

    const functions = allNodes.filter(n => n.type === 'FUNCTION');
    const functionNames = functions.map(f => f.name);
    assert.ok(functionNames.includes('hello'), 'Should detect hello function');
    assert.ok(functionNames.includes('greet'), 'Should detect greet function');
  });

  it('should have no EXTERNAL nodes', async () => {
    await orchestrator.run(FIXTURE_PATH);

    const allNodes = await backend.getAllNodes();
    const externalNodes = allNodes.filter(n => n.type === 'EXTERNAL');

    assert.strictEqual(
      externalNodes.length,
      0,
      'Should not create EXTERNAL nodes when no HTTP requests'
    );
  });
});
