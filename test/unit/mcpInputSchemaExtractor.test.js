/**
 * Tests for mcpInputSchemaExtractor (REG-1113).
 *
 * The extractor reads an mcp:tool FEATURE node's `metadata.definition_file`,
 * locates the tool's inputSchema literal in that file, and converts it to a
 * SpecedContractData with `source: 'mcp-inputSchema'`. Tools created without
 * a definition_file (e.g. by libraryCallbackEnricher's setRequestHandler
 * scrape) return null.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mcpInputSchemaExtractor } from '@grafema/util/enrichers/extractors/mcpInputSchemaExtractor';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(async () => {
  await cleanupAllTestDatabases();
});

/**
 * Build a synthetic *-tools.ts source string from a concise description. Each
 * entry is rendered with exactly the indentation expected by the extractor's
 * regex anchors (4-space top-level fields).
 */
function buildToolsFile(entries) {
  const lines = [
    "import type { ToolDefinition } from './types.js';",
    '',
    'export const TEST_TOOLS: ToolDefinition[] = [',
  ];
  for (const e of entries) {
    lines.push('  {');
    lines.push(`    name: '${e.name}',`);
    lines.push(`    description: '${e.description ?? 'desc'}',`);
    lines.push(`    inputSchema: ${e.inputSchemaLiteral},`);
    lines.push('  },');
  }
  lines.push('];');
  lines.push('');
  return lines.join('\n');
}

/** Seed a single mcp:tool node with the given definition_file metadata. */
async function seedMcpTool(backend, { id, name, file, definitionFile }) {
  await backend.addNode({
    id: `${file}::module`,
    type: 'MODULE',
    name: file,
    file,
    relativePath: file,
    contentHash: 'h1',
  });
  const meta = { definition_file: definitionFile };
  await backend.addNode({
    id,
    type: 'mcp:tool',
    name,
    file,
    exported: false,
    metadata: JSON.stringify(meta),
  });
}

/** Find the wire node we just inserted by its originalId. */
async function findWireByOriginalId(client, originalId, type) {
  for await (const wn of client.queryNodes({ type })) {
    let m = {};
    try { m = wn.metadata ? JSON.parse(wn.metadata) : {}; } catch { /* empty */ }
    if (m.originalId === originalId) return wn;
  }
  return null;
}

