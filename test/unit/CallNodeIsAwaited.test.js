/**
 * CALL node isAwaited metadata tests (REG-560)
 *
 * Verifies that CALL nodes have `metadata.isAwaited` correctly set:
 * - true when the call's direct parent AST node is AwaitExpression
 * - false otherwise
 *
 * Edge cases covered:
 * - await foo() → true
 * - foo() → false
 * - await obj.method() → true
 * - await new SomeClass() → true
 * - mixed awaited + non-awaited in same function
 * - async arrow: await bar() → true
 * - chained: await a().then(b) → only outer call isAwaited
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

describe('CALL node isAwaited metadata (REG-560)', () => {
  let db;
  let backend;
  let testDir;
  let testCounter = 0;

  async function setupTest(files) {
    testDir = join(tmpdir(), `grafema-test-awaited-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: `test-awaited-${testCounter}`, type: 'module' })
    );

    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(testDir, filename), content);
    }

    return testDir;
  }

  function cleanupTestDir() {
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      testDir = null;
    }
  }

  beforeEach(async () => {
    if (db) await db.cleanup();
    cleanupTestDir();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
    cleanupTestDir();
  });

  it('await foo() → isAwaited: true', async () => {
    const projectPath = await setupTest({
      'index.js': `
async function main() {
  const data = await fetchData();
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();
    const callNode = allNodes.find(n => n.type === 'CALL' && n.name === 'fetchData');
    assert.ok(callNode, 'CALL node for fetchData should exist');
    assert.strictEqual(callNode.isAwaited, true, 'isAwaited should be true');
  });

  it('foo() → isAwaited: false', async () => {
    const projectPath = await setupTest({
      'index.js': `
function main() {
  const data = fetchData();
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();
    const callNode = allNodes.find(n => n.type === 'CALL' && n.name === 'fetchData');
    assert.ok(callNode, 'CALL node for fetchData should exist');
    assert.strictEqual(callNode.isAwaited, false, 'isAwaited should be false');
  });

  it('await obj.method() → isAwaited: true', async () => {
    const projectPath = await setupTest({
      'index.js': `
async function main() {
  const db = {};
  await db.connect();
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();
    const callNode = allNodes.find(n => n.type === 'CALL' && (n.name === 'db.connect' || n.name === 'connect'));
    assert.ok(callNode, 'CALL node for db.connect should exist');
    assert.strictEqual(callNode.isAwaited, true, 'isAwaited should be true for awaited method call');
  });

  it('await new SomeClass() → isAwaited: true', async () => {
    const projectPath = await setupTest({
      'index.js': `
async function main() {
  const instance = await new SomeClass();
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();
    const callNode = allNodes.find(n => n.type === 'CALL' && n.name === 'new SomeClass');
    assert.ok(callNode, 'CALL node for new SomeClass should exist');
    assert.strictEqual(callNode.isAwaited, true, 'isAwaited should be true for awaited new expression');
  });

  it('mixed: awaited + non-awaited in same function', async () => {
    const projectPath = await setupTest({
      'index.js': `
async function main() {
  const config = await loadConfig();
  const sync = fetchSync();
  const db = await connectDB();
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();

    const loadConfigCall = allNodes.find(n => n.type === 'CALL' && n.name === 'loadConfig');
    assert.ok(loadConfigCall, 'CALL node for loadConfig should exist');
    assert.strictEqual(loadConfigCall.isAwaited, true, 'loadConfig isAwaited should be true');

    const fetchSyncCall = allNodes.find(n => n.type === 'CALL' && n.name === 'fetchSync');
    assert.ok(fetchSyncCall, 'CALL node for fetchSync should exist');
    assert.strictEqual(fetchSyncCall.isAwaited, false, 'fetchSync isAwaited should be false');

    const connectDBCall = allNodes.find(n => n.type === 'CALL' && n.name === 'connectDB');
    assert.ok(connectDBCall, 'CALL node for connectDB should exist');
    assert.strictEqual(connectDBCall.isAwaited, true, 'connectDB isAwaited should be true');
  });

  it('async arrow function: await bar() → isAwaited: true', async () => {
    const projectPath = await setupTest({
      'index.js': `
const fn = async () => {
  await bar();
};
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();
    const callNode = allNodes.find(n => n.type === 'CALL' && n.name === 'bar');
    assert.ok(callNode, 'CALL node for bar should exist');
    assert.strictEqual(callNode.isAwaited, true, 'isAwaited should be true inside async arrow');
  });

  it('chained: await a().then(b) → only outer then() isAwaited', async () => {
    const projectPath = await setupTest({
      'index.js': `
async function main() {
  await fetchData().then(process);
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();

    // fetchData() is the inner call — parent is MemberExpression (.then), NOT AwaitExpression
    const fetchDataCall = allNodes.find(n => n.type === 'CALL' && n.name === 'fetchData');
    assert.ok(fetchDataCall, 'CALL node for fetchData should exist');
    assert.strictEqual(fetchDataCall.isAwaited, false, 'inner fetchData isAwaited should be false');

    // .then() is the outer call — parent IS AwaitExpression
    const thenCall = allNodes.find(n => n.type === 'CALL' && n.name?.includes('then'));
    assert.ok(thenCall, 'CALL node for .then should exist');
    assert.strictEqual(thenCall.isAwaited, true, 'outer then() isAwaited should be true');
  });

  it('for await (const x of gen()) → gen() isAwaited: true', async () => {
    const projectPath = await setupTest({
      'index.js': `
async function main() {
  for await (const x of getItems()) {
    console.log(x);
  }
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();
    const callNode = allNodes.find(n => n.type === 'CALL' && n.name === 'getItems');
    assert.ok(callNode, 'CALL node for getItems should exist');
    assert.strictEqual(callNode.isAwaited, true, 'isAwaited should be true for for-await iterable');

    // console.log inside loop body is NOT awaited
    const logCall = allNodes.find(n => n.type === 'CALL' && n.name === 'console.log');
    assert.ok(logCall, 'CALL node for console.log should exist');
    assert.strictEqual(logCall.isAwaited, false, 'console.log inside loop body should not be awaited');
  });

  it('await (cond ? foo() : bar()) → both isAwaited: true', async () => {
    const projectPath = await setupTest({
      'index.js': `
async function main() {
  const result = await (flag ? fetchA() : fetchB());
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();

    const fetchACall = allNodes.find(n => n.type === 'CALL' && n.name === 'fetchA');
    assert.ok(fetchACall, 'CALL node for fetchA should exist');
    assert.strictEqual(fetchACall.isAwaited, true, 'fetchA isAwaited should be true through ternary');

    const fetchBCall = allNodes.find(n => n.type === 'CALL' && n.name === 'fetchB');
    assert.ok(fetchBCall, 'CALL node for fetchB should exist');
    assert.strictEqual(fetchBCall.isAwaited, true, 'fetchB isAwaited should be true through ternary');
  });

  it('await (a() || b()) → both isAwaited: true', async () => {
    const projectPath = await setupTest({
      'index.js': `
async function main() {
  const result = await (getCached() || fetchRemote());
}
      `.trim()
    });

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(projectPath);

    const allNodes = await backend.getAllNodes();

    const cachedCall = allNodes.find(n => n.type === 'CALL' && n.name === 'getCached');
    assert.ok(cachedCall, 'CALL node for getCached should exist');
    assert.strictEqual(cachedCall.isAwaited, true, 'getCached isAwaited should be true through logical');

    const remoteCall = allNodes.find(n => n.type === 'CALL' && n.name === 'fetchRemote');
    assert.ok(remoteCall, 'CALL node for fetchRemote should exist');
    assert.strictEqual(remoteCall.isAwaited, true, 'fetchRemote isAwaited should be true through logical');
  });
});
