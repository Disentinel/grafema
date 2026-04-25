/**
 * Tests for mcpToolDefinitionEnricher.
 *
 * The enricher scans `packages/mcp/src/definitions/*-tools.ts`, extracts each
 * tool name (snake_case), creates an `mcp:tool` node per tool, and links it
 * to the conventional handler FUNCTION node (`get_node` → `handleGetNode`)
 * via a HANDLES edge. Tools whose handler can't be located in the graph are
 * recorded in `unresolvedHandlers` for diagnostics.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  enrichMcpToolDefinitions,
  parseToolDefinitions,
  pascalCase,
} from '@grafema/util/enrichers/mcpToolDefinitionEnricher';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(async () => {
  await cleanupAllTestDatabases();
});

// ---------------------------------------------------------------------------
// Pure unit tests — file-format scanner & helpers
// ---------------------------------------------------------------------------

describe('mcpToolDefinitionEnricher: parseToolDefinitions', () => {
  it('extracts top-level name fields, ignoring nested property names', () => {
    const src = [
      "import type { ToolDefinition } from './types.js';",
      '',
      'export const X_TOOLS: ToolDefinition[] = [',
      '  {',
      "    name: 'get_node',",
      "    description: 'Get a node.',",
      '    inputSchema: {',
      "      type: 'object',",
      '      properties: {',
      '        semanticId: {',
      "          type: 'string',",
      "          description: 'Inner desc',",
      '        },',
      '      },',
      "      required: ['semanticId'],",
      '    },',
      '  },',
      '  {',
      "    name: 'find_calls',",
      "    description: `Backtick desc",
      "spans multiple lines`,",
      '    inputSchema: { type: "object", properties: {} },',
      '  },',
      '];',
      '',
    ].join('\n');

    const tools = parseToolDefinitions(src);
    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, 'get_node');
    assert.equal(tools[0].description, 'Get a node.');
    assert.equal(tools[1].name, 'find_calls');
    assert.match(tools[1].description, /spans multiple lines/);
  });

  it('rejects non-snake_case identifiers (defensive against false positives)', () => {
    const src = [
      'export const X: ToolDefinition[] = [',
      '  {',
      "    name: 'NotASnakeCaseName',",
      "    description: 'x',",
      '  },',
      '];',
    ].join('\n');
    assert.equal(parseToolDefinitions(src).length, 0);
  });
});

describe('mcpToolDefinitionEnricher: pascalCase', () => {
  it('converts snake_case to PascalCase', () => {
    assert.equal(pascalCase('find_nodes'), 'FindNodes');
    assert.equal(pascalCase('get_node'), 'GetNode');
    assert.equal(pascalCase('describe'), 'Describe');
    assert.equal(pascalCase('query_graphql'), 'QueryGraphql');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — enricher against a live test RFDB
// ---------------------------------------------------------------------------

describe('mcpToolDefinitionEnricher: enrichMcpToolDefinitions', () => {
  /** @type {Awaited<ReturnType<typeof createTestDatabase>>} */
  let db;
  /** @type {any} */
  let backend;
  /** @type {any} */
  let client;
  /** @type {string} */
  let defsDir;

  before(() => {
    defsDir = mkdtempSync(join(tmpdir(), 'mcp-defs-'));
    // Two tool files plus a non-tool file (must be skipped).
    writeFileSync(
      join(defsDir, 'graph-tools.ts'),
      [
        "import type { ToolDefinition } from './types.js';",
        '',
        'export const GRAPH_TOOLS: ToolDefinition[] = [',
        '  {',
        "    name: 'get_node',",
        "    description: 'Get a node.',",
        '    inputSchema: { type: "object", properties: {} },',
        '  },',
        '  {',
        "    name: 'get_neighbors',",
        "    description: 'Get neighbors.',",
        '    inputSchema: { type: "object", properties: {} },',
        '  },',
        '];',
      ].join('\n'),
    );
    writeFileSync(
      join(defsDir, 'query-tools.ts'),
      [
        'export const QUERY_TOOLS: ToolDefinition[] = [',
        '  {',
        "    name: 'find_nodes',",
        "    description: 'Find nodes.',",
        '    inputSchema: { type: "object", properties: {} },',
        '  },',
        '];',
      ].join('\n'),
    );
    // Should be skipped: doesn't end with -tools.ts
    writeFileSync(join(defsDir, 'types.ts'), 'export interface ToolDefinition {}\n');
    // Should be skipped: index.ts (and also doesn't match -tools.ts)
    writeFileSync(join(defsDir, 'index.ts'), 'export const TOOLS = [];\n');
  });

  after(() => {
    if (defsDir) rmSync(defsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
    client = backend.client;
  });

  it('creates an mcp:tool node per tool and skips non-*-tools.ts files', async () => {
    const result = await enrichMcpToolDefinitions(client, { definitionsDir: defsDir });

    assert.equal(result.toolNodesCreated, 3);
    // No FUNCTION nodes added → all handlers unresolved.
    assert.equal(result.handlesEdgesCreated, 0);
    assert.deepEqual(
      result.unresolvedHandlers.sort(),
      ['find_nodes', 'get_neighbors', 'get_node'],
    );

    const tools = [];
    for await (const wn of client.queryNodes({ type: 'mcp:tool' })) tools.push(wn);
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, ['find_nodes', 'get_neighbors', 'get_node']);
  });

  it('creates HANDLES edge to handler FUNCTION when convention matches', async () => {
    // Plant a `handleGetNode` FUNCTION in the graph; the enricher should link
    // mcp:tool[get_node] → that function.
    await backend.addNode({
      id: 'test::module',
      type: 'MODULE',
      name: 'graph-handlers.ts',
      file: 'src/handlers/graph-handlers.ts',
      relativePath: 'src/handlers/graph-handlers.ts',
      contentHash: 'h1',
    });
    await backend.addNode({
      id: 'test::handler-getnode',
      type: 'FUNCTION',
      name: 'handleGetNode',
      file: 'src/handlers/graph-handlers.ts',
      async: true,
      generator: false,
      exported: true,
      arrowFunction: false,
    });

    const result = await enrichMcpToolDefinitions(client, { definitionsDir: defsDir });
    assert.equal(result.toolNodesCreated, 3);
    assert.equal(result.handlesEdgesCreated, 1, 'one HANDLES edge for get_node');
    assert.deepEqual(
      result.unresolvedHandlers.sort(),
      ['find_nodes', 'get_neighbors'],
    );

    // Locate the get_node mcp:tool wire node; its outgoing HANDLES must point
    // to the handler FUNCTION's wire id.
    const tools = [];
    for await (const wn of client.queryNodes({ type: 'mcp:tool' })) tools.push(wn);
    const getNodeTool = tools.find(t => t.name === 'get_node');
    assert.ok(getNodeTool, 'get_node mcp:tool exists');

    const handles = await client.getOutgoingEdges(getNodeTool.id, ['HANDLES']);
    assert.equal(handles.length, 1);

    // Resolve the handler's wire id by scanning FUNCTION nodes for our originalId.
    let handlerWireId = null;
    for await (const wn of client.queryNodes({ type: 'FUNCTION' })) {
      let meta = {};
      try { meta = wn.metadata ? JSON.parse(wn.metadata) : {}; } catch { /* empty */ }
      if (meta.originalId === 'test::handler-getnode') { handlerWireId = wn.id; break; }
    }
    assert.ok(handlerWireId, 'handler wire id resolved');
    assert.equal(handles[0].dst, handlerWireId);
  });

  it('is idempotent: re-running does not duplicate mcp:tool nodes', async () => {
    await enrichMcpToolDefinitions(client, { definitionsDir: defsDir });
    await enrichMcpToolDefinitions(client, { definitionsDir: defsDir });
    const tools = [];
    for await (const wn of client.queryNodes({ type: 'mcp:tool' })) tools.push(wn);
    assert.equal(tools.length, 3, 'no duplication after second run');
  });

  it('returns empty result when definitionsDir does not exist', async () => {
    const result = await enrichMcpToolDefinitions(client, {
      definitionsDir: '/nonexistent-dir-xyz',
    });
    assert.equal(result.toolNodesCreated, 0);
    assert.equal(result.handlesEdgesCreated, 0);
    assert.deepEqual(result.unresolvedHandlers, []);
  });
});

