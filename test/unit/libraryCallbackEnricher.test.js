/**
 * Tests for libraryCallbackEnricher.
 *
 * HISTORY: this enricher used to mint domain FEATURE nodes (cli:command,
 * mcp:tool, vscode:command, and the HTTP frameworks' http:route) by reading
 * `args[].role = ENTRY_POINT_CALLBACK` from effects-db. Those slices have ALL
 * been migrated to default-on derive packs — the pack is now the SINGLE
 * producer of each (the duplicate-producer / byte-different-id hazard):
 *   - Wave 14 (REG-1115): the 6 HTTP frameworks → js_http_routes_nodes/_edges.dl
 *   - Loop-2: commander → cli:command, @modelcontextprotocol/sdk → mcp:tool,
 *     vscode → vscode:command → js_entrypoint_features_nodes/_edges.dl
 *
 * As of Loop-2 the enricher's `LIBRARY_NODE_TYPE` map is EMPTY, so
 * `enrichLibraryCallbacks` is a NO-OP for every input (the `methodIndex.size
 * === 0` early return). The enricher is retained — not deleted — this wave so
 * its generic role-driven resolution machinery survives for the next library
 * slice that opts in via the map before its own pack exists.
 *
 * These tests now pin the NO-OP contract: regardless of the seeded graph
 * (commander/mcp/vscode call shapes that the OLD enricher would have minted),
 * the enricher creates zero nodes and zero edges. The actual minting behaviour
 * is covered by the derive-pack fixture tests in rfdb-server
 * (derive::stdlib::tests::js_entrypoint_features_nodes_three_slices and
 * ::js_entrypoint_features_edges_joins_minted_endpoints) and the shadow
 * differential on the real graph.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { EffectsLookup } from '@grafema/util';
import { enrichLibraryCallbacks } from '@grafema/util/enrichers/libraryCallbackEnricher';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(async () => {
  await cleanupAllTestDatabases();
});

describe('libraryCallbackEnricher (retired slices — no-op contract)', () => {
  /** @type {Awaited<ReturnType<typeof createTestDatabase>>} */
  let db;
  /** @type {any} */
  let backend;
  /** @type {any} */
  let client;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
    client = backend.client;
  });

  /** Seed an MCP setRequestHandler call — the shape the enricher used to mint
   *  an mcp:tool from. With the map empty it must mint nothing. */
  async function seedMcpCall() {
    await backend.addNode({
      id: 'test::ib-server',
      type: 'IMPORT_BINDING',
      name: 'server',
      file: 'mcp.ts',
      importedName: 'server',
      source: '@modelcontextprotocol/sdk',
    });
    await backend.addNode({
      id: 'test::call',
      type: 'CALL',
      name: 'server.setRequestHandler',
      file: 'mcp.ts',
      argCount: 2,
    });
    await backend.addNode({
      id: 'test::handler',
      type: 'FUNCTION',
      name: 'callToolHandler',
      file: 'mcp.ts',
      arrowFunction: true,
    });
    await backend.addEdge({ src: 'test::call', dst: 'test::handler', type: 'PASSES_ARGUMENT', index: 1 });
  }

  it('is a no-op even with a populated effects-db (empty LIBRARY_NODE_TYPE)', async () => {
    // An effects-db that DOES carry ENTRY_POINT_CALLBACK roles for the retired
    // libraries: the enricher must still produce nothing because no library
    // maps to a node type any more.
    const lookup = EffectsLookup.empty();
    await seedMcpCall();

    const result = await enrichLibraryCallbacks(client, lookup);
    assert.equal(result.domainNodesCreated, 0, 'retired: no domain nodes minted');
    assert.equal(result.handlesEdgesCreated, 0, 'retired: no HANDLES edges minted');
    assert.equal(result.unresolvedCalls, 0, 'empty method index ⇒ no calls even scanned');

    for (const ty of ['mcp:tool', 'cli:command', 'vscode:command']) {
      const found = [];
      for await (const wn of client.queryNodes({ type: ty })) found.push(wn);
      assert.equal(found.length, 0, `${ty} is produced by the derive pack, not the enricher`);
    }
  });

  it('returns the zero result on an empty graph', async () => {
    const result = await enrichLibraryCallbacks(client, EffectsLookup.empty());
    assert.deepEqual(result, {
      domainNodesCreated: 0,
      handlesEdgesCreated: 0,
      unresolvedCalls: 0,
    });
  });
});
