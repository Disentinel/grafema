/**
 * Tests for ARG_BINDING edges: PARAMETER → ARG_BINDING → argument_node.
 *
 * ARG_BINDING links function parameters to the actual arguments passed at
 * call sites. Created by linkArgumentsToParameters() in resolve.ts Phase 3.
 *
 * For each resolved CALLS/CALLS_ON edge:
 *   1. Find PASSES_ARGUMENT edges from the CALL node (each with argIndex metadata)
 *   2. Find RECEIVES_ARGUMENT edges from the target FUNCTION to get PARAMETERs
 *      (each with paramIndex metadata)
 *   3. Match by position, emit ARG_BINDING: PARAMETER → argument_node
 *      with metadata { argIndex, callId }
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkFile } from '../dist/walk.js';
import { jsRegistry } from '../dist/registry.js';
import { resolveFileRefs, resolveProject } from '../dist/resolve.js';

// ─── Helpers ─────────────────────────────────────────────────────────

async function walk(code, file = 'test.js') {
  const walkResult = await walkFile(code, file, jsRegistry);
  return resolveFileRefs(walkResult);
}

/**
 * Walk single file and run project-level resolution.
 * Returns combined nodes and edges (file-level + project-level).
 */
async function walkAndResolve(code, file = 'test.js') {
  const fileResult = await walk(code, file);
  const { edges: projectEdges, nodes: projectNodes } = resolveProject([fileResult]);
  return {
    nodes: [...fileResult.nodes, ...projectNodes],
    edges: [...fileResult.edges, ...projectEdges],
    fileResult,
  };
}

/**
 * Walk multiple files and run project-level resolution.
 * Returns combined nodes and edges from all files + project resolution.
 */
async function walkMultiAndResolve(files) {
  const fileResults = [];
  for (const { code, file } of files) {
    fileResults.push(await walk(code, file));
  }
  const { edges: projectEdges, nodes: projectNodes } = resolveProject(fileResults);
  const allEdges = [];
  const allNodes = [];
  for (const fr of fileResults) {
    allEdges.push(...fr.edges);
    allNodes.push(...fr.nodes);
  }
  allEdges.push(...projectEdges);
  allNodes.push(...projectNodes);
  return { nodes: allNodes, edges: allEdges, fileResults };
}

function findEdges(edges, type) {
  return edges.filter(e => e.type === type);
}

function findNodes(nodes, type) {
  return nodes.filter(n => n.type === type);
}

/**
 * Find ARG_BINDING edges and return them with enriched info.
 * Each result includes: { src, dst, paramName, argIndex, callId }
 */
function findArgBindings(result) {
  return findEdges(result.edges, 'ARG_BINDING').map(e => ({
    src: e.src,
    dst: e.dst,
    paramName: extractName(e.src),
    argIndex: e.metadata?.argIndex,
    callId: e.metadata?.callId,
  }));
}

