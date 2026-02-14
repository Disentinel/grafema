/**
 * AwaitInLoopValidator Tests (REG-298)
 *
 * Tests for the validation plugin that creates ISSUE nodes for
 * sequential await-in-loop patterns detected during analysis.
 *
 * The validator uses `context.reportIssue()` to create:
 * - `issue:performance` ISSUE nodes with severity=warning
 * - AFFECTS edges from ISSUE to the flagged CALL node
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../helpers/createTestOrchestrator.js';
import { AwaitInLoopValidator } from '@grafema/core';
import type { NodeRecord, EdgeRecord } from '@grafema/types';

let testCounter = 0;

async function setupTest(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-awaitloop-val-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-awaitloop-val-${testCounter}`,
      type: 'module',
      main: 'index.js'
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, {
    forceAnalysis: true,
    extraPlugins: [new AwaitInLoopValidator()]
  });
  await orchestrator.run(testDir);

  return { testDir };
}

async function getNodesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
}

async function getIssueNodes(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend']
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => typeof n.type === 'string' && n.type.startsWith('issue:'));
}

async function getEdgesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  edgeType: string
): Promise<EdgeRecord[]> {
  const allNodes = await backend.getAllNodes();
  const allEdges: EdgeRecord[] = [];
  for (const node of allNodes) {
    const outgoing = await backend.getOutgoingEdges(node.id);
    allEdges.push(...outgoing);
  }
  return allEdges.filter((e: EdgeRecord) => e.type === edgeType);
}

describe('AwaitInLoopValidator (REG-298)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'] & { cleanup: () => Promise<void> };
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(cleanupAllTestDatabases);

  it('should create ISSUE node for await-in-loop', async () => {
    await setupTest(backend, {
      'index.js': `
        async function fetchAll(urls) {
          for (const url of urls) {
            const data = await fetch(url);
          }
        }
      `
    });

    const issues = await getIssueNodes(backend);
    const perfIssues = issues.filter((n: any) => n.category === 'performance');

    assert.strictEqual(perfIssues.length, 1, 'should have 1 performance issue');
    const issue = perfIssues[0] as any;
    assert.strictEqual(issue.severity, 'warning');
    assert.ok(issue.message?.includes('Sequential await in loop'), `message should mention sequential await, got: ${issue.message}`);
    assert.ok(issue.message?.includes('Promise.all'), `message should suggest Promise.all, got: ${issue.message}`);
  });

  it('should create AFFECTS edge from ISSUE to CALL node', async () => {
    await setupTest(backend, {
      'index.js': `
        async function fetchAll(urls) {
          for (const url of urls) {
            const data = await fetch(url);
          }
        }
      `
    });

    const affectsEdges = await getEdgesByType(backend, 'AFFECTS');
    const issues = await getIssueNodes(backend);
    const calls = await getNodesByType(backend, 'CALL');

    const perfIssue = issues.find((n: any) => n.category === 'performance');
    const fetchCall = calls.find((n: any) => n.name === 'fetch');

    assert.ok(perfIssue, 'should have a performance issue');
    assert.ok(fetchCall, 'should have a fetch call');

    const affectsEdge = affectsEdges.find(
      (e: EdgeRecord) => e.src === perfIssue!.id && e.dst === fetchCall!.id
    );
    assert.ok(affectsEdge, 'AFFECTS edge should connect ISSUE to CALL');
  });

  it('should NOT create ISSUE for await outside loop', async () => {
    await setupTest(backend, {
      'index.js': `
        async function main() {
          const data = await fetch('http://example.com');
        }
      `
    });

    const issues = await getIssueNodes(backend);
    const perfIssues = issues.filter((n: any) => n.category === 'performance');

    assert.strictEqual(perfIssues.length, 0, 'should have no performance issues');
  });

  it('should NOT create ISSUE for await in callback inside loop', async () => {
    await setupTest(backend, {
      'index.js': `
        async function processAll(items) {
          for (const item of items) {
            items.map(async (x) => {
              await transform(x);
            });
          }
        }
      `
    });

    const issues = await getIssueNodes(backend);
    const perfIssues = issues.filter((n: any) => n.category === 'performance');

    assert.strictEqual(perfIssues.length, 0, 'should have no performance issues for callback await');
  });

  it('should create multiple ISSUE nodes for multiple await-in-loop patterns', async () => {
    await setupTest(backend, {
      'index.js': `
        async function process(items, urls) {
          for (const item of items) {
            await save(item);
          }
          for (const url of urls) {
            await fetch(url);
          }
        }
      `
    });

    const issues = await getIssueNodes(backend);
    const perfIssues = issues.filter((n: any) => n.category === 'performance');

    assert.strictEqual(perfIssues.length, 2, 'should have 2 performance issues');
  });
});
