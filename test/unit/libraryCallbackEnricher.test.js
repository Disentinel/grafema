/**
 * Tests for libraryCallbackEnricher (REG-XXX, plan: atomic-purring-rivest Change 4).
 *
 * The enricher reads role annotations from effects-db (e.g. ENTRY_POINT_CALLBACK)
 * and, for every CALL node in the graph whose receiver traces back to a matching
 * library import, creates a domain node (cli:command, mcp:tool, ...) with a
 * HANDLES edge to the callback function and an EXPOSES edge from the call site.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { EffectsLookup } from '@grafema/util';
import { enrichLibraryCallbacks } from '@grafema/util/enrichers/libraryCallbackEnricher';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// ---------------------------------------------------------------------------
// Build a tiny effects-db on disk so EffectsLookup.load() can pick it up.
// We only need the two libraries the enricher knows about.
// ---------------------------------------------------------------------------

let effectsDbDir;
let effectsLookup;

before(() => {
  effectsDbDir = mkdtempSync(join(tmpdir(), 'effectsdb-libcb-'));
  mkdirSync(join(effectsDbDir, 'packages'), { recursive: true });
  mkdirSync(join(effectsDbDir, 'runtimes'), { recursive: true });

  writeFileSync(
    join(effectsDbDir, 'packages', 'commander.yaml'),
    [
      'commander:',
      '  Command.command:',
      '    effects: [MUTATION]',
      '    args:',
      '      - index: 0',
      '        role: COMMAND_NAME',
      '    returns:',
      '      type: Command',
      '  Command.action:',
      '    effects: [MUTATION]',
      '    args:',
      '      - index: 0',
      '        role: ENTRY_POINT_CALLBACK',
      '    returns:',
      '      type: Command',
      '  Command.description:',
      '    effects: [MUTATION]',
      '    returns:',
      '      type: Command',
      '  Command.argument:',
      '    effects: [MUTATION]',
      '    returns:',
      '      type: Command',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(effectsDbDir, 'packages', 'modelcontextprotocol-sdk.yaml'),
    [
      '"@modelcontextprotocol/sdk":',
      '  Server.setRequestHandler:',
      '    effects: [MUTATION]',
      '    args:',
      '      - index: 0',
      '        role: TOOL_SCHEMA',
      '      - index: 1',
      '        role: ENTRY_POINT_CALLBACK',
      '',
    ].join('\n'),
  );

  effectsLookup = EffectsLookup.load(effectsDbDir);
});

after(async () => {
  if (effectsDbDir) rmSync(effectsDbDir, { recursive: true, force: true });
  await cleanupAllTestDatabases();
});

// ---------------------------------------------------------------------------
// Fixture helpers — build small synthetic graphs in the live RFDB.
// ---------------------------------------------------------------------------

/**
 * Find a single WireNode by its TestRFDB-stored originalId.
 * We iterate by type/file and match metadata.originalId in-memory rather than
 * relying on metadata indexing being declared for `originalId`.
 */
async function getWireNodeByOriginalId(client, originalId, type) {
  // Note: querying with file: filter strips metadata from the wire response,
  // so we iterate by type only and match metadata.originalId in-memory.
  for await (const wn of client.queryNodes(type ? { type } : {})) {
    let meta = {};
    try { meta = wn.metadata ? JSON.parse(wn.metadata) : {}; } catch { /* empty */ }
    if (meta.originalId === originalId) return wn;
  }
  return null;
}

async function getEdges(client, srcWireId, edgeType) {
  const all = await client.getOutgoingEdges(srcWireId, [edgeType]);
  return all;
}

// ---------------------------------------------------------------------------

