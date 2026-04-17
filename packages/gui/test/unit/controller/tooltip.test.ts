/**
 * Tests for routeTooltip — pure tooltip content routing.
 *
 * Given a HoverTarget (node / edge / route / empty), the function computes
 * the TooltipContent (title, subtitle, rows, optional footer). The result
 * is DOM-agnostic and must be stable enough to test without a browser.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  routeTooltip,
  type HoverTarget,
  type NodeDatum,
  type EdgeDatum,
  type TooltipContent,
} from '../../../src/controller/tooltip.js';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const nodes: NodeDatum[] = [
  {
    id: 'n0',
    name: 'parseUser',
    type: 'FUNCTION',
    region: 'auth',
    file: 'src/auth/parse.ts',
    line: 42,
  },
  {
    id: 'n1',
    name: 'User',
    type: 'CLASS',
    region: 'models',
    file: 'src/models/user.ts',
    // no line
  },
  {
    id: 'n2',
    name: 'handler',
    type: 'FUNCTION',
    region: 'api',
    file: 'src/api/handler.ts',
    line: 10,
  },
];

// -----------------------------------------------------------------------------
// Empty
// -----------------------------------------------------------------------------

describe('routeTooltip — empty', () => {
  it('returns null for empty target', () => {
    const result = routeTooltip({ kind: 'empty' }, nodes);
    assert.equal(result, null);
  });
});

// -----------------------------------------------------------------------------
// Node
// -----------------------------------------------------------------------------

describe('routeTooltip — node', () => {
  it('produces title=name, subtitle=type, region row, file:line row', () => {
    const target: HoverTarget = { kind: 'node', nodeIdx: 0 };
    const result = routeTooltip(target, nodes);
    assert.ok(result);
    assert.equal(result.title, 'parseUser');
    assert.equal(result.subtitle, 'FUNCTION');
    // rows must include region and file:line in that order
    assert.equal(result.rows.length, 2);
    assert.deepEqual(result.rows[0], { label: 'region', value: 'auth' });
    assert.deepEqual(result.rows[1], { label: 'location', value: 'src/auth/parse.ts:42' });
  });

  it('omits file:line row when node has no line', () => {
    const target: HoverTarget = { kind: 'node', nodeIdx: 1 };
    const result = routeTooltip(target, nodes);
    assert.ok(result);
    assert.equal(result.title, 'User');
    assert.equal(result.subtitle, 'CLASS');
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0], { label: 'region', value: 'models' });
  });

  it('returns null for unknown nodeIdx (graceful degradation)', () => {
    const bad: HoverTarget = { kind: 'node', nodeIdx: 999 };
    const result = routeTooltip(bad, nodes);
    assert.equal(result, null);
  });

  it('returns null for negative nodeIdx', () => {
    const bad: HoverTarget = { kind: 'node', nodeIdx: -1 };
    const result = routeTooltip(bad, nodes);
    assert.equal(result, null);
  });
});

// -----------------------------------------------------------------------------
// Edge
// -----------------------------------------------------------------------------

describe('routeTooltip — edge', () => {
  it('produces title=edgeType, subtitle=src→dst, rows with src/dst region/file', () => {
    const target: HoverTarget = {
      kind: 'edge',
      srcIdx: 0,
      dstIdx: 2,
      edgeType: 'CALLS',
    };
    const result = routeTooltip(target, nodes);
    assert.ok(result);
    assert.equal(result.title, 'CALLS');
    assert.equal(result.subtitle, 'parseUser \u2192 handler');
    // src row + dst row — region and file info
    assert.equal(result.rows.length, 2);
    // src row
    assert.equal(result.rows[0].label, 'from');
    assert.ok(result.rows[0].value.includes('auth'));
    assert.ok(result.rows[0].value.includes('src/auth/parse.ts'));
    // dst row
    assert.equal(result.rows[1].label, 'to');
    assert.ok(result.rows[1].value.includes('api'));
    assert.ok(result.rows[1].value.includes('src/api/handler.ts'));
  });

  it('returns null if src or dst index is out of range', () => {
    const bad1: HoverTarget = { kind: 'edge', srcIdx: 999, dstIdx: 0, edgeType: 'CALLS' };
    const bad2: HoverTarget = { kind: 'edge', srcIdx: 0, dstIdx: 999, edgeType: 'CALLS' };
    assert.equal(routeTooltip(bad1, nodes), null);
    assert.equal(routeTooltip(bad2, nodes), null);
  });

  it('uses edgeAccessor edge type when provided (override)', () => {
    const accessor = (src: number, dst: number): EdgeDatum | null => {
      if (src === 0 && dst === 2) return { type: 'REFINED_CALLS' };
      return null;
    };
    const target: HoverTarget = {
      kind: 'edge',
      srcIdx: 0,
      dstIdx: 2,
      edgeType: 'CALLS',
    };
    const result = routeTooltip(target, nodes, accessor);
    assert.ok(result);
    // edgeAccessor provides the authoritative type
    assert.equal(result.title, 'REFINED_CALLS');
  });

  it('falls back to target.edgeType if accessor returns null', () => {
    const accessor = (): EdgeDatum | null => null;
    const target: HoverTarget = {
      kind: 'edge',
      srcIdx: 0,
      dstIdx: 2,
      edgeType: 'CALLS',
    };
    const result = routeTooltip(target, nodes, accessor);
    assert.ok(result);
    assert.equal(result.title, 'CALLS');
  });
});

// -----------------------------------------------------------------------------
// Route
// -----------------------------------------------------------------------------

describe('routeTooltip — route', () => {
  it('produces title=routeId, subtitle=waypoint N+1, row with waypoint name/file', () => {
    const target: HoverTarget = {
      kind: 'route',
      routeId: 'login-flow',
      waypointIdx: 2,
    };
    // For route we need to pass the node under the waypoint; conventionally
    // the waypointIdx is a *graph node index* since routes store node indices.
    const result = routeTooltip(target, nodes);
    assert.ok(result);
    assert.equal(result.title, 'login-flow');
    assert.equal(result.subtitle, 'waypoint 3');
    assert.equal(result.rows.length, 1);
    const row = result.rows[0];
    assert.ok(row.value.includes('handler'));
    assert.ok(row.value.includes('src/api/handler.ts'));
  });

  it('returns null when waypointIdx points past the nodes list', () => {
    const bad: HoverTarget = { kind: 'route', routeId: 'x', waypointIdx: 999 };
    assert.equal(routeTooltip(bad, nodes), null);
  });

  it('waypointIdx=0 produces "waypoint 1" (1-indexed for users)', () => {
    const target: HoverTarget = { kind: 'route', routeId: 'r1', waypointIdx: 0 };
    const result = routeTooltip(target, nodes);
    assert.ok(result);
    assert.equal(result.subtitle, 'waypoint 1');
  });
});

// -----------------------------------------------------------------------------
// Type shape
// -----------------------------------------------------------------------------

describe('routeTooltip — TooltipContent shape', () => {
  it('always returns rows array (never undefined)', () => {
    const r: TooltipContent | null = routeTooltip({ kind: 'node', nodeIdx: 0 }, nodes);
    assert.ok(r);
    assert.ok(Array.isArray(r.rows));
  });
});
