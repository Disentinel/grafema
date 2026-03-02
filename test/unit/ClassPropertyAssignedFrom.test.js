/**
 * ClassProperty / ClassPrivateProperty ASSIGNED_FROM edge tests (REG-597)
 *
 * Graph invariants:
 * 1. Every PROPERTY node from a class field with an initializer MUST have
 *    exactly one outgoing ASSIGNED_FROM edge
 * 2. Every PROPERTY node from a class field without an initializer MUST NOT
 *    have any ASSIGNED_FROM edge
 * 3. ASSIGNED_FROM target type matches initializer: LITERAL for primitives,
 *    CALL for `new X()`, FUNCTION for arrows
 * 4. Every ENUM_MEMBER with an initializer MUST have exactly one outgoing
 *    ASSIGNED_FROM edge
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

after(cleanupAllTestDatabases);

let testCounter = 0;

async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-class-prop-assigned-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({ name: `test-class-prop-assigned-${testCounter}`, type: 'module' })
  );

  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(testDir, filename);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);
  return { testDir };
}

async function getNodesByType(backend, type) {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter(n => n.type === type);
}

async function getEdgesByType(backend, type) {
  const allEdges = await backend.getAllEdges();
  return allEdges.filter(e => e.type === type);
}

function findNode(nodes, type, name) {
  return nodes.find(n => n.type === type && n.name === name);
}

describe('ClassProperty ASSIGNED_FROM edges (REG-597)', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ==========================================================================
  // Literal initializer
  // ==========================================================================

  it('class field with literal initializer has ASSIGNED_FROM edge to LITERAL', async () => {
    await setupTest(backend, {
      'index.js': `
class Foo {
  bar = 42;
}
      `,
    });

    const allNodes = await backend.getAllNodes();
    const assignedFromEdges = await getEdgesByType(backend, 'ASSIGNED_FROM');

    const prop = findNode(allNodes, 'PROPERTY', 'bar');
    assert.ok(prop, 'PROPERTY bar should exist');

    const edge = assignedFromEdges.find(e => e.src === prop.id);
    assert.ok(edge, 'PROPERTY bar should have ASSIGNED_FROM edge');

    const target = allNodes.find(n => n.id === edge.dst);
    assert.ok(target, 'ASSIGNED_FROM target should exist');
    assert.strictEqual(target.type, 'LITERAL', 'target should be LITERAL');
  });

  // ==========================================================================
  // Identifier initializer (deferred scope_lookup)
  // ==========================================================================

  it('class field with Identifier initializer has ASSIGNED_FROM via deferred', async () => {
    await setupTest(backend, {
      'index.js': `
const someVar = 'hello';
class Foo {
  bar = someVar;
}
      `,
    });

    const allNodes = await backend.getAllNodes();
    const assignedFromEdges = await getEdgesByType(backend, 'ASSIGNED_FROM');

    const prop = findNode(allNodes, 'PROPERTY', 'bar');
    assert.ok(prop, 'PROPERTY bar should exist');

    const edge = assignedFromEdges.find(e => e.src === prop.id);
    assert.ok(edge, 'PROPERTY bar should have ASSIGNED_FROM edge (resolved from deferred)');
  });

  // ==========================================================================
  // Call / new expression initializer
  // ==========================================================================

  it('private field with new expression has ASSIGNED_FROM edge to CALL', async () => {
    await setupTest(backend, {
      'index.js': `
class Foo {
  #priv = new Map();
}
      `,
    });

    const allNodes = await backend.getAllNodes();
    const assignedFromEdges = await getEdgesByType(backend, 'ASSIGNED_FROM');

    const prop = findNode(allNodes, 'PROPERTY', '#priv');
    assert.ok(prop, 'PROPERTY #priv should exist');

    const edge = assignedFromEdges.find(e => e.src === prop.id);
    assert.ok(edge, 'PROPERTY #priv should have ASSIGNED_FROM edge');

    const target = allNodes.find(n => n.id === edge.dst);
    assert.ok(target, 'ASSIGNED_FROM target should exist');
    assert.strictEqual(target.type, 'CALL', 'target should be CALL');
  });

  // ==========================================================================
  // No initializer — no ASSIGNED_FROM
  // ==========================================================================

  it('class field without initializer has no ASSIGNED_FROM edge', async () => {
    await setupTest(backend, {
      'index.js': `
class Foo {
  bar;
}
      `,
    });

    const allNodes = await backend.getAllNodes();
    const assignedFromEdges = await getEdgesByType(backend, 'ASSIGNED_FROM');

    const prop = findNode(allNodes, 'PROPERTY', 'bar');
    assert.ok(prop, 'PROPERTY bar should exist');

    const edge = assignedFromEdges.find(e => e.src === prop.id);
    assert.ok(!edge, 'PROPERTY bar without initializer should NOT have ASSIGNED_FROM edge');
  });

  it('private field without initializer has no ASSIGNED_FROM edge', async () => {
    await setupTest(backend, {
      'index.js': `
class Foo {
  #field;
}
      `,
    });

    const allNodes = await backend.getAllNodes();
    const assignedFromEdges = await getEdgesByType(backend, 'ASSIGNED_FROM');

    const prop = findNode(allNodes, 'PROPERTY', '#field');
    assert.ok(prop, 'PROPERTY #field should exist');

    const edge = assignedFromEdges.find(e => e.src === prop.id);
    assert.ok(!edge, 'PROPERTY #field without initializer should NOT have ASSIGNED_FROM edge');
  });

  // ==========================================================================
  // Arrow function initializer
  // ==========================================================================

  it('class field with arrow function has ASSIGNED_FROM edge to FUNCTION', async () => {
    await setupTest(backend, {
      'index.js': `
class Foo {
  handler = () => {};
}
      `,
    });

    const allNodes = await backend.getAllNodes();
    const assignedFromEdges = await getEdgesByType(backend, 'ASSIGNED_FROM');

    const prop = findNode(allNodes, 'PROPERTY', 'handler');
    assert.ok(prop, 'PROPERTY handler should exist');

    const edge = assignedFromEdges.find(e => e.src === prop.id);
    assert.ok(edge, 'PROPERTY handler should have ASSIGNED_FROM edge');

    const target = allNodes.find(n => n.id === edge.dst);
    assert.ok(target, 'ASSIGNED_FROM target should exist');
    assert.strictEqual(target.type, 'FUNCTION', 'target should be FUNCTION');
  });

  // ==========================================================================
  // Static field
  // ==========================================================================

  it('static class field with initializer has ASSIGNED_FROM edge', async () => {
    await setupTest(backend, {
      'index.js': `
class Foo {
  static count = 0;
}
      `,
    });

    const allNodes = await backend.getAllNodes();
    const assignedFromEdges = await getEdgesByType(backend, 'ASSIGNED_FROM');

    const prop = findNode(allNodes, 'PROPERTY', 'count');
    assert.ok(prop, 'PROPERTY count should exist');
    assert.strictEqual(prop.static, true, 'should be static');

    const edge = assignedFromEdges.find(e => e.src === prop.id);
    assert.ok(edge, 'static PROPERTY count should have ASSIGNED_FROM edge');
  });

  // ==========================================================================
  // ClassExpression
  // ==========================================================================

  it('class expression field with initializer has ASSIGNED_FROM edge', async () => {
    await setupTest(backend, {
      'index.js': `
const MyClass = class {
  value = 'test';
};
      `,
    });

    const allNodes = await backend.getAllNodes();
    const assignedFromEdges = await getEdgesByType(backend, 'ASSIGNED_FROM');

    const prop = findNode(allNodes, 'PROPERTY', 'value');
    assert.ok(prop, 'PROPERTY value should exist');

    const edge = assignedFromEdges.find(e => e.src === prop.id);
    assert.ok(edge, 'class expression PROPERTY should have ASSIGNED_FROM edge');
  });

  // ==========================================================================
  // TSEnumMember
  // ==========================================================================

  it('TSEnumMember with literal initializer has ASSIGNED_FROM edge to LITERAL', async () => {
    await setupTest(backend, {
      'index.ts': `
enum Color {
  Red = 1,
  Green = 2,
  Blue = 3,
}
      `,
    });

    const allNodes = await backend.getAllNodes();
    const assignedFromEdges = await getEdgesByType(backend, 'ASSIGNED_FROM');

    const redMember = findNode(allNodes, 'ENUM_MEMBER', 'Red');
    assert.ok(redMember, 'ENUM_MEMBER Red should exist');

    const edge = assignedFromEdges.find(e => e.src === redMember.id);
    assert.ok(edge, 'ENUM_MEMBER Red should have ASSIGNED_FROM edge');

    const target = allNodes.find(n => n.id === edge.dst);
    assert.ok(target, 'ASSIGNED_FROM target should exist');
    assert.strictEqual(target.type, 'LITERAL', 'target should be LITERAL');
  });

  it('TSEnumMember without initializer has no ASSIGNED_FROM edge', async () => {
    await setupTest(backend, {
      'index.ts': `
enum Direction {
  Up,
  Down,
}
      `,
    });

    const allNodes = await backend.getAllNodes();
    const assignedFromEdges = await getEdgesByType(backend, 'ASSIGNED_FROM');

    const upMember = findNode(allNodes, 'ENUM_MEMBER', 'Up');
    assert.ok(upMember, 'ENUM_MEMBER Up should exist');

    const edge = assignedFromEdges.find(e => e.src === upMember.id);
    assert.ok(!edge, 'ENUM_MEMBER Up without initializer should NOT have ASSIGNED_FROM edge');
  });

  // ==========================================================================
  // String literal initializer
  // ==========================================================================

  it('TSEnumMember with string initializer has ASSIGNED_FROM edge', async () => {
    await setupTest(backend, {
      'index.ts': `
enum Status {
  Active = 'active',
  Inactive = 'inactive',
}
      `,
    });

    const allNodes = await backend.getAllNodes();
    const assignedFromEdges = await getEdgesByType(backend, 'ASSIGNED_FROM');

    const activeMember = findNode(allNodes, 'ENUM_MEMBER', 'Active');
    assert.ok(activeMember, 'ENUM_MEMBER Active should exist');

    const edge = assignedFromEdges.find(e => e.src === activeMember.id);
    assert.ok(edge, 'ENUM_MEMBER Active with string init should have ASSIGNED_FROM edge');
  });
});
