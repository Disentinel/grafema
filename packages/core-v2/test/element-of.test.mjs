/**
 * Tests for ELEMENT_OF and KEY_OF edges across all tiers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkFile } from '../dist/walk.js';
import { jsRegistry } from '../dist/registry.js';
import { resolveFileRefs, resolveProject } from '../dist/resolve.js';

// ─── Helpers ─────────────────────────────────────────────────────────

async function walk(code) {
  const walkResult = await walkFile(code, 'test.js', jsRegistry);
  return resolveFileRefs(walkResult);
}

function findEdges(result, type) {
  return result.edges.filter(e => e.type === type);
}

function findNodes(result, type) {
  return result.nodes.filter(n => n.type === type);
}

// ─── Tier 1: Structural ─────────────────────────────────────────────

describe('Tier 1: for-of → ELEMENT_OF', () => {
  it('creates ELEMENT_OF for `for (const item of arr)`', async () => {
    const result = await walk(`
      const arr = [1, 2, 3];
      for (const item of arr) {
        console.log(item);
      }
    `);
    const elementOf = findEdges(result, 'ELEMENT_OF');
    assert.ok(elementOf.length >= 1, `expected ELEMENT_OF edge, got ${elementOf.length}`);
    const edge = elementOf.find(e => e.src.includes('VARIABLE->item'));
    assert.ok(edge, 'item should have ELEMENT_OF edge');
    assert.ok(edge.dst.includes('CONSTANT->arr') || edge.dst.includes('VARIABLE->arr'),
      `expected dst to reference arr, got ${edge.dst}`);
  });

  it('creates ELEMENT_OF for `for (const [a, b] of pairs)`', async () => {
    const result = await walk(`
      const pairs = [[1,2], [3,4]];
      for (const [a, b] of pairs) {
        console.log(a, b);
      }
    `);
    // The destructured [a, b] creates an intermediate variable for the pattern,
    // then a,b are ELEMENT_OF from array destructuring (separate concern)
    const elementOf = findEdges(result, 'ELEMENT_OF');
    assert.ok(elementOf.length >= 1, `expected at least 1 ELEMENT_OF edge, got ${elementOf.length}`);
  });

  it('creates ELEMENT_OF for pre-declared variable: `for (item of arr)`', async () => {
    const result = await walk(`
      const arr = [1, 2, 3];
      let item;
      for (item of arr) {
        console.log(item);
      }
    `);
    const elementOf = findEdges(result, 'ELEMENT_OF');
    assert.ok(elementOf.length >= 1, `expected ELEMENT_OF for pre-declared item, got ${elementOf.length}`);
  });
});

describe('Tier 1: for-in → KEY_OF', () => {
  it('creates KEY_OF for `for (const key in obj)`', async () => {
    const result = await walk(`
      const obj = { a: 1, b: 2 };
      for (const key in obj) {
        console.log(key);
      }
    `);
    const keyOf = findEdges(result, 'KEY_OF');
    assert.ok(keyOf.length >= 1, `expected KEY_OF edge, got ${keyOf.length}`);
    const edge = keyOf.find(e => e.src.includes('VARIABLE->key'));
    assert.ok(edge, 'key should have KEY_OF edge');
    assert.ok(edge.dst.includes('CONSTANT->obj') || edge.dst.includes('VARIABLE->obj'),
      `expected dst to reference obj, got ${edge.dst}`);
  });

  it('creates KEY_OF for pre-declared variable: `for (key in obj)`', async () => {
    const result = await walk(`
      const obj = { a: 1, b: 2 };
      let key;
      for (key in obj) {
        console.log(key);
      }
    `);
    const keyOf = findEdges(result, 'KEY_OF');
    assert.ok(keyOf.length >= 1, `expected KEY_OF for pre-declared key, got ${keyOf.length}`);
  });
});

describe('Tier 1: Array destructuring → ELEMENT_OF', () => {
  it('creates ELEMENT_OF for `const [a, b] = arr`', async () => {
    const result = await walk(`
      const arr = [1, 2, 3];
      const [a, b] = arr;
    `);
    const elementOf = findEdges(result, 'ELEMENT_OF');
    assert.ok(elementOf.length >= 2, `expected at least 2 ELEMENT_OF edges (a,b), got ${elementOf.length}`);
    const aEdge = elementOf.find(e => e.src.includes('VARIABLE->a'));
    const bEdge = elementOf.find(e => e.src.includes('VARIABLE->b'));
    assert.ok(aEdge, 'a should have ELEMENT_OF edge');
    assert.ok(bEdge, 'b should have ELEMENT_OF edge');
  });
});

// ─── Tier 2a: Callback element propagation ──────────────────────────

describe('Tier 2a: Callback ELEMENT_OF', () => {
  it('creates ELEMENT_OF for arr.forEach(item => ...)', async () => {
    const result = await walk(`
      const arr = [1, 2, 3];
      arr.forEach(item => {
        console.log(item);
      });
    `);
    const elementOf = findEdges(result, 'ELEMENT_OF');
    const paramEdge = elementOf.find(e => e.src.includes('PARAMETER->item'));
    assert.ok(paramEdge, `item param should have ELEMENT_OF, got edges: ${JSON.stringify(elementOf.map(e => e.src))}`);
  });

  it('creates ELEMENT_OF for arr.map(x => ...)', async () => {
    const result = await walk(`
      const arr = [1, 2, 3];
      arr.map(x => x * 2);
    `);
    const elementOf = findEdges(result, 'ELEMENT_OF');
    const paramEdge = elementOf.find(e => e.src.includes('PARAMETER->x'));
    assert.ok(paramEdge, 'x param should have ELEMENT_OF');
  });

  it('creates ELEMENT_OF for arr.filter(x => ...)', async () => {
    const result = await walk(`
      const items = [1, 2, 3];
      items.filter(x => x > 1);
    `);
    const elementOf = findEdges(result, 'ELEMENT_OF');
    const paramEdge = elementOf.find(e => e.src.includes('PARAMETER->x'));
    assert.ok(paramEdge, 'x param should have ELEMENT_OF');
  });

  it('creates ELEMENT_OF for arr.reduce((acc, cur) => ...) — cur is element', async () => {
    const result = await walk(`
      const nums = [1, 2, 3];
      nums.reduce((acc, cur) => acc + cur, 0);
    `);
    const elementOf = findEdges(result, 'ELEMENT_OF');
    const curEdge = elementOf.find(e => e.src.includes('PARAMETER->cur'));
    assert.ok(curEdge, 'cur param should have ELEMENT_OF');
    // acc should NOT have ELEMENT_OF
    const accEdge = elementOf.find(e => e.src.includes('PARAMETER->acc'));
    assert.ok(!accEdge, 'acc param should NOT have ELEMENT_OF');
  });

  it('creates ELEMENT_OF for arr.sort((a, b) => ...) — both are elements', async () => {
    const result = await walk(`
      const arr = [3, 1, 2];
      arr.sort((a, b) => a - b);
    `);
    const elementOf = findEdges(result, 'ELEMENT_OF');
    const aEdge = elementOf.find(e => e.src.includes('PARAMETER->a'));
    const bEdge = elementOf.find(e => e.src.includes('PARAMETER->b'));
    assert.ok(aEdge, 'a param should have ELEMENT_OF');
    assert.ok(bEdge, 'b param should have ELEMENT_OF');
  });

  it('creates ELEMENT_OF for arr.find(x => ...)', async () => {
    const result = await walk(`
      const arr = [1, 2, 3];
      arr.find(x => x === 2);
    `);
    const elementOf = findEdges(result, 'ELEMENT_OF');
    const paramEdge = elementOf.find(e => e.src.includes('PARAMETER->x'));
    assert.ok(paramEdge, 'x param should have ELEMENT_OF');
  });
});

// ─── Tier 2b: Element-returning methods ─────────────────────────────

describe('Tier 2b: Element-returning methods', () => {
  it('creates ELEMENT_OF for arr.pop()', async () => {
    const result = await walk(`
      const arr = [1, 2, 3];
      const last = arr.pop();
    `);
    const elementOf = findEdges(result, 'ELEMENT_OF');
    const popEdge = elementOf.find(e => e.src.includes('CALL->arr.pop'));
    assert.ok(popEdge, `arr.pop() should have ELEMENT_OF, edges: ${JSON.stringify(elementOf.map(e => e.src))}`);
  });

  it('creates ELEMENT_OF for arr.shift()', async () => {
    const result = await walk(`
      const arr = [1, 2, 3];
      const first = arr.shift();
    `);
    const elementOf = findEdges(result, 'ELEMENT_OF');
    const shiftEdge = elementOf.find(e => e.src.includes('CALL->arr.shift'));
    assert.ok(shiftEdge, 'arr.shift() should have ELEMENT_OF');
  });

  it('creates ELEMENT_OF for arr.at(0)', async () => {
    const result = await walk(`
      const arr = [1, 2, 3];
      const elem = arr.at(0);
    `);
    const elementOf = findEdges(result, 'ELEMENT_OF');
    const atEdge = elementOf.find(e => e.src.includes('CALL->arr.at'));
    assert.ok(atEdge, 'arr.at() should have ELEMENT_OF');
  });
});

// ─── Tier 3c: Object.keys/values/entries ────────────────────────────

describe('Tier 3c: Object.keys/values/entries', () => {
  it('creates KEY_OF for Object.keys(obj)', async () => {
    const result = await walk(`
      const obj = { a: 1 };
      const keys = Object.keys(obj);
    `);
    const keyOf = findEdges(result, 'KEY_OF');
    const edge = keyOf.find(e => e.src.includes('CALL->Object.keys'));
    assert.ok(edge, 'Object.keys(obj) should have KEY_OF');
  });

  it('creates ELEMENT_OF for Object.values(obj)', async () => {
    const result = await walk(`
      const obj = { a: 1 };
      const vals = Object.values(obj);
    `);
    const elementOf = findEdges(result, 'ELEMENT_OF');
    const edge = elementOf.find(e => e.src.includes('CALL->Object.values'));
    assert.ok(edge, 'Object.values(obj) should have ELEMENT_OF');
  });

  it('creates both ELEMENT_OF and KEY_OF for Object.entries(obj)', async () => {
    const result = await walk(`
      const obj = { a: 1 };
      const entries = Object.entries(obj);
    `);
    const elementOf = findEdges(result, 'ELEMENT_OF');
    const keyOf = findEdges(result, 'KEY_OF');
    const elEdge = elementOf.find(e => e.src.includes('CALL->Object.entries'));
    const keyEdge = keyOf.find(e => e.src.includes('CALL->Object.entries'));
    assert.ok(elEdge, 'Object.entries(obj) should have ELEMENT_OF');
    assert.ok(keyEdge, 'Object.entries(obj) should have KEY_OF');
  });
});

// ─── Tier 3a: Computed index access ─────────────────────────────────

describe('Tier 3a: Computed access ELEMENT_OF (project-level)', () => {
  it('creates ELEMENT_OF for arr[i] when arr is array-like', async () => {
    const code = `
      const arr = [1, 2, 3];
      const x = arr[0];
    `;
    const walkResult = await walkFile(code, 'test.js', jsRegistry);
    const fileResult = resolveFileRefs(walkResult);
    const { edges: projectEdges } = resolveProject([fileResult]);
    const allEdges = [...fileResult.edges, ...projectEdges];
    const elementOf = allEdges.filter(e => e.type === 'ELEMENT_OF');
    const computedEdge = elementOf.find(e =>
      e.src.includes('PROPERTY_ACCESS') && e.metadata?.via === 'computed-access'
    );
    assert.ok(computedEdge, `arr[0] should have ELEMENT_OF via computed-access, got: ${JSON.stringify(elementOf.map(e => ({src: e.src, via: e.metadata?.via})))}`);
  });
});
