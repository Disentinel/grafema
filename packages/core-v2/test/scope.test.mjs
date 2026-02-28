import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkFile } from '../dist/walk.js';
import { jsRegistry } from '../dist/registry.js';

describe('Scope tracking', () => {
  it('resolves variable in same scope', async () => {
    const code = `const x = 1;\nconst y = x;`;
    const result = await walkFile(code, 'test.js', jsRegistry);
    const assignedFrom = result.edges.filter(e => e.type === 'ASSIGNED_FROM');
    assert.ok(assignedFrom.length >= 1, `expected ASSIGNED_FROM edge, got ${assignedFrom.length}`);
    // y -> x
    const edge = assignedFrom.find(e => e.src.includes('VARIABLE->y'));
    assert.ok(edge, 'y should have ASSIGNED_FROM edge');
    assert.ok(edge.dst.includes('CONSTANT->x'), `expected dst to be x, got ${edge.dst}`);
  });

  it('resolves var hoisting to function scope', async () => {
    const code = `
function foo() {
  x = 10;
  if (true) {
    var x = 1;
  }
}`;
    const result = await walkFile(code, 'test.js', jsRegistry);
    // x should be declared in function scope (hoisted)
    // The assignment x = 10 should resolve to the var x
    const writesTo = result.edges.filter(e => e.type === 'WRITES_TO');
    assert.ok(writesTo.length >= 1, `expected WRITES_TO edge for x = 10, got ${writesTo.length}`);
  });

  it('does not resolve let/const from outer block', async () => {
    const code = `
function foo() {
  if (true) {
    const inner = 1;
  }
  const y = inner;  // inner not in scope here
}`;
    const result = await walkFile(code, 'test.js', jsRegistry);
    // inner is block-scoped, y = inner should NOT resolve
    const yAssigned = result.edges.filter(
      e => e.type === 'ASSIGNED_FROM' && e.src.includes('->y')
    );
    // Should be unresolved (no ASSIGNED_FROM from y to inner)
    assert.equal(yAssigned.length, 0, 'inner should not be in scope for y');
    // Check it's in unresolved refs
    const unresolved = result.unresolvedRefs.filter(
      r => r.kind === 'scope_lookup' && r.name === 'inner'
    );
    assert.ok(unresolved.length >= 1, 'inner should be unresolved');
  });

  it('resolves closure capture from parent function', async () => {
    const code = `
function outer() {
  const captured = 1;
  function inner() {
    const y = captured;
  }
}`;
    const result = await walkFile(code, 'test.js', jsRegistry);
    // inner's y = captured should resolve to outer's captured
    const assignedFrom = result.edges.filter(
      e => e.type === 'ASSIGNED_FROM' && e.src.includes('->y')
    );
    assert.ok(assignedFrom.length >= 1, 'y should resolve captured from outer scope');
    assert.ok(
      assignedFrom[0].dst.includes('CONSTANT->captured'),
      `expected captured, got ${assignedFrom[0].dst}`
    );
  });

  it('resolves function declarations (hoisted)', async () => {
    const code = `
const result = foo();
function foo() { return 1; }`;
    const result = await walkFile(code, 'test.js', jsRegistry);
    // foo() call should resolve — function declarations are hoisted
    // The call creates a call_resolve deferred, but foo is declared
    // in module scope, so scope_lookup for 'foo' should find it
    const fooDecl = result.nodes.find(n => n.type === 'FUNCTION' && n.name === 'foo');
    assert.ok(fooDecl, 'foo FUNCTION node should exist');
    // Check that foo is in scope (declared in module scope)
    const declarations = result.scopeTree.declarations;
    assert.ok(declarations.has('foo'), 'foo should be declared in module scope');
  });

  it('exports resolve to module-level declarations', async () => {
    const code = `
const a = 1;
const b = 2;
export { a, b };`;
    const result = await walkFile(code, 'test.js', jsRegistry);
    const exports = result.edges.filter(e => e.type === 'EXPORTS');
    assert.ok(exports.length >= 2, `expected 2+ EXPORTS edges, got ${exports.length}`);
  });

  it('import declarations register in scope', async () => {
    const code = `
import { foo } from './other';
const x = foo;`;
    const result = await walkFile(code, 'test.js', jsRegistry);
    // x = foo should resolve to the IMPORT node
    const assignedFrom = result.edges.filter(
      e => e.type === 'ASSIGNED_FROM' && e.src.includes('->x')
    );
    assert.ok(assignedFrom.length >= 1, 'x should resolve foo from import');
    assert.ok(
      assignedFrom[0].dst.includes('IMPORT->foo'),
      `expected import node, got ${assignedFrom[0].dst}`
    );
  });

  it('scope tree has correct structure', async () => {
    const code = `
function foo(a) {
  const x = 1;
  if (true) {
    let y = 2;
  }
}
const z = 3;`;
    const result = await walkFile(code, 'test.js', jsRegistry);
    const root = result.scopeTree;

    // Root = module scope
    assert.equal(root.kind, 'module');
    assert.ok(root.declarations.has('foo'), 'module has foo');
    assert.ok(root.declarations.has('z'), 'module has z');

    // Function scope = child of module
    assert.ok(root.children.length >= 1, 'module should have children');
    const fnScope = root.children.find(c => c.kind === 'function');
    assert.ok(fnScope, 'should have function scope');
    assert.ok(fnScope.declarations.has('a'), 'function scope has param a');

    // Function body is a BlockStatement → creates block scope child
    assert.ok(fnScope.children.length >= 1, 'function should have block child (body)');
    const bodyScope = fnScope.children[0];
    assert.equal(bodyScope.kind, 'block', 'body scope is block');
    // const x is block-scoped → lives in body block scope
    assert.ok(bodyScope.declarations.has('x'), 'body block scope has x');

    // if-block creates another nested block scope
    assert.ok(bodyScope.children.length >= 1, 'body should have if-block child');
  });
});
