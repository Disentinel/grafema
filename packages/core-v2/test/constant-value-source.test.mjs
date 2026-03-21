/**
 * Tests for CONSTANT value source invariant:
 * Every CONSTANT node must have an outgoing ASSIGNED_FROM edge
 * whose target is a LITERAL node.
 *
 * Non-literal initialisers (calls, new-expressions, etc.) produce
 * VARIABLE nodes instead of CONSTANT.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkFile } from '../dist/walk.js';
import { jsRegistry } from '../dist/registry.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function findConstant(result, name) {
  return result.nodes.find(n => n.type === 'CONSTANT' && n.name === name);
}

function findAssignedFrom(result, srcId) {
  return result.edges.filter(e => e.src === srcId && e.type === 'ASSIGNED_FROM');
}

function assertConstantWithLiteral(result, name) {
  const constant = findConstant(result, name);
  assert.ok(constant, `expected CONSTANT node named '${name}'`);

  const edges = findAssignedFrom(result, constant.id);
  assert.ok(edges.length >= 1,
    `CONSTANT '${name}' should have at least one ASSIGNED_FROM edge, got ${edges.length}`);

  const targetId = edges[0].dst;
  const targetNode = result.nodes.find(n => n.id === targetId);
  assert.ok(targetNode, `ASSIGNED_FROM target '${targetId}' should exist in nodes`);
  assert.equal(targetNode.type, 'LITERAL',
    `ASSIGNED_FROM target for '${name}' should be LITERAL, got '${targetNode.type}'`);
}

// ─── Individual literal types ────────────────────────────────────────

describe('CONSTANT value source edges', () => {

  it('const x = 42 -> CONSTANT named x + ASSIGNED_FROM -> LITERAL', async () => {
    const result = await walkFile('const x = 42;', 'test.js', jsRegistry);
    assertConstantWithLiteral(result, 'x');
  });

  it("const s = 'hello' -> CONSTANT named s + ASSIGNED_FROM -> LITERAL", async () => {
    const result = await walkFile("const s = 'hello';", 'test.js', jsRegistry);
    assertConstantWithLiteral(result, 's');
  });

  it('const b = true -> CONSTANT named b + ASSIGNED_FROM -> LITERAL', async () => {
    const result = await walkFile('const b = true;', 'test.js', jsRegistry);
    assertConstantWithLiteral(result, 'b');
  });

  it('const n = null -> CONSTANT named n + ASSIGNED_FROM -> LITERAL', async () => {
    const result = await walkFile('const n = null;', 'test.js', jsRegistry);
    assertConstantWithLiteral(result, 'n');
  });

  it('const r = /pat/g -> CONSTANT named r + ASSIGNED_FROM -> LITERAL', async () => {
    const result = await walkFile('const r = /pat/g;', 'test.js', jsRegistry);
    assertConstantWithLiteral(result, 'r');
  });

  it('const t = `tpl` -> CONSTANT named t + ASSIGNED_FROM -> LITERAL', async () => {
    const result = await walkFile('const t = `tpl`;', 'test.js', jsRegistry);
    assertConstantWithLiteral(result, 't');
  });

  it('const big = 42n -> CONSTANT named big + ASSIGNED_FROM -> LITERAL', async () => {
    const result = await walkFile('const big = 42n;', 'test.js', jsRegistry);
    assertConstantWithLiteral(result, 'big');
  });

  // ─── Negative cases ─────────────────────────────────────────────────

  it('const x = new Foo() -> creates VARIABLE, not CONSTANT', async () => {
    const result = await walkFile('const x = new Foo();', 'test.js', jsRegistry);
    const constant = findConstant(result, 'x');
    assert.equal(constant, undefined,
      'new Foo() should not produce a CONSTANT node');

    const variable = result.nodes.find(n => n.type === 'VARIABLE' && n.name === 'x');
    assert.ok(variable, 'new Foo() should produce a VARIABLE node named x');
  });

  it('const x = foo() -> creates VARIABLE, not CONSTANT', async () => {
    const result = await walkFile('const x = foo();', 'test.js', jsRegistry);
    const constant = findConstant(result, 'x');
    assert.equal(constant, undefined,
      'foo() should not produce a CONSTANT node');

    const variable = result.nodes.find(n => n.type === 'VARIABLE' && n.name === 'x');
    assert.ok(variable, 'foo() should produce a VARIABLE node named x');
  });

  // ─── Batch invariant check ─────────────────────────────────────────

  it('batch: all CONSTANT nodes in a multi-declaration file have ASSIGNED_FROM -> LITERAL', async () => {
    const code = `
      const num = 42;
      const str = 'hello';
      const bool = true;
      const nil = null;
      const undef = undefined;
      const re = /abc/i;
      const tpl = \`template\`;
      const bigN = 100n;
      const neg = -1;
      const float = 3.14;
      const zero = 0;
      const empty = '';
    `;
    const result = await walkFile(code, 'test.js', jsRegistry);

    // For every CONSTANT node, verify it has at least one outgoing ASSIGNED_FROM or DERIVES_FROM edge
    const constants = result.nodes.filter(n => n.type === 'CONSTANT');
    assert.ok(constants.length >= 10,
      `expected at least 10 CONSTANT nodes, got ${constants.length}: ${constants.map(c => c.name).join(', ')}`);

    const violations = constants.filter(c => {
      const hasValueSource = result.edges.some(e =>
        e.src === c.id && (e.type === 'ASSIGNED_FROM' || e.type === 'DERIVES_FROM')
      );
      return !hasValueSource;
    });
    assert.equal(violations.length, 0,
      `Violations: ${violations.map(v => v.name).join(', ')}`);

    // Additionally verify that every ASSIGNED_FROM target is a LITERAL
    for (const c of constants) {
      const assignedEdges = result.edges.filter(
        e => e.src === c.id && e.type === 'ASSIGNED_FROM'
      );
      for (const edge of assignedEdges) {
        const target = result.nodes.find(n => n.id === edge.dst);
        assert.ok(target, `ASSIGNED_FROM target '${edge.dst}' should exist`);
        assert.equal(target.type, 'LITERAL',
          `ASSIGNED_FROM target for CONSTANT '${c.name}' should be LITERAL, got '${target.type}'`);
      }
    }
  });
});
