/**
 * Tests for openapi-3.1 renderer (REG-1116).
 *
 * Validates that http:route SpecedContracts are emitted as a structurally
 * valid OpenAPI 3.1 paths object: openapi version, paths/methods/parameters
 * mapped from route + path params; non-supported categories rejected by
 * `supports`.
 *
 * We assert structurally on the emitted YAML text via targeted matchers
 * rather than parsing — keeps the test root free of an extra YAML parser
 * dependency and the assertions are still precise.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openapiRenderer } from '@grafema/util/exporters/openapi';

function snapshot(overrides = {}) {
  return {
    id: 'feat:http:get-user',
    category: 'http:route',
    name: 'getUser',
    file: 'r.ts',
    contracts: [
      {
        source: 'http-route',
        inputs: [
          { name: 'id', type: 'string', optional: false, description: 'Path parameter from route' },
        ],
        outputs: [{ description: 'GET /users/:id' }],
        errors: [],
      },
    ],
    behavior: undefined,
    sharedBehaviorWith: [],
    ...overrides,
  };
}

/**
 * Extract the top-level paths object indices: returns the list of
 * "path → method" pairs that appear in the emitted YAML.
 */
function listOps(text) {
  const lines = text.split('\n');
  const ops = [];
  let inPaths = false;
  let currentPath = null;
  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^[A-Za-z]/.test(line)) break;
    const pathMatch = line.match(/^ {2}(\S+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1].replace(/^"|"$/g, '');
      continue;
    }
    const methodMatch = line.match(/^ {4}([a-z]+):\s*$/);
    if (methodMatch && currentPath) {
      ops.push({ path: currentPath, method: methodMatch[1] });
    }
  }
  return ops;
}

describe('openapiRenderer', () => {
  it('format identifier and category support', () => {
    assert.equal(openapiRenderer.format, 'openapi-3.1');
    assert.equal(openapiRenderer.supports('http:route'), true);
    assert.equal(openapiRenderer.supports('cli:command'), false);
    assert.equal(openapiRenderer.supports('mcp:tool'), false);
  });

  it('empty snapshots → minimal valid spec with empty paths', () => {
    const text = openapiRenderer.render([]);
    assert.match(text, /^openapi: 3\.1\.0/);
    assert.match(text, /^paths: \{\}/m);
  });

  it('single GET /users/:id route → valid path object', () => {
    const text = openapiRenderer.render([snapshot()]);
    assert.match(text, /^openapi: 3\.1\.0/);
    const ops = listOps(text);
    assert.deepEqual(ops, [{ path: '/users/{id}', method: 'get' }]);
    // Operation contents.
    assert.match(text, /operationId: getUser/);
    assert.match(text, /summary: "?GET \/users\/:id"?/);
    assert.match(text, /- name: id/);
    assert.match(text, /in: path/);
    assert.match(text, /required: true/);
    assert.match(text, /schema: \{ type: string \}/);
    assert.match(text, /'200':\s+description: Successful response/);
  });

  it('multiple methods on same path are grouped', () => {
    const get = snapshot({ name: 'getUser' });
    const post = snapshot({
      id: 'feat:http:post-user',
      name: 'postUser',
      contracts: [
        {
          source: 'http-route',
          inputs: [{ name: 'id', type: 'string', optional: false }],
          outputs: [{ description: 'POST /users/:id' }],
          errors: [],
        },
      ],
    });
    const text = openapiRenderer.render([get, post]);
    const ops = listOps(text);
    assert.deepEqual(
      ops.sort((a, b) => a.method.localeCompare(b.method)),
      [
        { path: '/users/{id}', method: 'get' },
        { path: '/users/{id}', method: 'post' },
      ],
    );
  });

  it('non-http snapshots are silently dropped', () => {
    const cli = snapshot({
      id: 'feat:cli:foo',
      category: 'cli:command',
      name: 'foo',
      contracts: [
        { source: 'commander', inputs: [], outputs: [], errors: [] },
      ],
    });
    const text = openapiRenderer.render([cli]);
    assert.match(text, /^paths: \{\}/m);
  });

  it('routes with no recoverable summary are skipped', () => {
    const broken = snapshot({
      contracts: [
        {
          source: 'http-route',
          inputs: [],
          outputs: [], // no summary
          errors: [],
        },
      ],
    });
    const text = openapiRenderer.render([broken]);
    assert.match(text, /^paths: \{\}/m);
  });

  it('wildcard paths convert *wildcard correctly', () => {
    const wild = snapshot({
      contracts: [
        {
          source: 'http-route',
          inputs: [{ name: 'rest', type: 'string', optional: true }],
          outputs: [{ description: 'GET /files/*rest' }],
          errors: [],
        },
      ],
    });
    const text = openapiRenderer.render([wild]);
    const ops = listOps(text);
    assert.deepEqual(ops, [{ path: '/files/{rest}', method: 'get' }]);
  });

  it('optional path params still emit required: true (OpenAPI invariant)', () => {
    const opt = snapshot({
      contracts: [
        {
          source: 'http-route',
          inputs: [{ name: 'id', type: 'string', optional: true }],
          outputs: [{ description: 'GET /users/:id?' }],
          errors: [],
        },
      ],
    });
    const text = openapiRenderer.render([opt]);
    assert.match(text, /required: true/);
  });
});