/** Extract the name part from a node ID like "test.js->PARAMETER->x#2" */
function extractName(id) {
  const match = id.match(/->([\w<>]+)#/);
  return match ? match[1] : id;
}

// ─── Tier 1: Direct calls (same-file) ───────────────────────────────

describe('Tier 1: Direct calls — ARG_BINDING', () => {

  it('binds two params to two args: foo(a, b)', async () => {
    const result = await walkAndResolve(`
      const a = 1;
      const b = 2;
      function foo(x, y) {}
      foo(a, b);
    `);

    const bindings = findArgBindings(result);
    assert.ok(bindings.length >= 2,
      `expected at least 2 ARG_BINDING edges, got ${bindings.length}: ${JSON.stringify(bindings)}`);

    const xBinding = bindings.find(b => b.src.includes('PARAMETER->x'));
    const yBinding = bindings.find(b => b.src.includes('PARAMETER->y'));

    assert.ok(xBinding, `expected ARG_BINDING for param x, got: ${JSON.stringify(bindings.map(b => b.src))}`);
    assert.ok(yBinding, `expected ARG_BINDING for param y, got: ${JSON.stringify(bindings.map(b => b.src))}`);

    // x binds to a (argIndex 0), y binds to b (argIndex 1)
    assert.ok(xBinding.dst.includes('->a') || xBinding.dst.includes('CONSTANT->a') || xBinding.dst.includes('VARIABLE->a'),
      `x should bind to a, got dst: ${xBinding.dst}`);
    assert.ok(yBinding.dst.includes('->b') || yBinding.dst.includes('CONSTANT->b') || yBinding.dst.includes('VARIABLE->b'),
      `y should bind to b, got dst: ${yBinding.dst}`);

    assert.equal(xBinding.argIndex, 0, 'x should be argIndex 0');
    assert.equal(yBinding.argIndex, 1, 'y should be argIndex 1');
  });

  it('binds param to literal: foo(42)', async () => {
    const result = await walkAndResolve(`
      function foo(x) {}
      foo(42);
    `);

    const bindings = findArgBindings(result);
    assert.ok(bindings.length >= 1,
      `expected at least 1 ARG_BINDING edge, got ${bindings.length}`);

    const xBinding = bindings.find(b => b.src.includes('PARAMETER->x'));
    assert.ok(xBinding, 'expected ARG_BINDING for param x');
    assert.equal(xBinding.argIndex, 0, 'x should be argIndex 0');
  });

  it('no binding when no args: foo()', async () => {
    const result = await walkAndResolve(`
      function foo(x) {}
      foo();
    `);

    const bindings = findArgBindings(result);
    const xBinding = bindings.find(b => b.src.includes('PARAMETER->x'));
    assert.ok(!xBinding,
      `expected no ARG_BINDING for x when called with no args, got: ${JSON.stringify(bindings)}`);
  });

  it('partial binding: foo(a) with two params', async () => {
    const result = await walkAndResolve(`
      const a = 1;
      function foo(x, y) {}
      foo(a);
    `);

    const bindings = findArgBindings(result);
    const xBinding = bindings.find(b => b.src.includes('PARAMETER->x'));
    const yBinding = bindings.find(b => b.src.includes('PARAMETER->y'));

    assert.ok(xBinding, 'x should have ARG_BINDING (first arg matches)');
    assert.ok(!yBinding,
      `y should NOT have ARG_BINDING (no second arg), got: ${JSON.stringify(bindings)}`);
  });
});

// ─── Tier 2: Rest parameters ────────────────────────────────────────

describe('Tier 2: Rest parameters — ARG_BINDING', () => {

  it('binds all args to rest param: f(...args) called with 3 args', async () => {
    const result = await walkAndResolve(`
      function f(...args) {}
      f(1, 2, 3);
    `);

    const bindings = findArgBindings(result);
    const restBindings = bindings.filter(b => b.src.includes('PARAMETER->args'));
    assert.ok(restBindings.length === 3,
      `expected 3 ARG_BINDING edges to rest param args, got ${restBindings.length}: ${JSON.stringify(bindings)}`);
  });

  it('binds regular + rest: f(x, ...rest) called with 3 args', async () => {
    const result = await walkAndResolve(`
      const a = 1, b = 2, c = 3;
      function f(x, ...rest) {}
      f(a, b, c);
    `);

    const bindings = findArgBindings(result);
    const xBinding = bindings.find(b => b.src.includes('PARAMETER->x'));
    const restBindings = bindings.filter(b => b.src.includes('PARAMETER->rest'));

    assert.ok(xBinding, 'x should have ARG_BINDING for first arg');
    assert.equal(xBinding.argIndex, 0, 'x argIndex should be 0');
    assert.ok(xBinding.dst.includes('->a') || xBinding.dst.includes('CONSTANT->a') || xBinding.dst.includes('VARIABLE->a'),
      `x should bind to a, got: ${xBinding.dst}`);

    assert.ok(restBindings.length === 2,
      `expected 2 ARG_BINDING edges to rest param, got ${restBindings.length}: ${JSON.stringify(bindings)}`);
  });
});

// ─── Tier 3: Extra args ─────────────────────────────────────────────

describe('Tier 3: Extra arguments — ISSUE nodes', () => {

  it('binds matching arg + creates issues for extra args', async () => {
    const result = await walkAndResolve(`
      const a = 1, b = 2, c = 3;
      function foo(x) {}
      foo(a, b, c);
    `);

    // x should bind to a
    const bindings = findArgBindings(result);
    const xBinding = bindings.find(b => b.src.includes('PARAMETER->x'));
    assert.ok(xBinding, 'x should have ARG_BINDING for first arg');

    // ISSUE nodes for extra arguments b, c
    const issues = findNodes(result.nodes, 'ISSUE');
    const extraArgIssues = issues.filter(n =>
      n.metadata?.issueKind === 'extra-argument'
    );
    assert.ok(extraArgIssues.length >= 2,
      `expected at least 2 extra-argument ISSUE nodes for b and c, got ${extraArgIssues.length}: ${JSON.stringify(issues.map(i => i.metadata))}`);
  });
});

// ─── Tier 4: Method calls ───────────────────────────────────────────

describe('Tier 4: Method calls — ARG_BINDING', () => {

  it('binds method param to arg: this.method(arg)', async () => {
    const result = await walkAndResolve(`
      class Foo {
        method(x) {}
        greet() {
          this.method(42);
        }
      }
    `);

    const bindings = findArgBindings(result);
    const xBinding = bindings.find(b => b.src.includes('PARAMETER->x'));
    assert.ok(xBinding,
      `expected ARG_BINDING for method param x, got: ${JSON.stringify(bindings.map(b => b.src))}`);
    assert.equal(xBinding.argIndex, 0, 'x should be argIndex 0');
  });
});

// ─── Tier 5: Spread args ────────────────────────────────────────────

describe('Tier 5: Spread arguments — ARG_BINDING', () => {

  it('no binding when all args are spread: foo(...arr)', async () => {
    const result = await walkAndResolve(`
      const arr = [1, 2];
      function foo(x, y) {}
      foo(...arr);
    `);

    const bindings = findArgBindings(result);
    assert.equal(bindings.length, 0,
      `expected 0 ARG_BINDING when all args are spread, got ${bindings.length}: ${JSON.stringify(bindings)}`);
  });

  it('binds regular arg before spread: foo(a, ...arr)', async () => {
    const result = await walkAndResolve(`
      const a = 1;
      const arr = [2, 3];
      function foo(x, ...rest) {}
      foo(a, ...arr);
    `);

    const bindings = findArgBindings(result);
    const xBinding = bindings.find(b => b.src.includes('PARAMETER->x'));
    assert.ok(xBinding, 'x should bind to first (non-spread) arg');
    assert.equal(xBinding.argIndex, 0, 'x should be argIndex 0');

    // rest param should bind to the spread node
    const restBindings = bindings.filter(b => b.src.includes('PARAMETER->rest'));
    assert.ok(restBindings.length >= 1,
      `rest should have at least 1 ARG_BINDING (to spread node), got ${restBindings.length}`);
  });
});

// ─── Tier 6: Destructured params ────────────────────────────────────

describe('Tier 6: Destructured parameters — ARG_BINDING', () => {

  it('binds synthetic param to arg: foo({a, b}) called with foo(obj)', async () => {
    const result = await walkAndResolve(`
      const obj = { a: 1, b: 2 };
      function foo({a, b}) {}
      foo(obj);
    `);

    // The destructured pattern creates a synthetic parameter.
    // ARG_BINDING should link that synthetic param → obj.
    const bindings = findArgBindings(result);
    assert.ok(bindings.length >= 1,
      `expected at least 1 ARG_BINDING for destructured param, got ${bindings.length}: ${JSON.stringify(bindings)}`);

    // The first binding should have argIndex 0
    const firstBinding = bindings.find(b => b.argIndex === 0);
    assert.ok(firstBinding, 'expected an ARG_BINDING with argIndex 0');
  });
});

// ─── Tier 7: Default params ─────────────────────────────────────────

describe('Tier 7: Default parameters — ARG_BINDING', () => {

  it('binds param with default to actual arg: foo(val)', async () => {
    const result = await walkAndResolve(`
      const val = 10;
      function foo(x = 5) {}
      foo(val);
    `);

    const bindings = findArgBindings(result);
    const xBinding = bindings.find(b => b.src.includes('PARAMETER->x'));
    assert.ok(xBinding,
      `expected ARG_BINDING for param x (which has default), got: ${JSON.stringify(bindings)}`);
    assert.equal(xBinding.argIndex, 0, 'x should be argIndex 0');
  });
});

// ─── Tier 8: Unresolved calls ───────────────────────────────────────

describe('Tier 8: Unresolved calls — ISSUE nodes', () => {

  it('creates unresolved-call ISSUE for unknown function', async () => {
    const result = await walkAndResolve(`
      unknownFn(1, 2);
    `);

    const issues = findNodes(result.nodes, 'ISSUE');
    const unresolvedCallIssues = issues.filter(n =>
      n.metadata?.issueKind === 'unresolved-call'
    );
    assert.ok(unresolvedCallIssues.length >= 1,
      `expected at least 1 unresolved-call ISSUE node, got ${unresolvedCallIssues.length}: ${JSON.stringify(issues.map(i => ({ name: i.name, metadata: i.metadata })))}`);
  });
});

// ─── Tier 9: Cross-file ─────────────────────────────────────────────

describe('Tier 9: Cross-file — ARG_BINDING', () => {

  it('binds imported function param to call-site arg', async () => {
    const result = await walkMultiAndResolve([
      {
        code: `export function greet(name) {}`,
        file: 'src/utils/greet.js',
      },
      {
        code: `
          import { greet } from './greet.js';
          const userName = 'Alice';
          greet(userName);
        `,
        file: 'src/utils/main.js',
      },
    ]);

    const bindings = findArgBindings(result);
    const nameBinding = bindings.find(b => b.src.includes('PARAMETER->name'));
    assert.ok(nameBinding,
      `expected cross-file ARG_BINDING for param name, got: ${JSON.stringify(bindings.map(b => b.src))}`);
    assert.equal(nameBinding.argIndex, 0, 'name should be argIndex 0');
    assert.ok(
      nameBinding.dst.includes('->userName') || nameBinding.dst.includes('CONSTANT->userName') || nameBinding.dst.includes('VARIABLE->userName'),
      `name should bind to userName, got: ${nameBinding.dst}`
    );
  });
});

// ─── Tier 10: new Foo(arg) ──────────────────────────────────────────

describe('Tier 10: Constructor calls — ARG_BINDING', () => {

  it('binds constructor param to new-expression arg: new Foo(val)', async () => {
    const result = await walkAndResolve(`
      const val = 42;
      class Foo {
        constructor(x) {}
      }
      new Foo(val);
    `);

    const bindings = findArgBindings(result);
    const xBinding = bindings.find(b => b.src.includes('PARAMETER->x'));
    assert.ok(xBinding,
      `expected ARG_BINDING for constructor param x, got: ${JSON.stringify(bindings.map(b => b.src))}`);
    assert.equal(xBinding.argIndex, 0, 'x should be argIndex 0');
  });
});

// ─── Tier 11: Arrow functions ───────────────────────────────────────

describe('Tier 11: Arrow functions — ARG_BINDING', () => {

  it('binds arrow function params to args: fn(a, b)', async () => {
    const result = await walkAndResolve(`
      const a = 1;
      const b = 2;
      const fn = (x, y) => x + y;
      fn(a, b);
    `);

    const bindings = findArgBindings(result);
    const xBinding = bindings.find(b => b.src.includes('PARAMETER->x'));
    const yBinding = bindings.find(b => b.src.includes('PARAMETER->y'));

    assert.ok(xBinding,
      `expected ARG_BINDING for arrow param x, got: ${JSON.stringify(bindings.map(b => b.src))}`);
    assert.ok(yBinding,
      `expected ARG_BINDING for arrow param y, got: ${JSON.stringify(bindings.map(b => b.src))}`);

    assert.equal(xBinding.argIndex, 0, 'x should be argIndex 0');
    assert.equal(yBinding.argIndex, 1, 'y should be argIndex 1');
  });
});

// ─── Metadata invariants ────────────────────────────────────────────

describe('ARG_BINDING metadata invariants', () => {

  it('every ARG_BINDING edge has argIndex and callId metadata', async () => {
    const result = await walkAndResolve(`
      const a = 1;
      const b = 2;
      function foo(x, y) {}
      foo(a, b);
    `);

    const argBindings = findEdges(result.edges, 'ARG_BINDING');
    for (const edge of argBindings) {
      assert.ok(edge.metadata, `ARG_BINDING edge should have metadata: ${JSON.stringify(edge)}`);
      assert.ok(typeof edge.metadata.argIndex === 'number',
        `ARG_BINDING should have numeric argIndex, got: ${JSON.stringify(edge.metadata)}`);
      assert.ok(typeof edge.metadata.callId === 'string',
        `ARG_BINDING should have string callId, got: ${JSON.stringify(edge.metadata)}`);
    }
  });

  it('ARG_BINDING src is always a PARAMETER node', async () => {
    const result = await walkAndResolve(`
      const a = 1;
      function foo(x) {}
      foo(a);
    `);

    const argBindings = findEdges(result.edges, 'ARG_BINDING');
    for (const edge of argBindings) {
      assert.ok(edge.src.includes('PARAMETER'),
        `ARG_BINDING src should be a PARAMETER node, got: ${edge.src}`);
    }
  });

  it('callId in metadata references the CALL node', async () => {
    const result = await walkAndResolve(`
      const a = 1;
      function foo(x) {}
      foo(a);
    `);

    const argBindings = findEdges(result.edges, 'ARG_BINDING');
    const callNodes = findNodes(result.nodes, 'CALL');
    const callIds = new Set(callNodes.map(n => n.id));

    for (const edge of argBindings) {
      assert.ok(callIds.has(edge.metadata.callId),
        `ARG_BINDING callId should reference a CALL node, got: ${edge.metadata.callId}`);
    }
  });
});

// ─── Multiple call sites ────────────────────────────────────────────

describe('Multiple call sites — ARG_BINDING', () => {

  it('creates separate ARG_BINDING edges for each call site', async () => {
    const result = await walkAndResolve(`
      const a = 1;
      const b = 2;
      function foo(x) {}
      foo(a);
      foo(b);
    `);

    const bindings = findArgBindings(result);
    const xBindings = bindings.filter(b => b.src.includes('PARAMETER->x'));

    assert.ok(xBindings.length >= 2,
      `expected at least 2 ARG_BINDING edges for x (one per call), got ${xBindings.length}: ${JSON.stringify(xBindings)}`);

    // The two bindings should have different callIds
    const callIds = new Set(xBindings.map(b => b.callId));
    assert.equal(callIds.size, 2,
      `expected 2 distinct callIds for 2 call sites, got ${callIds.size}: ${JSON.stringify([...callIds])}`);
  });
});
