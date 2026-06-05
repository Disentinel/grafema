/**
 * Integration tests for RFDB Federation Protocol (RFD-53).
 *
 * Starts 2 rfdb-server processes with --federate, each covering
 * a different directory. Tests shard discovery, SUBGRAPH with frontier,
 * and cross-shard reference detection.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { realpathSync } from 'node:fs';
import { RFDBClient } from '../../packages/rfdb/dist/client.js';
import { ShardDiscovery } from '../../packages/util/dist/federation/ShardDiscovery.js';
import { findRfdbBinary } from '@grafema/util';

// ── Helpers ─────────────────────────────────────────────────────

// Resolve rfdb-server via the canonical production resolver so the suite
// honors GRAFEMA_RFDB_SERVER, the platform npm package, PATH, ~/.grafema/bin,
// etc. — not just the two monorepo `cargo`-build paths. See
// test/unit/RfdbBinaryResolutionSiblings.test.js for the rationale.
function findServerBinary() {
  return findRfdbBinary();
}

async function startFederatedServer(name, dbDir, socketPath, rootPath) {
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'graph.rfdb');

  const binary = findServerBinary();
  if (!binary) throw new Error('rfdb-server binary not found');

  // Clean up stale socket
  rmSync(socketPath, { force: true });

  const proc = spawn(binary, [
    dbPath,
    '--socket', socketPath,
    '--federate',
    '--root', rootPath,
  ], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  proc.unref();

  // Wait for socket
  let attempts = 0;
  while (!existsSync(socketPath) && attempts < 50) {
    await sleep(100);
    attempts++;
  }
  if (!existsSync(socketPath)) {
    throw new Error(`Server ${name} failed to start after ${attempts * 100}ms`);
  }

  const client = new RFDBClient(socketPath);
  await client.connect();
  await client.hello(3);

  return { proc, client, socketPath, dbPath, rootPath };
}

async function stopServer(server) {
  try { await server.client.shutdown(); } catch { /* expected */ }
  try { await server.client.close(); } catch { /* ignore */ }
  if (server.proc && !server.proc.killed) {
    server.proc.kill('SIGTERM');
  }
  // Give server time to clean up registration
  await sleep(200);
}

// ── Test Suite ──────────────────────────────────────────────────