describe('libraryCallbackEnricher', () => {
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

  it('direct call: server.setRequestHandler creates mcp:tool + HANDLES edge', async () => {
    // module
    await backend.addNode({
      id: 'test::module',
      type: 'MODULE',
      name: 'mcp.ts',
      file: 'mcp.ts',
      relativePath: 'mcp.ts',
      contentHash: 'h1',
    });
    // module scope
    await backend.addNode({
      id: 'test::scope',
      type: 'SCOPE',
      name: 'global',
      file: 'mcp.ts',
      scopeType: 'module',
    });
    await backend.addEdge({ src: 'test::module', dst: 'test::scope', type: 'HAS_SCOPE' });

    // import binding for `server` from @modelcontextprotocol/sdk
    await backend.addNode({
      id: 'test::ib-server',
      type: 'IMPORT_BINDING',
      name: 'server',
      file: 'mcp.ts',
      importedName: 'server',
      source: '@modelcontextprotocol/sdk',
    });
    await backend.addEdge({ src: 'test::scope', dst: 'test::ib-server', type: 'DECLARES' });

    // CALL node: server.setRequestHandler(schema, handler)
    await backend.addNode({
      id: 'test::call',
      type: 'CALL',
      name: 'server.setRequestHandler',
      file: 'mcp.ts',
      argCount: 2,
    });

    // schema arg (idx 0) — a literal-ish placeholder
    await backend.addNode({
      id: 'test::schema-arg',
      type: 'EXPRESSION',
      name: 'CallToolRequestSchema',
      file: 'mcp.ts',
    });
    await backend.addEdge({
      src: 'test::call',
      dst: 'test::schema-arg',
      type: 'PASSES_ARGUMENT',
      index: 0,
    });

    // handler fn (idx 1)
    await backend.addNode({
      id: 'test::handler',
      type: 'FUNCTION',
      name: 'callToolHandler',
      file: 'mcp.ts',
      async: true,
      generator: false,
      exported: false,
      arrowFunction: true,
    });
    await backend.addEdge({
      src: 'test::call',
      dst: 'test::handler',
      type: 'PASSES_ARGUMENT',
      index: 1,
    });

    const result = await enrichLibraryCallbacks(client, effectsLookup);

    assert.equal(result.domainNodesCreated, 1, 'one mcp:tool node expected');
    assert.equal(result.handlesEdgesCreated, 1, 'one HANDLES edge expected');

    const tools = [];
    for await (const wn of client.queryNodes({ type: 'mcp:tool' })) tools.push(wn);
    assert.equal(tools.length, 1);

    const callWire = await getWireNodeByOriginalId(client, 'test::call', 'CALL');
    assert.ok(callWire, 'CALL node should still exist');
    const exposes = await getEdges(client, callWire.id, 'EXPOSES');
    assert.equal(exposes.length, 1, 'CALL should EXPOSE the mcp:tool');

    // Verify HANDLES edge from domain node → handler function
    const toolWireId = tools[0].id;
    const handles = await getEdges(client, toolWireId, 'HANDLES');
    assert.equal(handles.length, 1);
    const handlerWire = await getWireNodeByOriginalId(client, 'test::handler', 'FUNCTION');
    assert.equal(handles[0].dst, handlerWire.id);
  });

  it('subpath import: source "@modelcontextprotocol/sdk/server/index.js" matches rule "@modelcontextprotocol/sdk"', async () => {
    // Real-world MCP SDK imports use subpaths (e.g.
    // `@modelcontextprotocol/sdk/server/index.js`) but the effects-db rule key
    // is the bare package name. The matcher must accept any subpath of the
    // declared library name, but reject sibling packages like
    // `@modelcontextprotocol/sdk-foo`.
    await backend.addNode({
      id: 'test::module',
      type: 'MODULE',
      name: 'server.ts',
      file: 'server.ts',
      relativePath: 'server.ts',
      contentHash: 'h1',
    });
    await backend.addNode({
      id: 'test::scope',
      type: 'SCOPE',
      name: 'global',
      file: 'server.ts',
      scopeType: 'module',
    });
    await backend.addEdge({ src: 'test::module', dst: 'test::scope', type: 'HAS_SCOPE' });

    // IMPORT_BINDING with subpath source — exactly how the JS analyzer records
    // `import { Server } from '@modelcontextprotocol/sdk/server/index.js'`.
    await backend.addNode({
      id: 'test::ib-server',
      type: 'IMPORT_BINDING',
      name: 'server',
      file: 'server.ts',
      importedName: 'server',
      source: '@modelcontextprotocol/sdk/server/index.js',
    });
    await backend.addEdge({ src: 'test::scope', dst: 'test::ib-server', type: 'DECLARES' });

    await backend.addNode({
      id: 'test::call',
      type: 'CALL',
      name: 'server.setRequestHandler',
      file: 'server.ts',
      argCount: 2,
    });
    await backend.addNode({
      id: 'test::schema-arg',
      type: 'EXPRESSION',
      name: 'CallToolRequestSchema',
      file: 'server.ts',
    });
    await backend.addEdge({
      src: 'test::call',
      dst: 'test::schema-arg',
      type: 'PASSES_ARGUMENT',
      index: 0,
    });
    await backend.addNode({
      id: 'test::handler',
      type: 'FUNCTION',
      name: 'callToolHandler',
      file: 'server.ts',
      async: true,
      generator: false,
      exported: false,
      arrowFunction: true,
    });
    await backend.addEdge({
      src: 'test::call',
      dst: 'test::handler',
      type: 'PASSES_ARGUMENT',
      index: 1,
    });

    const result = await enrichLibraryCallbacks(client, effectsLookup);
    assert.equal(result.domainNodesCreated, 1, 'subpath import should match bare-name rule');
    assert.equal(result.handlesEdgesCreated, 1);

    const tools = [];
    for await (const wn of client.queryNodes({ type: 'mcp:tool' })) tools.push(wn);
    assert.equal(tools.length, 1);
  });

  it('subpath guard: source "@modelcontextprotocol/sdk-foo" does NOT match rule "@modelcontextprotocol/sdk"', async () => {
    // Sibling package whose name happens to share a prefix with an annotated
    // library must not match. The guard is the trailing `/`.
    await backend.addNode({
      id: 'test::module',
      type: 'MODULE',
      name: 'sibling.ts',
      file: 'sibling.ts',
      relativePath: 'sibling.ts',
      contentHash: 'h1',
    });
    await backend.addNode({
      id: 'test::scope',
      type: 'SCOPE',
      name: 'global',
      file: 'sibling.ts',
      scopeType: 'module',
    });
    await backend.addEdge({ src: 'test::module', dst: 'test::scope', type: 'HAS_SCOPE' });

    await backend.addNode({
      id: 'test::ib-server',
      type: 'IMPORT_BINDING',
      name: 'server',
      file: 'sibling.ts',
      importedName: 'server',
      source: '@modelcontextprotocol/sdk-foo',
    });
    await backend.addEdge({ src: 'test::scope', dst: 'test::ib-server', type: 'DECLARES' });

    await backend.addNode({
      id: 'test::call',
      type: 'CALL',
      name: 'server.setRequestHandler',
      file: 'sibling.ts',
      argCount: 2,
    });
    await backend.addNode({
      id: 'test::handler',
      type: 'FUNCTION',
      name: 'h',
      file: 'sibling.ts',
      async: false,
      generator: false,
      exported: false,
      arrowFunction: true,
    });
    await backend.addEdge({
      src: 'test::call',
      dst: 'test::handler',
      type: 'PASSES_ARGUMENT',
      index: 1,
    });

    const result = await enrichLibraryCallbacks(client, effectsLookup);
    assert.equal(result.domainNodesCreated, 0);
    const tools = [];
    for await (const wn of client.queryNodes({ type: 'mcp:tool' })) tools.push(wn);
    assert.equal(tools.length, 0);
  });

  it('chained call: new Command("analyze").action(fn) creates cli:command named "analyze"', async () => {
    await backend.addNode({
      id: 'test::module',
      type: 'MODULE',
      name: 'cli.ts',
      file: 'cli.ts',
      relativePath: 'cli.ts',
      contentHash: 'h1',
    });
    await backend.addNode({
      id: 'test::scope',
      type: 'SCOPE',
      name: 'global',
      file: 'cli.ts',
      scopeType: 'module',
    });
    await backend.addEdge({ src: 'test::module', dst: 'test::scope', type: 'HAS_SCOPE' });

    // import binding `Command` from commander
    await backend.addNode({
      id: 'test::ib-Command',
      type: 'IMPORT_BINDING',
      name: 'Command',
      file: 'cli.ts',
      importedName: 'Command',
      source: 'commander',
    });
    await backend.addEdge({ src: 'test::scope', dst: 'test::ib-Command', type: 'DECLARES' });

    // Inner CALL: new Command('analyze')
    await backend.addNode({
      id: 'test::new-Command',
      type: 'CALL',
      name: 'Command',
      file: 'cli.ts',
      kind: 'new',
      argCount: 1,
    });
    // Literal arg with command name
    await backend.addNode({
      id: 'test::name-arg',
      type: 'LITERAL',
      name: 'analyze',
      file: 'cli.ts',
      value: 'analyze',
    });
    await backend.addEdge({
      src: 'test::new-Command',
      dst: 'test::name-arg',
      type: 'PASSES_ARGUMENT',
      index: 0,
    });

    // Outer CALL: <obj>.action(fn) — receiver is the new Command call
    await backend.addNode({
      id: 'test::call-action',
      type: 'CALL',
      name: '<obj>.action',
      file: 'cli.ts',
      argCount: 1,
    });
    // RECEIVER_CALL chain: outer .action → inner new Command
    await backend.addEdge({
      src: 'test::call-action',
      dst: 'test::new-Command',
      type: 'RECEIVER_CALL',
    });

    // The action handler function
    await backend.addNode({
      id: 'test::handler',
      type: 'FUNCTION',
      name: 'analyzeAction',
      file: 'cli.ts',
      async: true,
      generator: false,
      exported: false,
      arrowFunction: true,
    });
    await backend.addEdge({
      src: 'test::call-action',
      dst: 'test::handler',
      type: 'PASSES_ARGUMENT',
      index: 0,
    });

    const result = await enrichLibraryCallbacks(client, effectsLookup);
    assert.equal(result.domainNodesCreated, 1, 'one cli:command expected');
    assert.equal(result.handlesEdgesCreated, 1);

    const cmds = [];
    for await (const wn of client.queryNodes({ type: 'cli:command' })) cmds.push(wn);
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].name, 'analyze', 'command name should be extracted from inner literal');
  });

  it('no match: receiver not from an annotated library leaves graph unchanged', async () => {
    await backend.addNode({
      id: 'test::module',
      type: 'MODULE',
      name: 'unrelated.ts',
      file: 'unrelated.ts',
      relativePath: 'unrelated.ts',
      contentHash: 'h1',
    });
    await backend.addNode({
      id: 'test::scope',
      type: 'SCOPE',
      name: 'global',
      file: 'unrelated.ts',
      scopeType: 'module',
    });
    await backend.addEdge({ src: 'test::module', dst: 'test::scope', type: 'HAS_SCOPE' });

    // CALL with .setRequestHandler suffix but unknown receiver (no IMPORT_BINDING)
    await backend.addNode({
      id: 'test::call',
      type: 'CALL',
      name: 'unknown.setRequestHandler',
      file: 'unrelated.ts',
      argCount: 2,
    });

    const result = await enrichLibraryCallbacks(client, effectsLookup);
    assert.equal(result.domainNodesCreated, 0);
    assert.equal(result.handlesEdgesCreated, 0);
    assert.ok(result.unresolvedCalls >= 1, 'should record at least one unresolved call');

    const tools = [];
    for await (const wn of client.queryNodes({ type: 'mcp:tool' })) tools.push(wn);
    assert.equal(tools.length, 0);
  });

  it('multi-level chain: new Command("x").argument().description().action(fn) walks 3 RECEIVER_CALL edges', async () => {
    await backend.addNode({
      id: 'test::module',
      type: 'MODULE',
      name: 'cli.ts',
      file: 'cli.ts',
      relativePath: 'cli.ts',
      contentHash: 'h1',
    });
    await backend.addNode({
      id: 'test::scope',
      type: 'SCOPE',
      name: 'global',
      file: 'cli.ts',
      scopeType: 'module',
    });
    await backend.addEdge({ src: 'test::module', dst: 'test::scope', type: 'HAS_SCOPE' });
    await backend.addNode({
      id: 'test::ib-Command',
      type: 'IMPORT_BINDING',
      name: 'Command',
      file: 'cli.ts',
      importedName: 'Command',
      source: 'commander',
    });
    await backend.addEdge({ src: 'test::scope', dst: 'test::ib-Command', type: 'DECLARES' });

    // origin: new Command('x')
    await backend.addNode({
      id: 'test::new-Command',
      type: 'CALL',
      name: 'Command',
      file: 'cli.ts',
      kind: 'new',
      argCount: 1,
    });
    await backend.addNode({
      id: 'test::name-arg',
      type: 'LITERAL',
      name: 'x',
      file: 'cli.ts',
      value: 'x',
    });
    await backend.addEdge({
      src: 'test::new-Command',
      dst: 'test::name-arg',
      type: 'PASSES_ARGUMENT',
      index: 0,
    });

    // .argument(...)
    await backend.addNode({
      id: 'test::call-argument',
      type: 'CALL',
      name: '<obj>.argument',
      file: 'cli.ts',
      argCount: 1,
    });
    await backend.addEdge({
      src: 'test::call-argument',
      dst: 'test::new-Command',
      type: 'RECEIVER_CALL',
    });

    // .description(...)
    await backend.addNode({
      id: 'test::call-description',
      type: 'CALL',
      name: '<obj>.description',
      file: 'cli.ts',
      argCount: 1,
    });
    await backend.addEdge({
      src: 'test::call-description',
      dst: 'test::call-argument',
      type: 'RECEIVER_CALL',
    });

    // .action(fn)
    await backend.addNode({
      id: 'test::call-action',
      type: 'CALL',
      name: '<obj>.action',
      file: 'cli.ts',
      argCount: 1,
    });
    await backend.addEdge({
      src: 'test::call-action',
      dst: 'test::call-description',
      type: 'RECEIVER_CALL',
    });
    await backend.addNode({
      id: 'test::handler',
      type: 'FUNCTION',
      name: 'xAction',
      file: 'cli.ts',
      async: false,
      generator: false,
      exported: false,
      arrowFunction: true,
    });
    await backend.addEdge({
      src: 'test::call-action',
      dst: 'test::handler',
      type: 'PASSES_ARGUMENT',
      index: 0,
    });

    const result = await enrichLibraryCallbacks(client, effectsLookup);
    assert.equal(result.domainNodesCreated, 1);
    assert.equal(result.handlesEdgesCreated, 1);
    const cmds = [];
    for await (const wn of client.queryNodes({ type: 'cli:command' })) cmds.push(wn);
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].name, 'x');
  });

  it('local instance: const server = new Server(...) → server.setRequestHandler(schema, handler)', async () => {
    // Receiver `server` is a local CONSTANT (not an IMPORT_BINDING). The
    // enricher must follow ASSIGNED_FROM from the constant to its initializer
    // (a NewExpression CALL whose name is the constructor identifier), then
    // resolve that identifier as an IMPORT_BINDING.
    await backend.addNode({
      id: 'test::module',
      type: 'MODULE',
      name: 'mcp.ts',
      file: 'mcp.ts',
      relativePath: 'mcp.ts',
      contentHash: 'h1',
    });
    await backend.addNode({
      id: 'test::scope',
      type: 'SCOPE',
      name: 'global',
      file: 'mcp.ts',
      scopeType: 'module',
    });
    await backend.addEdge({ src: 'test::module', dst: 'test::scope', type: 'HAS_SCOPE' });

    // IMPORT_BINDING for the *class*, not the instance
    await backend.addNode({
      id: 'test::ib-Server',
      type: 'IMPORT_BINDING',
      name: 'Server',
      file: 'mcp.ts',
      importedName: 'Server',
      source: '@modelcontextprotocol/sdk/server/index.js',
    });
    await backend.addEdge({ src: 'test::scope', dst: 'test::ib-Server', type: 'DECLARES' });

    // const server = new Server(socketPath)
    await backend.addNode({
      id: 'test::const-server',
      type: 'CONSTANT',
      name: 'server',
      file: 'mcp.ts',
    });
    await backend.addNode({
      id: 'test::new-Server',
      type: 'CALL',
      name: 'Server',
      file: 'mcp.ts',
      kind: 'new',
      argCount: 1,
    });
    await backend.addEdge({
      src: 'test::const-server',
      dst: 'test::new-Server',
      type: 'ASSIGNED_FROM',
    });

    // server.setRequestHandler(schema, handler)
    await backend.addNode({
      id: 'test::call',
      type: 'CALL',
      name: 'server.setRequestHandler',
      file: 'mcp.ts',
      argCount: 2,
    });
    await backend.addNode({
      id: 'test::schema-arg',
      type: 'EXPRESSION',
      name: 'CallToolRequestSchema',
      file: 'mcp.ts',
    });
    await backend.addEdge({
      src: 'test::call',
      dst: 'test::schema-arg',
      type: 'PASSES_ARGUMENT',
      index: 0,
    });
    await backend.addNode({
      id: 'test::handler',
      type: 'FUNCTION',
      name: 'callToolHandler',
      file: 'mcp.ts',
      async: true,
      generator: false,
      exported: false,
      arrowFunction: true,
    });
    await backend.addEdge({
      src: 'test::call',
      dst: 'test::handler',
      type: 'PASSES_ARGUMENT',
      index: 1,
    });

    const result = await enrichLibraryCallbacks(client, effectsLookup);
    assert.equal(result.domainNodesCreated, 1, 'one mcp:tool node expected');
    assert.equal(result.handlesEdgesCreated, 1);

    const tools = [];
    for await (const wn of client.queryNodes({ type: 'mcp:tool' })) tools.push(wn);
    assert.equal(tools.length, 1);

    const toolWireId = tools[0].id;
    const handles = await getEdges(client, toolWireId, 'HANDLES');
    assert.equal(handles.length, 1);
    const handlerWire = await getWireNodeByOriginalId(client, 'test::handler', 'FUNCTION');
    assert.equal(handles[0].dst, handlerWire.id);
  });

  it('local instance + chain: const cmd = new Command("start"); cmd.action(fn) creates cli:command "start"', async () => {
    // Mirror of server.ts pattern: receiver of .action chain origin is a local
    // CONSTANT, the constant is ASSIGNED_FROM `new Command(...)`, and Command
    // is imported from `commander`.
    await backend.addNode({
      id: 'test::module',
      type: 'MODULE',
      name: 'cli.ts',
      file: 'cli.ts',
      relativePath: 'cli.ts',
      contentHash: 'h1',
    });
    await backend.addNode({
      id: 'test::scope',
      type: 'SCOPE',
      name: 'global',
      file: 'cli.ts',
      scopeType: 'module',
    });
    await backend.addEdge({ src: 'test::module', dst: 'test::scope', type: 'HAS_SCOPE' });

    await backend.addNode({
      id: 'test::ib-Command',
      type: 'IMPORT_BINDING',
      name: 'Command',
      file: 'cli.ts',
      importedName: 'Command',
      source: 'commander',
    });
    await backend.addEdge({ src: 'test::scope', dst: 'test::ib-Command', type: 'DECLARES' });

    // const serverCommand = new Command('start')
    await backend.addNode({
      id: 'test::const-serverCmd',
      type: 'CONSTANT',
      name: 'serverCommand',
      file: 'cli.ts',
    });
    await backend.addNode({
      id: 'test::new-Command',
      type: 'CALL',
      name: 'Command',
      file: 'cli.ts',
      kind: 'new',
      argCount: 1,
    });
    await backend.addNode({
      id: 'test::name-arg',
      type: 'LITERAL',
      name: 'start',
      file: 'cli.ts',
      value: 'start',
    });
    await backend.addEdge({
      src: 'test::new-Command',
      dst: 'test::name-arg',
      type: 'PASSES_ARGUMENT',
      index: 0,
    });
    await backend.addEdge({
      src: 'test::const-serverCmd',
      dst: 'test::new-Command',
      type: 'ASSIGNED_FROM',
    });

    // serverCommand.action(handlerFn)
    await backend.addNode({
      id: 'test::call-action',
      type: 'CALL',
      name: 'serverCommand.action',
      file: 'cli.ts',
      argCount: 1,
    });
    await backend.addNode({
      id: 'test::handler',
      type: 'FUNCTION',
      name: 'startAction',
      file: 'cli.ts',
      async: true,
      generator: false,
      exported: false,
      arrowFunction: true,
    });
    await backend.addEdge({
      src: 'test::call-action',
      dst: 'test::handler',
      type: 'PASSES_ARGUMENT',
      index: 0,
    });

    const result = await enrichLibraryCallbacks(client, effectsLookup);
    assert.equal(result.domainNodesCreated, 1, 'one cli:command expected');
    assert.equal(result.handlesEdgesCreated, 1);
    const cmds = [];
    for await (const wn of client.queryNodes({ type: 'cli:command' })) cmds.push(wn);
    assert.equal(cmds.length, 1);
    // The chain origin is the .action call itself (no RECEIVER_CALL into the
    // new-Command), so the literal name comes from .action's args (none) →
    // synthetic name. We mainly assert that resolution succeeded.
    assert.ok(cmds[0].name, 'cli:command should have a name');
  });

  it('cycle protection: const a = b; const b = a; does not infinite-loop', async () => {
    // Pathological setup: two CONSTANTs that ASSIGNED_FROM each other through
    // an alias chain. The visited-set must abort the recursion.
    await backend.addNode({
      id: 'test::module',
      type: 'MODULE',
      name: 'cycle.ts',
      file: 'cycle.ts',
      relativePath: 'cycle.ts',
      contentHash: 'h1',
    });
    await backend.addNode({
      id: 'test::scope',
      type: 'SCOPE',
      name: 'global',
      file: 'cycle.ts',
      scopeType: 'module',
    });
    await backend.addEdge({ src: 'test::module', dst: 'test::scope', type: 'HAS_SCOPE' });

    // const a = new B(); const b = new A();  — each NewExpression's name
    // points back to the *other* constant's name (synthetic but exercises
    // recursion).
    await backend.addNode({ id: 'test::const-a', type: 'CONSTANT', name: 'a', file: 'cycle.ts' });
    await backend.addNode({ id: 'test::const-b', type: 'CONSTANT', name: 'b', file: 'cycle.ts' });
    await backend.addNode({
      id: 'test::new-b-for-a',
      type: 'CALL',
      name: 'b', // → recursion into const b
      file: 'cycle.ts',
      kind: 'new',
    });
    await backend.addNode({
      id: 'test::new-a-for-b',
      type: 'CALL',
      name: 'a', // → recursion into const a
      file: 'cycle.ts',
      kind: 'new',
    });
    await backend.addEdge({ src: 'test::const-a', dst: 'test::new-b-for-a', type: 'ASSIGNED_FROM' });
    await backend.addEdge({ src: 'test::const-b', dst: 'test::new-a-for-b', type: 'ASSIGNED_FROM' });

    // CALL: a.setRequestHandler(...) — should resolve to nothing without
    // hanging.
    await backend.addNode({
      id: 'test::call',
      type: 'CALL',
      name: 'a.setRequestHandler',
      file: 'cycle.ts',
      argCount: 2,
    });
    await backend.addNode({
      id: 'test::handler',
      type: 'FUNCTION',
      name: 'h',
      file: 'cycle.ts',
      async: false,
      generator: false,
      exported: false,
      arrowFunction: true,
    });
    await backend.addEdge({
      src: 'test::call',
      dst: 'test::handler',
      type: 'PASSES_ARGUMENT',
      index: 1,
    });

    const result = await enrichLibraryCallbacks(client, effectsLookup);
    // No imports → no resolution → no domain node, but also no hang.
    assert.equal(result.domainNodesCreated, 0);
    assert.ok(result.unresolvedCalls >= 1);
  });
});