describe('mcpInputSchemaExtractor', () => {
  /** @type {Awaited<ReturnType<typeof createTestDatabase>>} */
  let db;
  /** @type {any} */ let backend;
  /** @type {any} */ let client;
  /** @type {string} */ let defsDir;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
    client = backend.client;
    defsDir = mkdtempSync(join(tmpdir(), 'mcp-extractor-'));
  });

  after(() => {
    if (defsDir) rmSync(defsDir, { recursive: true, force: true });
  });

  it('exposes category="mcp:tool" and source="mcp-inputSchema"', () => {
    assert.equal(mcpInputSchemaExtractor.category, 'mcp:tool');
    assert.equal(mcpInputSchemaExtractor.source, 'mcp-inputSchema');
  });

  it('1) simple inputSchema with one required string field → 1 input, optional=false', async () => {
    const file = join(defsDir, 'graph-tools.ts');
    writeFileSync(file, buildToolsFile([
      {
        name: 'get_node',
        inputSchemaLiteral: `{
      type: 'object',
      properties: {
        semanticId: { type: 'string', description: 'Node id' },
      },
      required: ['semanticId'],
    }`,
      },
    ]));

    await seedMcpTool(backend, {
      id: 'test::tool::get_node',
      name: 'get_node',
      file: 'src/dummy.ts',
      definitionFile: file,
    });
    const wire = await findWireByOriginalId(client, 'test::tool::get_node', 'mcp:tool');
    assert.ok(wire);

    const data = await mcpInputSchemaExtractor.extract(client, wire);
    assert.ok(data, 'should return SpecedContractData');
    assert.equal(data.source, 'mcp-inputSchema');
    assert.equal(data.inputs.length, 1);
    assert.deepEqual(data.inputs[0], {
      name: 'semanticId',
      type: 'string',
      optional: false,
      description: 'Node id',
    });
    assert.deepEqual(data.outputs, []);
    assert.deepEqual(data.errors, []);
  });

  it('2) mixed required + optional fields → correct optional flags', async () => {
    const file = join(defsDir, 'mixed-tools.ts');
    writeFileSync(file, buildToolsFile([
      {
        name: 'mixed',
        inputSchemaLiteral: `{
      type: 'object',
      properties: {
        a: { type: 'string', description: 'A required' },
        b: { type: 'string', description: 'B optional' },
        c: { type: 'string' },
      },
      required: ['a', 'c'],
    }`,
      },
    ]));

    await seedMcpTool(backend, {
      id: 'test::tool::mixed',
      name: 'mixed',
      file: 'src/dummy.ts',
      definitionFile: file,
    });
    const wire = await findWireByOriginalId(client, 'test::tool::mixed', 'mcp:tool');
    const data = await mcpInputSchemaExtractor.extract(client, wire);
    assert.ok(data);
    const byName = Object.fromEntries(data.inputs.map(i => [i.name, i]));
    assert.equal(byName.a.optional, false);
    assert.equal(byName.b.optional, true);
    assert.equal(byName.c.optional, false);
  });

  it('3) field types string/number/boolean/array/object → mapped types', async () => {
    const file = join(defsDir, 'types-tools.ts');
    writeFileSync(file, buildToolsFile([
      {
        name: 'types_demo',
        inputSchemaLiteral: `{
      type: 'object',
      properties: {
        s: { type: 'string' },
        n: { type: 'number' },
        b: { type: 'boolean' },
        a: { type: 'array' },
        o: { type: 'object' },
      },
    }`,
      },
    ]));

    await seedMcpTool(backend, {
      id: 'test::tool::types',
      name: 'types_demo',
      file: 'src/dummy.ts',
      definitionFile: file,
    });
    const wire = await findWireByOriginalId(client, 'test::tool::types', 'mcp:tool');
    const data = await mcpInputSchemaExtractor.extract(client, wire);
    assert.ok(data);
    const byName = Object.fromEntries(data.inputs.map(i => [i.name, i.type]));
    assert.deepEqual(byName, {
      s: 'string',
      n: 'number',
      b: 'boolean',
      a: 'array',
      o: 'object',
    });
    // No `required` → all optional.
    for (const i of data.inputs) assert.equal(i.optional, true);
  });

  it('4) default values are carried into input', async () => {
    const file = join(defsDir, 'defaults-tools.ts');
    writeFileSync(file, buildToolsFile([
      {
        name: 'with_defaults',
        inputSchemaLiteral: `{
      type: 'object',
      properties: {
        limit: { type: 'number', default: 100 },
        verbose: { type: 'boolean', default: false },
        tag: { type: 'string', default: 'main' },
      },
    }`,
      },
    ]));

    await seedMcpTool(backend, {
      id: 'test::tool::defaults',
      name: 'with_defaults',
      file: 'src/dummy.ts',
      definitionFile: file,
    });
    const wire = await findWireByOriginalId(client, 'test::tool::defaults', 'mcp:tool');
    const data = await mcpInputSchemaExtractor.extract(client, wire);
    assert.ok(data);
    const byName = Object.fromEntries(data.inputs.map(i => [i.name, i]));
    assert.equal(byName.limit.default, 100);
    assert.equal(byName.verbose.default, false);
    assert.equal(byName.tag.default, 'main');
  });

  it('5) tool with no inputSchema in source → returns null', async () => {
    // Source has the tool name but no inputSchema field.
    const file = join(defsDir, 'no-schema-tools.ts');
    writeFileSync(
      file,
      [
        'export const TEST_TOOLS: ToolDefinition[] = [',
        '  {',
        "    name: 'no_schema_tool',",
        "    description: 'no schema here',",
        '  },',
        '];',
        '',
      ].join('\n'),
    );

    await seedMcpTool(backend, {
      id: 'test::tool::noschema',
      name: 'no_schema_tool',
      file: 'src/dummy.ts',
      definitionFile: file,
    });
    const wire = await findWireByOriginalId(client, 'test::tool::noschema', 'mcp:tool');
    const data = await mcpInputSchemaExtractor.extract(client, wire);
    assert.equal(data, null);
  });

  it('6) empty properties: {} → empty inputs but still returns a contract', async () => {
    const file = join(defsDir, 'empty-tools.ts');
    writeFileSync(file, buildToolsFile([
      {
        name: 'empty_input',
        inputSchemaLiteral: `{
      type: 'object',
      properties: {},
    }`,
      },
    ]));

    await seedMcpTool(backend, {
      id: 'test::tool::empty',
      name: 'empty_input',
      file: 'src/dummy.ts',
      definitionFile: file,
    });
    const wire = await findWireByOriginalId(client, 'test::tool::empty', 'mcp:tool');
    const data = await mcpInputSchemaExtractor.extract(client, wire);
    assert.ok(data, 'empty properties must still yield a contract');
    assert.equal(data.source, 'mcp-inputSchema');
    assert.deepEqual(data.inputs, []);
    assert.deepEqual(data.outputs, []);
    assert.deepEqual(data.errors, []);
  });

  it('7) nested object property → flat shape only, type rendered as object', async () => {
    const file = join(defsDir, 'nested-tools.ts');
    writeFileSync(file, buildToolsFile([
      {
        name: 'nested',
        inputSchemaLiteral: `{
      type: 'object',
      properties: {
        config: {
          type: 'object',
          description: 'Nested config block',
          properties: {
            host: { type: 'string' },
            port: { type: 'number' },
          },
          required: ['host'],
        },
      },
      required: ['config'],
    }`,
      },
    ]));

    await seedMcpTool(backend, {
      id: 'test::tool::nested',
      name: 'nested',
      file: 'src/dummy.ts',
      definitionFile: file,
    });
    const wire = await findWireByOriginalId(client, 'test::tool::nested', 'mcp:tool');
    const data = await mcpInputSchemaExtractor.extract(client, wire);
    assert.ok(data);
    assert.equal(data.inputs.length, 1, 'no recursion into nested properties');
    assert.equal(data.inputs[0].name, 'config');
    assert.equal(data.inputs[0].type, 'object');
    assert.equal(data.inputs[0].optional, false);
    assert.equal(data.inputs[0].description, 'Nested config block');
  });

  it('8) tool created without definition_file (libraryCallbackEnricher style) returns null gracefully', async () => {
    // No definition_file in metadata — simulates the four high-level
    // setRequestHandler features produced by libraryCallbackEnricher.
    await backend.addNode({
      id: `src/dummy.ts::module`,
      type: 'MODULE',
      name: 'src/dummy.ts',
      file: 'src/dummy.ts',
      relativePath: 'src/dummy.ts',
      contentHash: 'h1',
    });
    await backend.addNode({
      id: 'test::tool::libcb',
      type: 'mcp:tool',
      name: 'list_tools',
      file: 'src/dummy.ts',
      exported: false,
      metadata: JSON.stringify({
        library: '@modelcontextprotocol/sdk',
        method: 'Server.setRequestHandler',
        anchorCall: 'cid::1',
      }),
    });

    const wire = await findWireByOriginalId(client, 'test::tool::libcb', 'mcp:tool');
    assert.ok(wire);
    const data = await mcpInputSchemaExtractor.extract(client, wire);
    assert.equal(data, null);
  });

  it('handles template literal interpolations in description (e.g. ${DEFAULT_LIMIT})', async () => {
    // Extra coverage: real *-tools.ts files use template literals with
    // imported constants. The extractor must not choke on them.
    const file = join(defsDir, 'tpl-tools.ts');
    writeFileSync(
      file,
      [
        "import { DEFAULT_LIMIT, MAX_LIMIT } from '../utils.js';",
        '',
        'export const TEST_TOOLS: ToolDefinition[] = [',
        '  {',
        "    name: 'tpl_tool',",
        "    description: 'desc',",
        '    inputSchema: {',
        "      type: 'object',",
        '      properties: {',
        '        limit: {',
        "          type: 'number',",
        '          description: `Max results (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,',
        '        },',
        '      },',
        "      required: ['limit'],",
        '    },',
        '  },',
        '];',
        '',
      ].join('\n'),
    );

    await seedMcpTool(backend, {
      id: 'test::tool::tpl',
      name: 'tpl_tool',
      file: 'src/dummy.ts',
      definitionFile: file,
    });
    const wire = await findWireByOriginalId(client, 'test::tool::tpl', 'mcp:tool');
    const data = await mcpInputSchemaExtractor.extract(client, wire);
    assert.ok(data, 'should not fail on template-literal interpolation');
    assert.equal(data.inputs.length, 1);
    assert.equal(data.inputs[0].name, 'limit');
    assert.equal(data.inputs[0].type, 'number');
    assert.equal(data.inputs[0].optional, false);
    assert.match(data.inputs[0].description ?? '', /Max results/);
  });

  it('returns null when definition_file does not exist on disk', async () => {
    await seedMcpTool(backend, {
      id: 'test::tool::missing',
      name: 'something',
      file: 'src/dummy.ts',
      definitionFile: '/nonexistent/path/missing-tools.ts',
    });
    const wire = await findWireByOriginalId(client, 'test::tool::missing', 'mcp:tool');
    const data = await mcpInputSchemaExtractor.extract(client, wire);
    assert.equal(data, null);
  });
});