// ---------------------------------------------------------------------------
// Live-fixture smoke test — runs against the actual Grafema definitions
// to catch format drift in the real *-tools.ts files.
// ---------------------------------------------------------------------------

describe('mcpToolDefinitionEnricher: live definitions smoke', () => {
  it('detects ~30+ tools from packages/mcp/src/definitions', async () => {
    const db = await createTestDatabase();
    try {
      const result = await enrichMcpToolDefinitions(db.backend.client, {
        definitionsDir: 'packages/mcp/src/definitions',
      });
      // We expect at least 25 tools — the actual count is 39 at time of
      // writing, but we keep the lower bound conservative so adding/removing
      // a handful of tools doesn't break the test.
      assert.ok(
        result.toolNodesCreated >= 25,
        `expected >=25 tools, got ${result.toolNodesCreated}`,
      );
      // Sanity: well-known tools should be present.
      const tools = [];
      for await (const wn of db.backend.client.queryNodes({ type: 'mcp:tool' })) tools.push(wn);
      const names = new Set(tools.map(t => t.name));
      for (const expected of ['get_node', 'find_nodes', 'find_calls', 'describe', 'query_graph']) {
        assert.ok(names.has(expected), `missing well-known tool: ${expected}`);
      }
    } finally {
      await db.cleanup();
    }
  });
});
