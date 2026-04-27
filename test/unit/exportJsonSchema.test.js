/**
 * Tests for the json-schema renderer (REG-1116 Phase 2).
 *
 * Validates:
 *   - supports() accepts every category
 *   - single feature emits the schema document directly
 *   - multiple features emit a JSON object keyed by FEATURE id
 *   - missing-contract features get a stub schema with x-grafema.note
 *   - x-grafema extension carries category, source, outputs, errors
 *   - properties carry { type, description?, default? }
 *   - required[] tracks `optional === false` inputs
 *   - $schema points at Draft 2020-12, $id is grafema:// URI
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { jsonSchemaRenderer } from '@grafema/util/exporters/jsonSchema';

function makeSnapshot(overrides = {}) {
  return {
    id: 'feat:cli:command:analyze',
    category: 'cli:command',
    name: 'analyze',
    file: 'src/cli.ts',
    contracts: [],
    sharedBehaviorWith: [],
    ...overrides,
  };
}

describe('jsonSchemaRenderer.supports', () => {
  it('accepts every category (universal renderer)', () => {
    assert.equal(jsonSchemaRenderer.supports('cli:command'), true);
    assert.equal(jsonSchemaRenderer.supports('mcp:tool'), true);
    assert.equal(jsonSchemaRenderer.supports('http:route'), true);
    assert.equal(jsonSchemaRenderer.supports('vscode:command'), true);
    assert.equal(jsonSchemaRenderer.supports('package:export'), true);
    assert.equal(jsonSchemaRenderer.supports('anything:else'), true);
  });
});

describe('jsonSchemaRenderer.render — single feature', () => {
  it('emits the schema directly (no id-keyed wrapper)', () => {
    const snap = makeSnapshot({
      contracts: [
        {
          source: 'commander',
          inputs: [
            {
              name: '--project',
              type: 'string',
              optional: false,
              description: 'Project root',
              default: '.',
            },
            { name: '--verbose', type: 'boolean', optional: true },
          ],
          outputs: [{ description: 'Run analysis' }],
          errors: [{ type: 'AnalysisError', description: 'thrown on failure' }],
        },
      ],
    });

    const out = jsonSchemaRenderer.render([snap]);
    const parsed = JSON.parse(out);

    // No id-keyed wrapper — schema is at top level.
    assert.equal(parsed.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(parsed.$id, 'grafema://feature/feat:cli:command:analyze');
    assert.equal(parsed.title, 'analyze');
    assert.equal(parsed.type, 'object');

    assert.deepEqual(parsed.properties['--project'], {
      type: 'string',
      description: 'Project root',
      default: '.',
    });
    assert.deepEqual(parsed.properties['--verbose'], { type: 'boolean' });
    assert.deepEqual(parsed.required, ['--project']);

    // x-grafema extension preserves category-specific info.
    assert.equal(parsed['x-grafema'].category, 'cli:command');
    assert.equal(parsed['x-grafema'].source, 'commander');
    assert.deepEqual(parsed['x-grafema'].outputs, [{ description: 'Run analysis' }]);
    assert.deepEqual(parsed['x-grafema'].errors, [
      { type: 'AnalysisError', description: 'thrown on failure' },
    ]);
  });

  it('missing-contract feature → stub schema with x-grafema.note', () => {
    const snap = makeSnapshot({ contracts: [] });
    const out = jsonSchemaRenderer.render([snap]);
    const parsed = JSON.parse(out);

    assert.deepEqual(parsed.properties, {});
    assert.deepEqual(parsed.required, []);
    assert.equal(parsed['x-grafema'].category, 'cli:command');
    assert.equal(parsed['x-grafema'].note, 'no recovered contract');
    assert.equal(parsed['x-grafema'].source, undefined);
  });
});

describe('jsonSchemaRenderer.render — multiple features', () => {
  it('emits object keyed by FEATURE id', () => {
    const a = makeSnapshot({
      id: 'feat:cli:command:analyze',
      name: 'analyze',
      contracts: [
        {
          source: 'commander',
          inputs: [{ name: '--project', type: 'string', optional: false }],
          outputs: [],
          errors: [],
        },
      ],
    });
    const b = makeSnapshot({
      id: 'feat:mcp:tool:query',
      category: 'mcp:tool',
      name: 'query',
      contracts: [
        {
          source: 'mcp-inputSchema',
          inputs: [{ name: 'q', type: 'string', optional: false }],
          outputs: [{ description: 'Run query' }],
          errors: [],
        },
      ],
    });

    const out = jsonSchemaRenderer.render([a, b]);
    const parsed = JSON.parse(out);

    assert.ok('feat:cli:command:analyze' in parsed);
    assert.ok('feat:mcp:tool:query' in parsed);

    assert.equal(parsed['feat:cli:command:analyze'].title, 'analyze');
    assert.equal(parsed['feat:cli:command:analyze']['x-grafema'].category, 'cli:command');
    assert.equal(parsed['feat:mcp:tool:query']['x-grafema'].source, 'mcp-inputSchema');
    assert.deepEqual(parsed['feat:mcp:tool:query']['x-grafema'].outputs, [
      { description: 'Run query' },
    ]);
  });

  it('mixed contract / no-contract features in multi-feature mode', () => {
    const withC = makeSnapshot({
      id: 'feat:a',
      contracts: [
        {
          source: 'commander',
          inputs: [],
          outputs: [],
          errors: [],
        },
      ],
    });
    const naked = makeSnapshot({ id: 'feat:b', contracts: [] });

    const out = jsonSchemaRenderer.render([withC, naked]);
    const parsed = JSON.parse(out);

    assert.equal(parsed['feat:a']['x-grafema'].source, 'commander');
    assert.equal(parsed['feat:b']['x-grafema'].note, 'no recovered contract');
  });

  it('empty snapshot list → empty JSON object', () => {
    const out = jsonSchemaRenderer.render([]);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, {});
  });

  it('output is pretty-printed JSON', () => {
    const snap = makeSnapshot({ contracts: [] });
    const out = jsonSchemaRenderer.render([snap]);
    assert.ok(out.endsWith('\n'));
    assert.match(out, /\n  "/);
  });
});

describe('jsonSchemaRenderer.render — v2 fields', () => {
  it('top-level contract.description maps to schema-level description', () => {
    const snap = makeSnapshot({
      contracts: [
        {
          source: 'commander',
          description: 'Build the project',
          inputs: [{ name: 'input', type: 'string', optional: false }],
          outputs: [],
          errors: [],
        },
      ],
    });
    const out = jsonSchemaRenderer.render([snap]);
    const parsed = JSON.parse(out);
    assert.equal(parsed.description, 'Build the project');
  });

  it('input validation fields (enum/format/min/max/pattern) are forwarded', () => {
    const snap = makeSnapshot({
      contracts: [
        {
          source: 'mcp-inputSchema',
          inputs: [
            {
              name: 'role',
              type: 'string',
              optional: false,
              enum: ['admin', 'user'],
              format: 'email',
              minLength: 2,
              maxLength: 32,
              pattern: '^[a-z]+$',
            },
            { name: 'age', type: 'integer', optional: true, minimum: 0, maximum: 150 },
          ],
          outputs: [],
          errors: [],
        },
      ],
    });
    const out = jsonSchemaRenderer.render([snap]);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.properties.role.enum, ['admin', 'user']);
    assert.equal(parsed.properties.role.format, 'email');
    assert.equal(parsed.properties.role.minLength, 2);
    assert.equal(parsed.properties.role.maxLength, 32);
    assert.equal(parsed.properties.role.pattern, '^[a-z]+$');
    assert.equal(parsed.properties.age.minimum, 0);
    assert.equal(parsed.properties.age.maximum, 150);
  });
});
