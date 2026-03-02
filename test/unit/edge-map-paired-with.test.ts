/**
 * Tests for edge-map pairedWith annotation (REG-612)
 *
 * Section 1: Validation — pairedWith entries reference existing visitors
 * Section 2: Structural edge integration tests — verify that edge-map
 *   produces structural edges for MemberExpression children while
 *   deferreds handle Identifier children.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { EDGE_MAP } from '../../packages/core-v2/dist/edge-map.js';
import { jsRegistry } from '../../packages/core-v2/dist/registry.js';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

after(cleanupAllTestDatabases);

let testCounter = 0;

async function setupTest(backend: any, files: Record<string, string>) {
  const testDir = join(tmpdir(), `navi-test-paired-with-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({ name: `test-paired-with-${testCounter}`, type: 'module' })
  );
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }
  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);
  return { testDir };
}

// =============================================================================
// Section 1: Validation — pairedWith entries reference existing visitors
// =============================================================================
describe('pairedWith validation (REG-612)', () => {
  it('every pairedWith.visitor should map to an existing registry key', () => {
    const pairedEntries = Object.entries(EDGE_MAP).filter(
      ([_key, mapping]: [string, any]) => mapping.pairedWith
    );

    assert.ok(
      pairedEntries.length > 0,
      'Expected at least one EDGE_MAP entry with pairedWith'
    );

    for (const [key, mapping] of pairedEntries) {
      const visitorName = (mapping as any).pairedWith.visitor;
      // Extract AST type by removing the 'visit' prefix
      // e.g. 'visitUpdateExpression' -> 'UpdateExpression'
      assert.ok(
        visitorName.startsWith('visit'),
        `pairedWith.visitor "${visitorName}" in EDGE_MAP["${key}"] should start with "visit"`
      );

      const astType = visitorName.replace(/^visit/, '');
      assert.ok(
        (jsRegistry as Record<string, any>)[astType],
        `pairedWith.visitor "${visitorName}" in EDGE_MAP["${key}"] references ` +
        `AST type "${astType}" which does not exist in jsRegistry. ` +
        `Available keys: ${Object.keys(jsRegistry as Record<string, any>).slice(0, 20).join(', ')}...`
      );
    }
  });

  it('pairedWith entries have non-empty documentation strings', () => {
    const pairedEntries = Object.entries(EDGE_MAP).filter(
      ([_key, mapping]: [string, any]) => mapping.pairedWith
    );

    for (const [key, mapping] of pairedEntries) {
      const pw = (mapping as any).pairedWith;
      assert.ok(pw.visitor.length > 0, `Empty visitor for "${key}"`);
      assert.ok(pw.visitorHandles.length > 0, `Empty visitorHandles for "${key}"`);
      assert.ok(pw.edgeMapHandles.length > 0, `Empty edgeMapHandles for "${key}"`);
    }
  });

  it('edgeMapHandles description mentions the entry edgeType', () => {
    const pairedEntries = Object.entries(EDGE_MAP).filter(
      ([_key, mapping]: [string, any]) => mapping.pairedWith
    );

    for (const [key, mapping] of pairedEntries) {
      assert.ok(
        (mapping as any).pairedWith.edgeMapHandles.includes(mapping.edgeType),
        `EDGE_MAP["${key}"].pairedWith.edgeMapHandles should mention ` +
        `edgeType "${mapping.edgeType}" but was: "${(mapping as any).pairedWith.edgeMapHandles}"`
      );
    }
  });
});

// =============================================================================
// Section 2: Structural edge integration tests
// =============================================================================
describe('pairedWith structural edge integration (REG-612)', () => {
  let db: any;
  let backend: any;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Test 1: obj.count++ should produce MODIFIES structural edge
  // ---------------------------------------------------------------------------
  it('obj.count++ should produce MODIFIES structural edge from EXPRESSION to PROPERTY_ACCESS', async () => {
    await setupTest(backend, {
      'index.js': `
const obj = { count: 0 };
obj.count++;
      `
    });

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    // Find the EXPRESSION node for the ++ operator
    const exprNode = allNodes.find((n: any) =>
      n.type === 'EXPRESSION' && n.operator === '++'
    );
    assert.ok(exprNode, 'EXPRESSION node with operator "++" not found');

    // Find the PROPERTY_ACCESS node for obj.count
    const propAccess = allNodes.find((n: any) =>
      n.type === 'PROPERTY_ACCESS' && n.name === 'obj.count'
    );
    assert.ok(
      propAccess,
      `PROPERTY_ACCESS node with name "obj.count" not found. ` +
      `PROPERTY_ACCESS nodes: ${JSON.stringify(allNodes.filter((n: any) => n.type === 'PROPERTY_ACCESS').map((n: any) => n.name))}`
    );

    // Verify MODIFIES edge from EXPRESSION to PROPERTY_ACCESS
    const modifiesEdge = allEdges.find((e: any) =>
      e.type === 'MODIFIES' &&
      e.src === exprNode.id &&
      e.dst === propAccess.id
    );
    assert.ok(
      modifiesEdge,
      `Expected MODIFIES edge from EXPRESSION(${exprNode.id}) to PROPERTY_ACCESS(${propAccess.id}). ` +
      `MODIFIES edges: ${JSON.stringify(allEdges.filter((e: any) => e.type === 'MODIFIES').map((e: any) => ({ src: e.src, dst: e.dst })))}`
    );
  });

  // ---------------------------------------------------------------------------
  // Test 2: i++ should NOT produce structural MODIFIES from edge-map
  // ---------------------------------------------------------------------------
  it('i++ should NOT produce structural MODIFIES from edge-map (deferred handles it)', async () => {
    await setupTest(backend, {
      'index.js': `
let i = 0;
i++;
      `
    });

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    // Find the VARIABLE node for i
    const iVar = allNodes.find((n: any) =>
      n.name === 'i' && n.type === 'VARIABLE'
    );
    assert.ok(iVar, 'VARIABLE "i" not found');

    // Find the EXPRESSION node for ++
    const exprNode = allNodes.find((n: any) =>
      n.type === 'EXPRESSION' && n.operator === '++'
    );
    assert.ok(exprNode, 'EXPRESSION node with operator "++" not found');

    // There SHOULD be a MODIFIES edge from EXPRESSION to VARIABLE (via deferred)
    const modifiesFromDeferred = allEdges.find((e: any) =>
      e.type === 'MODIFIES' &&
      e.src === exprNode.id &&
      e.dst === iVar.id
    );
    assert.ok(
      modifiesFromDeferred,
      `Expected MODIFIES edge from EXPRESSION to VARIABLE "i" (via deferred). ` +
      `MODIFIES edges: ${JSON.stringify(allEdges.filter((e: any) => e.type === 'MODIFIES').map((e: any) => ({ src: e.src, dst: e.dst })))}`
    );

    // There should NOT be a PROPERTY_ACCESS or IDENTIFIER child node
    // (visitIdentifier returns EMPTY_RESULT for update expression arguments)
    const childPropAccess = allNodes.find((n: any) =>
      (n.type === 'PROPERTY_ACCESS' || n.type === 'IDENTIFIER') &&
      n.name === 'i'
    );
    // For simple i++, no PROPERTY_ACCESS child should exist
    // (the MODIFIES edge goes directly from EXPRESSION to VARIABLE via deferred)
    assert.ok(
      !childPropAccess,
      `Should NOT have a PROPERTY_ACCESS/IDENTIFIER child node for simple i++ ` +
      `(visitIdentifier returns EMPTY_RESULT). Found: ${JSON.stringify(childPropAccess)}`
    );
  });

  // ---------------------------------------------------------------------------
  // Test 3: obj.prop = 5 should produce ASSIGNS_TO structural edge
  // ---------------------------------------------------------------------------
  it('obj.prop = 5 should produce ASSIGNS_TO structural edge from PROPERTY_ASSIGNMENT to PROPERTY_ACCESS', async () => {
    await setupTest(backend, {
      'index.js': `
const obj = {};
obj.prop = 5;
      `
    });

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    // Find the PROPERTY_ASSIGNMENT node for obj.prop
    const propAssign = allNodes.find((n: any) =>
      n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'obj.prop'
    );
    assert.ok(
      propAssign,
      `PROPERTY_ASSIGNMENT node with name "obj.prop" not found. ` +
      `PROPERTY_ASSIGNMENT nodes: ${JSON.stringify(allNodes.filter((n: any) => n.type === 'PROPERTY_ASSIGNMENT').map((n: any) => n.name))}`
    );

    // Find the PROPERTY_ACCESS node for obj.prop
    const propAccess = allNodes.find((n: any) =>
      n.type === 'PROPERTY_ACCESS' && n.name === 'obj.prop'
    );
    assert.ok(
      propAccess,
      `PROPERTY_ACCESS node with name "obj.prop" not found. ` +
      `PROPERTY_ACCESS nodes: ${JSON.stringify(allNodes.filter((n: any) => n.type === 'PROPERTY_ACCESS').map((n: any) => n.name))}`
    );

    // Verify ASSIGNS_TO edge from PROPERTY_ASSIGNMENT to PROPERTY_ACCESS
    const assignsToEdge = allEdges.find((e: any) =>
      e.type === 'ASSIGNS_TO' &&
      e.src === propAssign.id &&
      e.dst === propAccess.id
    );
    assert.ok(
      assignsToEdge,
      `Expected ASSIGNS_TO edge from PROPERTY_ASSIGNMENT(${propAssign.id}) to PROPERTY_ACCESS(${propAccess.id}). ` +
      `ASSIGNS_TO edges: ${JSON.stringify(allEdges.filter((e: any) => e.type === 'ASSIGNS_TO').map((e: any) => ({ src: e.src, dst: e.dst })))}`
    );
  });

  // ---------------------------------------------------------------------------
  // Test 4: x = 5 should NOT produce structural ASSIGNS_TO
  // ---------------------------------------------------------------------------
  it('x = 5 should NOT produce structural ASSIGNS_TO (deferred produces WRITES_TO)', async () => {
    await setupTest(backend, {
      'index.js': `
let x = 0;
x = 5;
      `
    });

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    // Find the VARIABLE node for x
    const xVar = allNodes.find((n: any) =>
      n.name === 'x' && n.type === 'VARIABLE'
    );
    assert.ok(xVar, 'VARIABLE "x" not found');

    // Find the EXPRESSION node for the = operator
    const exprNode = allNodes.find((n: any) =>
      n.type === 'EXPRESSION' && n.name === '='
    );
    assert.ok(exprNode, 'EXPRESSION node with name "=" not found');

    // There SHOULD be a WRITES_TO edge from EXPRESSION to VARIABLE (via deferred)
    const writesToFromDeferred = allEdges.find((e: any) =>
      e.type === 'WRITES_TO' &&
      e.src === exprNode.id &&
      e.dst === xVar.id
    );
    assert.ok(
      writesToFromDeferred,
      `Expected WRITES_TO edge from EXPRESSION to VARIABLE "x" (via deferred). ` +
      `WRITES_TO edges: ${JSON.stringify(allEdges.filter((e: any) => e.type === 'WRITES_TO').map((e: any) => ({ src: e.src, dst: e.dst })))}`
    );

    // There should NOT be an ASSIGNS_TO structural edge
    // (visitIdentifier returns EMPTY_RESULT for assignment LHS, so edge-map doesn't fire)
    const assignsToEdge = allEdges.find((e: any) =>
      e.type === 'ASSIGNS_TO' &&
      e.src === exprNode.id
    );
    assert.ok(
      !assignsToEdge,
      `Should NOT have ASSIGNS_TO structural edge for simple x = 5 ` +
      `(visitIdentifier returns EMPTY_RESULT for assignment LHS). ` +
      `Found: ${JSON.stringify(assignsToEdge)}`
    );
  });

  // ---------------------------------------------------------------------------
  // Test 5: a.b.c = value should produce ASSIGNS_TO for chained member
  // ---------------------------------------------------------------------------
  it('a.b.c = value produces ASSIGNS_TO for chained member expression', async () => {
    await setupTest(backend, {
      'index.js': `
const a = { b: { c: 0 } };
a.b.c = 99;
      `
    });

    const allNodes = await backend.getAllNodes();
    const allEdges = await backend.getAllEdges();

    const propAssign = allNodes.find((n: any) =>
      n.type === 'PROPERTY_ASSIGNMENT' && n.name === 'a.b.c'
    );
    assert.ok(propAssign, 'PROPERTY_ASSIGNMENT(a.b.c) not found');

    // ASSIGNS_TO should link to a child node
    const assignsToEdge = allEdges.find((e: any) =>
      e.type === 'ASSIGNS_TO' && e.src === propAssign.id
    );
    assert.ok(
      assignsToEdge,
      `Expected ASSIGNS_TO edge from PROPERTY_ASSIGNMENT(a.b.c). ` +
      `Edges from PA: ${JSON.stringify(allEdges.filter((e: any) => e.src === propAssign.id).map((e: any) => ({ type: e.type, dst: e.dst })))}`
    );
  });
});
