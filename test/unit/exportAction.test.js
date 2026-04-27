/**
 * Tests for the `grafema export` orchestration logic (REG-1116, REG-1118).
 *
 * Validates:
 *   - Unknown format → fail(code=2).
 *   - Format/category mismatch → fail(code=2) before touching graph.
 *   - No matches → empty document + warn on stderr (no fail).
 *   - Pattern globbing routes through to the renderer correctly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runExport } from '../../packages/cli/dist/commands/exportAction.js';

function makeBackend(nodes, edges) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return {
    async *queryNodes(query) {
      const wanted = query?.type ?? query?.nodeType ?? null;
      for (const n of nodes) {
        if (wanted && n.type !== wanted) continue;
        yield n;
      }
    },
    async getNode(id) {
      return nodeMap.get(id) ?? null;
    },
    async getOutgoingEdges(nodeId, edgeTypes) {
      return edges.filter((e) => {
        if (e.src !== nodeId) return false;
        if (edgeTypes && edgeTypes.length > 0 && !edgeTypes.includes(e.type)) return false;
        return true;
      });
    },
    async getIncomingEdges(nodeId, edgeTypes) {
      return edges.filter((e) => {
        if (e.dst !== nodeId) return false;
        if (edgeTypes && edgeTypes.length > 0 && !edgeTypes.includes(e.type)) return false;
        return true;
      });
    },
  };
}

class TestExit extends Error {
  constructor(msg, code) {
    super(msg);
    this.code = code;
  }
}

function makeDeps(backend) {
  const writes = [];
  const warns = [];
  const fails = [];
  return {
    deps: {
      backend,
      writeText: (path, text) => {
        writes.push({ path, text });
      },
      warn: (msg) => {
        warns.push(msg);
      },
      fail: (msg, code) => {
        fails.push({ msg, code });
        throw new TestExit(msg, code);
      },
    },
    writes,
    warns,
    fails,
  };
}

function httpGraph() {
  const nodes = [
    { id: 'feat:http:get', type: 'http:route', name: 'getUser', file: 'r.ts' },
    {
      id: 'feat:http:get::sc',
      type: 'SPECED_CONTRACT',
      name: 'getUser',
      file: 'r.ts',
      source: 'http-route',
      inputs: [{ name: 'id', type: 'string', optional: false }],
      outputs: [{ description: 'GET /users/:id' }],
      errors: [],
    },
  ];
  const edges = [{ src: 'feat:http:get', dst: 'feat:http:get::sc', type: 'HAS_SPECED_CONTRACT' }];
  return makeBackend(nodes, edges);
}

function mixedGraph() {
  const nodes = [
    { id: 'feat:cli:analyze', type: 'cli:command', name: 'analyze', file: 'a.ts' },
    {
      id: 'feat:cli:analyze::sc',
      type: 'SPECED_CONTRACT',
      name: 'analyze',
      file: 'a.ts',
      source: 'commander',
      inputs: [{ name: '-v', type: 'boolean', optional: true }],
      outputs: [],
      errors: [],
    },
    { id: 'feat:http:get', type: 'http:route', name: 'getUser', file: 'r.ts' },
    {
      id: 'feat:http:get::sc',
      type: 'SPECED_CONTRACT',
      name: 'getUser',
      file: 'r.ts',
      source: 'http-route',
      inputs: [{ name: 'id', type: 'string', optional: false }],
      outputs: [{ description: 'GET /users/:id' }],
      errors: [],
    },
  ];
  const edges = [
    { src: 'feat:cli:analyze', dst: 'feat:cli:analyze::sc', type: 'HAS_SPECED_CONTRACT' },
    { src: 'feat:http:get', dst: 'feat:http:get::sc', type: 'HAS_SPECED_CONTRACT' },
  ];
  return makeBackend(nodes, edges);
}

describe('runExport', () => {
  it('unknown format → fail with exit code 2', async () => {
    const { deps, fails } = makeDeps(httpGraph());
    await assert.rejects(
      runExport({ feature: 'http:*', as: 'totally-bogus-format' }, deps),
      (err) => err instanceof TestExit && err.code === 2,
    );
    assert.equal(fails.length, 1);
    assert.match(fails[0].msg, /Unknown format/);
  });

  it("format/category mismatch (cli:* with openapi-3.1) → fail before graph work", async () => {
    const { deps, fails } = makeDeps(mixedGraph());
    await assert.rejects(
      runExport({ feature: 'cli:*', as: 'openapi-3.1' }, deps),
      (err) => err instanceof TestExit && err.code === 2,
    );
    assert.match(fails[0].msg, /does not support category 'cli:command'/);
  });

  it('http:* with openapi-3.1 → renders OpenAPI doc, writes to stdout', async () => {
    const { deps, writes, warns } = makeDeps(httpGraph());
    const text = await runExport({ feature: 'http:*', as: 'openapi-3.1' }, deps);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, null, 'no --output → stdout');
    assert.match(text, /openapi: 3\.1\.0/);
    assert.match(text, /\/users\/\{id\}/);
    assert.equal(warns.length, 0);
  });

  it('cli:* with docs-md → multi-feature document', async () => {
    const { deps, writes } = makeDeps(mixedGraph());
    const text = await runExport({ feature: 'cli:*', as: 'docs-md' }, deps);
    assert.match(text, /## `cli:command` `analyze`/);
    assert.equal(writes.length, 1);
  });

  it("single-feature mode cli:command:'analyze' with docs-md → only that section", async () => {
    const { deps } = makeDeps(mixedGraph());
    const text = await runExport(
      { feature: "cli:command:'analyze'", as: 'docs-md' },
      deps,
    );
    assert.match(text, /## `cli:command` `analyze`/);
    // No top-level catalogue header in single-feature mode.
    assert.doesNotMatch(text, /^# Grafema feature catalogue/m);
    // Other features (e.g. getUser) must NOT appear.
    assert.doesNotMatch(text, /getUser/);
  });

  it('no features matched → renders empty doc + warn (no fail)', async () => {
    const { deps, warns, fails } = makeDeps(httpGraph());
    const text = await runExport(
      { feature: 'cli:command:does_not_exist', as: 'docs-md' },
      deps,
    );
    assert.equal(fails.length, 0);
    assert.ok(warns.some((m) => /No features matched/.test(m)));
    assert.match(text, /Grafema feature catalogue/);
  });

  it('output path passed through to writeText', async () => {
    const { deps, writes } = makeDeps(httpGraph());
    await runExport(
      { feature: 'http:*', as: 'openapi-3.1', output: '/tmp/api.yaml' },
      deps,
    );
    assert.equal(writes[0].path, '/tmp/api.yaml');
  });
});