describe('RFDB Federation', () => {
  const BASE_RAW = '/tmp/rfdb-federation-test';

  // On macOS, /tmp is a symlink to /private/tmp.
  // rfdb-server canonicalizes --root, so we must use canonical paths too.
  let BASE, SHARD_A_ROOT, SHARD_B_ROOT;

  let serverA, serverB;

  before(async () => {
    // Clean previous test state
    rmSync(BASE_RAW, { recursive: true, force: true });
    rmSync('/tmp/rfdb-shards', { recursive: true, force: true });

    // Create fake project directories (use raw paths for creation)
    mkdirSync(join(BASE_RAW, 'project/packages/frontend/src'), { recursive: true });
    mkdirSync(join(BASE_RAW, 'project/packages/api/src'), { recursive: true });

    // Now resolve canonical paths (after dirs exist)
    BASE = realpathSync(BASE_RAW);
    SHARD_A_ROOT = join(BASE, 'project/packages/frontend');
    SHARD_B_ROOT = join(BASE, 'project/packages/api');

    // Start two federated servers
    serverA = await startFederatedServer(
      'shard-a',
      join(BASE, 'shard-a-db'),
      '/tmp/rfdb-federation-a.sock',
      SHARD_A_ROOT,
    );

    serverB = await startFederatedServer(
      'shard-b',
      join(BASE, 'shard-b-db'),
      '/tmp/rfdb-federation-b.sock',
      SHARD_B_ROOT,
    );
  });

  after(async () => {
    if (serverA) await stopServer(serverA);
    if (serverB) await stopServer(serverB);
    rmSync(BASE_RAW, { recursive: true, force: true });
    rmSync('/tmp/rfdb-shards', { recursive: true, force: true });
  });

  // ── Phase 1: Shard Discovery ──────────────────────────────────

  it('both servers register in /tmp/rfdb-shards/', () => {
    assert.ok(existsSync('/tmp/rfdb-shards'), 'shards directory should exist');
    const files = readdirSync('/tmp/rfdb-shards').filter(f => f.endsWith('.json'));
    assert.equal(files.length, 2, 'should have 2 shard registrations');
  });

  it('shard registrations contain correct data', () => {
    const files = readdirSync('/tmp/rfdb-shards').filter(f => f.endsWith('.json'));
    const registrations = files.map(f =>
      JSON.parse(readFileSync(join('/tmp/rfdb-shards', f), 'utf-8')),
    );

    const roots = registrations.map(r => r.root).sort();
    assert.ok(roots.some(r => r.includes('frontend')), 'should have frontend shard');
    assert.ok(roots.some(r => r.includes('api')), 'should have api shard');

    for (const reg of registrations) {
      assert.ok(reg.pid > 0, 'should have valid PID');
      assert.ok(reg.socket, 'should have socket path');
      assert.ok(reg.serverVersion, 'should have server version');
    }
  });

  it('ShardDiscovery finds both shards', () => {
    const discovery = new ShardDiscovery();
    const count = discovery.scan();
    assert.equal(count, 2, 'should discover 2 shards');
  });

  it('ShardDiscovery resolves file paths to correct shard', () => {
    const discovery = new ShardDiscovery();
    discovery.scan();

    const frontendShard = discovery.resolve(join(SHARD_A_ROOT, 'src/app.ts'));
    assert.ok(frontendShard, 'should resolve frontend file');
    assert.ok(frontendShard.root.includes('frontend'));

    const apiShard = discovery.resolve(join(SHARD_B_ROOT, 'src/client.ts'));
    assert.ok(apiShard, 'should resolve api file');
    assert.ok(apiShard.root.includes('api'));

    const unknown = discovery.resolve('/some/unrelated/path.ts');
    assert.equal(unknown, null, 'should return null for unknown paths');
  });

  // ── Phase 1: WhoAreYou ────────────────────────────────────────

  it('WhoAreYou returns shard identity', async () => {
    const identity = await serverA.client.whoAreYou();
    assert.ok(identity.ok);
    assert.ok(identity.root.includes('frontend'));
    assert.ok(identity.serverVersion);
    assert.equal(identity.federated, true);
  });

  // ── Phase 2: SUBGRAPH with Frontier ───────────────────────────

  it('SUBGRAPH returns frontier for dangling cross-shard edges', async () => {
    // Populate Shard A with nodes that have cross-shard references
    const frontendFile = join(SHARD_A_ROOT, 'src/app.ts');
    const apiFile = join(SHARD_B_ROOT, 'src/client.ts');

    await serverA.client.addNodes([
      {
        id: `${frontendFile}->MODULE->app`,
        nodeType: 'MODULE',
        name: 'app',
        file: frontendFile,
      },
      {
        id: `${frontendFile}->FUNCTION->handleRequest`,
        nodeType: 'FUNCTION',
        name: 'handleRequest',
        file: frontendFile,
      },
    ]);

    await serverA.client.addEdges([
      {
        src: `${frontendFile}->MODULE->app`,
        dst: `${frontendFile}->FUNCTION->handleRequest`,
        edgeType: 'CONTAINS',
      },
      {
        // Cross-shard edge: frontend imports from api
        src: `${frontendFile}->FUNCTION->handleRequest`,
        dst: `${apiFile}->FUNCTION->apiClient`,
        edgeType: 'IMPORTS_FROM',
        source: '@project/api',
      },
    ]);

    await serverA.client.flush();

    // SUBGRAPH from the module — should traverse locally and hit frontier
    const result = await serverA.client.subgraph(
      [`${frontendFile}->MODULE->app`],
      'forward',
      [],
      5,
    );

    assert.ok(result.ok, 'SUBGRAPH should succeed');

    // Should have visited local nodes
    assert.ok(result.nodes.length >= 2, `should have >= 2 nodes, got ${result.nodes.length}`);

    // Should have frontier (cross-shard edge to api)
    assert.ok(result.frontier.length >= 1, `should have >= 1 frontier edge, got ${result.frontier.length}`);

    const importEdge = result.frontier.find(e => e.edgeType === 'IMPORTS_FROM');
    assert.ok(importEdge, 'should have IMPORTS_FROM in frontier');
    assert.ok(importEdge.metadata, 'frontier edge should carry metadata');

    const meta = JSON.parse(importEdge.metadata);
    assert.equal(meta.source, '@project/api', 'metadata should contain import source');
  });

  // ── Phase 2: SUBGRAPH with direction ──────────────────────────

  it('SUBGRAPH backward traversal works', async () => {
    const frontendFile = join(SHARD_A_ROOT, 'src/app.ts');

    const result = await serverA.client.subgraph(
      [`${frontendFile}->FUNCTION->handleRequest`],
      'backward',
      ['CONTAINS'],
      5,
    );

    assert.ok(result.ok);
    // Should find the MODULE that contains handleRequest
    const moduleNode = result.nodes.find(n =>
      n.nodeType === 'MODULE' || n.name === 'app',
    );
    assert.ok(moduleNode, 'backward traversal should find containing module');
  });

  // ── Cross-shard scenario: both shards have data ───────────────

  it('Shard B has data that Shard A frontier points to', async () => {
    const apiFile = join(SHARD_B_ROOT, 'src/client.ts');

    await serverB.client.addNodes([
      {
        id: `${apiFile}->FUNCTION->apiClient`,
        nodeType: 'FUNCTION',
        name: 'apiClient',
        file: apiFile,
      },
      {
        id: `${apiFile}->FUNCTION->httpRequest`,
        nodeType: 'FUNCTION',
        name: 'httpRequest',
        file: apiFile,
      },
    ]);

    await serverB.client.addEdges([
      {
        src: `${apiFile}->FUNCTION->apiClient`,
        dst: `${apiFile}->FUNCTION->httpRequest`,
        edgeType: 'CALLS',
      },
    ]);

    await serverB.client.flush();

    // Verify shard B has the node that shard A's frontier points to
    const node = await serverB.client.getNode(`${apiFile}->FUNCTION->apiClient`);
    assert.ok(node, 'Shard B should have the apiClient node');
    assert.equal(node.name, 'apiClient');

    // SUBGRAPH from apiClient in Shard B works locally
    const sub = await serverB.client.subgraph(
      [`${apiFile}->FUNCTION->apiClient`],
      'forward',
      ['CALLS'],
      5,
    );
    assert.ok(sub.ok);
    assert.ok(sub.nodes.length >= 2, 'should traverse apiClient → httpRequest');
  });

  // ── End-to-end: manual cross-shard stitching ──────────────────

  it('manual cross-shard trace: A → frontier → B', async () => {
    const frontendFile = join(SHARD_A_ROOT, 'src/app.ts');

    // Step 1: SUBGRAPH in Shard A
    const hopA = await serverA.client.subgraph(
      [`${frontendFile}->MODULE->app`],
      'forward',
      [],
      5,
    );

    assert.ok(hopA.frontier.length > 0, 'Shard A should have frontier');

    // Step 2: Discovery — find which shard owns the frontier target
    const discovery = new ShardDiscovery();
    discovery.scan();

    const frontierEdge = hopA.frontier.find(e => e.edgeType === 'IMPORTS_FROM');
    assert.ok(frontierEdge);

    // The dst is a hash — but we know the api file path from context
    const apiFile = join(SHARD_B_ROOT, 'src/client.ts');
    const targetShard = discovery.resolve(apiFile);
    assert.ok(targetShard, 'should discover shard B for api file');
    assert.ok(targetShard.root.includes('api'));

    // Step 3: SUBGRAPH in Shard B from the target entry point
    const targetClient = new RFDBClient(targetShard.socket);
    await targetClient.connect();
    await targetClient.hello(3);

    const hopB = await targetClient.subgraph(
      [`${apiFile}->FUNCTION->apiClient`],
      'forward',
      ['CALLS'],
      5,
    );

    assert.ok(hopB.ok);
    assert.ok(hopB.nodes.length >= 2, 'Shard B should return apiClient + httpRequest');

    // Step 4: Stitch results
    const allNodes = [...hopA.nodes, ...hopB.nodes];
    const allEdges = [...hopA.edges, ...hopB.edges];

    assert.ok(allNodes.length >= 4, `stitched graph should have >= 4 nodes, got ${allNodes.length}`);
    assert.ok(allEdges.length >= 2, `stitched graph should have >= 2 edges, got ${allEdges.length}`);

    await targetClient.close();
  });
});
