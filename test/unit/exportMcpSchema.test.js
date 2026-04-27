/**
 * Tests for the mcp-schema renderer (REG-1116 Phase 2).
 *
 * Validates:
 *   - supports() restricts to mcp:tool category
 *   - single mcp:tool with required+optional inputs renders correctly
 *   - features without a contract are skipped
 *   - non-mcp:tool snapshots are filtered out by render() too
 *   - description sourced from contract.outputs[0].description
 *   - output is pretty-printed JSON parseable as { tools: [...] }
 *   - feature.name with surrounding quotes is unwrapped
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mcpSchemaRenderer } from '@grafema/util/exporters/mcpSchema';

function makeSnapshot(overrides = {}) {
  return {
    id: 'feat:mcp:tool:query_decisions',
    category: 'mcp:tool',
    name: 'query_decisions',
    file: 'src/server.ts',
    contracts: [],
    sharedBehaviorWith: [],
    ...overrides,
  };
}

describe('mcpSchemaRenderer.supports', () => {
  it('returns true only for mcp:tool', () => {
    assert.equal(mcpSchemaRenderer.supports('mcp:tool'), true);
    assert.equal(mcpSchemaRenderer.supports('cli:command'), false);
    assert.equal(mcpSchemaRenderer.supports('http:route'), false);
    assert.equal(mcpSchemaRenderer.supports('vscode:command'), false);
  });
});

describe('mcpSchemaRenderer.render', () => {
  it('renders a single mcp:tool with required + optional fields', () => {
    const snap = makeSnapshot({
      contracts: [
        {
          source: 'mcp-inputSchema',
          inputs: [
            { name: 'module', type: 'string', optional: false, description: 'Module address' },
            { name: 'status', type: 'string', optional: true, description: 'Filter by status' },
          ],
          outputs: [{ description: 'Find decisions for a module' }],
          errors: [],
        },
      ],
    });

    const out = mcpSchemaRenderer.render([snap]);
    const parsed = JSON.parse(out);

    assert.equal(parsed.tools.length, 1);
    const tool = parsed.tools[0];
    assert.equal(tool.name, 'query_decisions');
    assert.equal(tool.description, 'Find decisions for a module');
    assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(tool.inputSchema.properties.module, {
      type: 'string',
      description: 'Module address',
    });
    assert.deepEqual(tool.inputSchema.properties.status, {
      type: 'string',
      description: 'Filter by status',
    });
    assert.deepEqual(tool.inputSchema.required, ['module']);
  });

  it('skips features that have no contract attached', () => {
    const withContract = makeSnapshot({
      id: 'feat:mcp:tool:has',
      name: 'has',
      contracts: [
        {
          source: 'mcp-inputSchema',
          inputs: [{ name: 'q', type: 'string', optional: false }],
          outputs: [{ description: 'Has contract' }],
          errors: [],
        },
      ],
    });
    const noContract = makeSnapshot({
      id: 'feat:mcp:tool:naked',
      name: 'naked',
      contracts: [],
    });

    const out = mcpSchemaRenderer.render([withContract, noContract]);
    const parsed = JSON.parse(out);
    assert.equal(parsed.tools.length, 1);
    assert.equal(parsed.tools[0].name, 'has');
  });

  it('filters non-mcp:tool snapshots if they slip through', () => {
    // Defensive — orchestrator validates supports() but render() should not
    // emit a tool entry for an http:route even if it gets one.
    const wrongCategory = makeSnapshot({
      category: 'http:route',
      name: 'getUser',
      contracts: [
        {
          source: 'http-route',
          inputs: [],
          outputs: [{ description: 'GET /users/:id' }],
          errors: [],
        },
      ],
    });
    const out = mcpSchemaRenderer.render([wrongCategory]);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.tools, []);
  });

  it('output is pretty-printed JSON with 2-space indent', () => {
    const out = mcpSchemaRenderer.render([
      makeSnapshot({
        contracts: [
          {
            source: 'mcp-inputSchema',
            inputs: [{ name: 'x', type: 'string', optional: false }],
            outputs: [{ description: 'demo' }],
            errors: [],
          },
        ],
      }),
    ]);
    // Pretty-printing: contains newlines and 2-space indent at first level.
    assert.match(out, /\n  "tools"/);
    assert.ok(out.endsWith('\n'));
  });

  it('strips surrounding quotes from feature name', () => {
    const snap = makeSnapshot({
      name: "'analyze'",
      contracts: [
        {
          source: 'mcp-inputSchema',
          inputs: [],
          outputs: [{ description: 'd' }],
          errors: [],
        },
      ],
    });
    const out = mcpSchemaRenderer.render([snap]);
    const parsed = JSON.parse(out);
    assert.equal(parsed.tools[0].name, 'analyze');
  });

  it('prefers mcp-inputSchema over other contract sources', () => {
    const snap = makeSnapshot({
      contracts: [
        {
          source: 'function-signature',
          inputs: [{ name: 'fallback', type: 'string', optional: false }],
          outputs: [{ description: 'fallback desc' }],
          errors: [],
        },
        {
          source: 'mcp-inputSchema',
          inputs: [{ name: 'preferred', type: 'string', optional: false }],
          outputs: [{ description: 'preferred desc' }],
          errors: [],
        },
      ],
    });
    const out = mcpSchemaRenderer.render([snap]);
    const parsed = JSON.parse(out);
    const tool = parsed.tools[0];
    assert.equal(tool.description, 'preferred desc');
    assert.ok('preferred' in tool.inputSchema.properties);
    assert.ok(!('fallback' in tool.inputSchema.properties));
  });

  it('empty snapshot list → empty tools array', () => {
    const out = mcpSchemaRenderer.render([]);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, { tools: [] });
  });

  it('v2: tool description read from top-level contract.description', () => {
    const snap = makeSnapshot({
      contracts: [
        {
          source: 'mcp-inputSchema',
          description: 'top-level v2 description',
          inputs: [{ name: 'q', type: 'string', optional: false }],
          // outputs intentionally empty — v2 sources stop using the workaround.
          outputs: [],
          errors: [],
        },
      ],
    });
    const out = mcpSchemaRenderer.render([snap]);
    const parsed = JSON.parse(out);
    assert.equal(parsed.tools[0].description, 'top-level v2 description');
  });

  it('v2: input enum / format / validation pass through into property schema', () => {
    const snap = makeSnapshot({
      contracts: [
        {
          source: 'mcp-inputSchema',
          description: 'd',
          inputs: [
            {
              name: 'kind',
              type: 'string',
              optional: false,
              enum: ['cli', 'mcp'],
              format: 'email',
              minLength: 3,
              maxLength: 30,
              pattern: '^[a-z]+$',
            },
            { name: 'age', type: 'integer', optional: true, minimum: 0, maximum: 150, default: 18 },
          ],
          outputs: [],
          errors: [],
        },
      ],
    });
    const out = mcpSchemaRenderer.render([snap]);
    const parsed = JSON.parse(out);
    const props = parsed.tools[0].inputSchema.properties;
    assert.deepEqual(props.kind.enum, ['cli', 'mcp']);
    assert.equal(props.kind.format, 'email');
    assert.equal(props.kind.minLength, 3);
    assert.equal(props.kind.maxLength, 30);
    assert.equal(props.kind.pattern, '^[a-z]+$');
    assert.equal(props.age.minimum, 0);
    assert.equal(props.age.maximum, 150);
    assert.equal(props.age.default, 18);
  });
});
