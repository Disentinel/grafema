/**
 * Behavioral tests for `check_invariant` advertised-parameter honoring.
 *
 * REG-1144 advertised-but-ignored MCP param class. The check_invariant tool
 * schema advertises `description`, `limit` and `offset`, but the handler:
 *   - read `args.name` (a key the schema never advertised) instead of
 *     `args.description`, so a caller's description was silently dropped;
 *   - hardcoded `.slice(0, 20)`, ignoring `limit` (advertised default:
 *     DEFAULT_LIMIT) and `offset` (advertised default: 0) entirely.
 *
 * These tests drive the real handler through the mock-backend seam used by
 * query-graph-count.test.ts (mock.module on ensureAnalyzed) — no RFDB needed.
 *
 * TDD: written to FAIL against the pre-fix handler.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMIT } from '../dist/utils.js';

// --- Mock backend with checkGuarantee + getNode support ---

interface MockBinding {
  bindings: Array<{ name: string; value: string }>;
}

function createMockBackend(queryResults: MockBinding[] = []) {
  const nodes = new Map<string, Record<string, unknown>>();
  return {
    async nodeCount() { return nodes.size; },
    async edgeCount() { return 0; },
    async countNodesByType() { return {}; },
    async countEdgesByType() { return {}; },
    async getNode(id: string) { return nodes.get(id) ?? null; },
    async getOutgoingEdges() { return []; },
    async getIncomingEdges() { return []; },
    async *queryNodes() { /* no-op */ },
    async getAllNodes() { return []; },
    async checkGuarantee(_query: string) { return queryResults; },
    addNode(node: Record<string, unknown>) { nodes.set(node.id as string, node); },
  };
}

let mockBackend: ReturnType<typeof createMockBackend>;

mock.module('../dist/analysis.js', {
  namedExports: {
    ensureAnalyzed: async () => mockBackend,
  },
});

mock.module('../dist/state.js', {
  namedExports: {
    getProjectPath: () => '/mock/project',
  },
});

const { handleCheckInvariant } = await import('../dist/handlers/dataflow-handlers.js');

/** Build N raw-binding violations whose X value is `v0`, `v1`, ... */
function rawViolations(n: number): MockBinding[] {
  return Array.from({ length: n }, (_, i) => ({
    bindings: [{ name: 'X', value: `v${i}` }],
  }));
}

/** Extract and parse the JSON violation array from result text. */
function parseViolations(text: string): Array<Record<string, string>> {
  const open = text.indexOf('[');
  const close = text.lastIndexOf(']');
  assert.ok(open >= 0 && close > open, `result text has no JSON array: ${text}`);
  return JSON.parse(text.slice(open, close + 1));
}

describe('check_invariant honors advertised params (REG-1144 class)', () => {
  beforeEach(() => {
    mockBackend = createMockBackend([]);
  });

  it('description: surfaced in the "invariant holds" message', async () => {
    mockBackend = createMockBackend([]); // no violations → holds branch
    const result = await handleCheckInvariant({
      rule: 'violation(X) :- node(X, "EVAL").',
      description: 'no eval calls allowed',
    });
    assert.ok(!result.isError);
    assert.ok(
      result.content[0].text.includes('no eval calls allowed'),
      `holds message must include the advertised description, got: ${result.content[0].text}`,
    );
  });

  it('description: surfaced in the violations report', async () => {
    mockBackend = createMockBackend(rawViolations(3));
    const result = await handleCheckInvariant({
      rule: 'violation(X) :- node(X, "EVAL").',
      description: 'eval audit',
    });
    assert.ok(!result.isError);
    assert.ok(
      result.content[0].text.includes('eval audit'),
      `violations report must include the advertised description, got: ${result.content[0].text}`,
    );
  });

  it('limit: caps the number of enriched violations shown', async () => {
    mockBackend = createMockBackend(rawViolations(25));
    const result = await handleCheckInvariant({
      rule: 'violation(X) :- node(X, "EVAL").',
      limit: 5,
    });
    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes('25 violation(s)'), `should report 25 total, got: ${text}`);
    const shown = parseViolations(text);
    assert.strictEqual(shown.length, 5, `limit=5 should show 5 violations, got ${shown.length}`);
    assert.ok(text.includes('and 20 more'), `should report 20 remaining, got: ${text}`);
  });

  it('limit: default is DEFAULT_LIMIT, not the old hardcoded 20', async () => {
    mockBackend = createMockBackend(rawViolations(15));
    const result = await handleCheckInvariant({
      rule: 'violation(X) :- node(X, "EVAL").',
    });
    assert.ok(!result.isError);
    const text = result.content[0].text;
    const shown = parseViolations(text);
    assert.strictEqual(
      shown.length,
      DEFAULT_LIMIT,
      `default should be DEFAULT_LIMIT (${DEFAULT_LIMIT}), got ${shown.length}`,
    );
    assert.ok(
      text.includes(`and ${15 - DEFAULT_LIMIT} more`),
      `should report ${15 - DEFAULT_LIMIT} remaining, got: ${text}`,
    );
  });

  it('offset: skips the first N violations', async () => {
    mockBackend = createMockBackend(rawViolations(4));
    const result = await handleCheckInvariant({
      rule: 'violation(X) :- node(X, "EVAL").',
      offset: 2,
    });
    assert.ok(!result.isError);
    const shown = parseViolations(result.content[0].text);
    assert.strictEqual(shown.length, 2, `offset=2 over 4 should show 2, got ${shown.length}`);
    assert.deepStrictEqual(
      shown.map((v) => v.X),
      ['v2', 'v3'],
      `offset=2 should start at v2, got: ${JSON.stringify(shown)}`,
    );
  });

  it('limit + offset: paginate a window in the middle', async () => {
    mockBackend = createMockBackend(rawViolations(10));
    const result = await handleCheckInvariant({
      rule: 'violation(X) :- node(X, "EVAL").',
      limit: 3,
      offset: 4,
    });
    assert.ok(!result.isError);
    const text = result.content[0].text;
    const shown = parseViolations(text);
    assert.deepStrictEqual(
      shown.map((v) => v.X),
      ['v4', 'v5', 'v6'],
      `limit=3 offset=4 should be v4..v6, got: ${JSON.stringify(shown)}`,
    );
    // 4 skipped + 3 shown = 7; 3 remaining, next offset = 7
    assert.ok(text.includes('and 3 more'), `should report 3 remaining, got: ${text}`);
    assert.ok(text.includes('offset=7'), `should suggest next offset=7, got: ${text}`);
  });
});
