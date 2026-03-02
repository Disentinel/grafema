/**
 * Integration tests for Conditional Value Sets (REG-574)
 *
 * Tests that traceValues correctly follows conditional edges through
 * the real V2 analysis pipeline:
 * - Ternary: HAS_CONSEQUENT / HAS_ALTERNATE
 * - Logical: USES on ||, &&, ??
 * - If/else reassignment: WRITES_TO
 *
 * Uses createTestDatabase + full analysis pipeline (not mocks).
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { traceValues, aggregateValues } from '@grafema/core';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

after(cleanupAllTestDatabases);

let testCounter = 0;

async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `navi-test-conditional-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({ name: `test-conditional-${testCounter}`, type: 'module' })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Find a VARIABLE node by name in the graph.
 */
async function findVariable(backend, name) {
  const results = [];
  for await (const node of backend.queryNodes({ nodeType: 'VARIABLE', name })) {
    results.push(node);
  }
  // Also check CONSTANT nodes (const declarations)
  for await (const node of backend.queryNodes({ nodeType: 'CONSTANT', name })) {
    results.push(node);
  }
  return results[0] || null;
}

describe('Conditional Value Sets — Integration (REG-574)', () => {
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
  // Ternary Expressions
  // ==========================================================================

  it('ternary literal: const x = true ? "yes" : "no" → both values', async () => {
    await setupTest(backend, {
      'index.js': `const x = true ? 'yes' : 'no';\n`,
    });

    const varX = await findVariable(backend, 'x');
    assert.ok(varX, 'Variable x should exist in graph');

    const traced = await traceValues(backend, varX.id);
    const agg = aggregateValues(traced);

    assert.ok(
      agg.values.includes('yes'),
      `Should include 'yes'. Got values: ${JSON.stringify(agg.values)}, traced: ${JSON.stringify(traced.map(t => ({ value: t.value, reason: t.reason, source: t.source.id })))}`
    );
    assert.ok(
      agg.values.includes('no'),
      `Should include 'no'. Got values: ${JSON.stringify(agg.values)}`
    );
  });

  // ==========================================================================
  // Logical Expressions
  // ==========================================================================

  it('logical OR default: const x = getValue() || "default" → null + "default"', async () => {
    // REG-576: traceValues now follows through function calls via CALL_RETURNS edges.
    // getValue() returns null (concrete value), so no unknown — both branches are resolved.
    await setupTest(backend, {
      'index.js': `
function getValue() { return null; }
const x = getValue() || 'default';
`,
    });

    const varX = await findVariable(backend, 'x');
    assert.ok(varX, 'Variable x should exist in graph');

    const traced = await traceValues(backend, varX.id);
    const agg = aggregateValues(traced);

    assert.ok(
      agg.values.includes('default'),
      `Should include 'default'. Got values: ${JSON.stringify(agg.values)}, traced: ${JSON.stringify(traced.map(t => ({ value: t.value, reason: t.reason, source: t.source.id })))}`
    );
    // null is a concrete LITERAL value (filtered by aggregateValues), not unknown
    assert.strictEqual(
      agg.hasUnknown, false,
      `Should NOT have unknown — getValue() return is now traced via CALL_RETURNS. Got traced: ${JSON.stringify(traced.map(t => ({ value: t.value, reason: t.reason })))}`
    );
  });

  it('nullish coalescing: const x = val ?? "fallback"', async () => {
    await setupTest(backend, {
      'index.js': `
function getVal() { return null; }
const val = getVal();
const x = val ?? 'fallback';
`,
    });

    const varX = await findVariable(backend, 'x');
    assert.ok(varX, 'Variable x should exist in graph');

    const traced = await traceValues(backend, varX.id);
    const agg = aggregateValues(traced);

    assert.ok(
      agg.values.includes('fallback'),
      `Should include 'fallback'. Got values: ${JSON.stringify(agg.values)}, traced: ${JSON.stringify(traced.map(t => ({ value: t.value, reason: t.reason, source: t.source.id })))}`
    );
  });

  // ==========================================================================
  // If/Else Reassignment (WRITES_TO)
  // ==========================================================================

  it('if/else reassignment: let x; if(c) x="a"; else x="b" → both values', async () => {
    await setupTest(backend, {
      'index.js': `
const c = true;
let x;
if (c) {
  x = 'a';
} else {
  x = 'b';
}
`,
    });

    const varX = await findVariable(backend, 'x');
    assert.ok(varX, 'Variable x should exist in graph');

    const traced = await traceValues(backend, varX.id);
    const agg = aggregateValues(traced);

    assert.ok(
      agg.values.includes('a'),
      `Should include 'a'. Got values: ${JSON.stringify(agg.values)}, traced: ${JSON.stringify(traced.map(t => ({ value: t.value, reason: t.reason, source: t.source.id })))}`
    );
    assert.ok(
      agg.values.includes('b'),
      `Should include 'b'. Got values: ${JSON.stringify(agg.values)}`
    );
  });

  it('init + reassignment: let x = "init"; if(c) x = "changed" → both values', async () => {
    await setupTest(backend, {
      'index.js': `
const c = true;
let x = 'init';
if (c) {
  x = 'changed';
}
`,
    });

    const varX = await findVariable(backend, 'x');
    assert.ok(varX, 'Variable x should exist in graph');

    const traced = await traceValues(backend, varX.id);
    const agg = aggregateValues(traced);

    assert.ok(
      agg.values.includes('init'),
      `Should include 'init'. Got values: ${JSON.stringify(agg.values)}, traced: ${JSON.stringify(traced.map(t => ({ value: t.value, reason: t.reason, source: t.source.id })))}`
    );
    assert.ok(
      agg.values.includes('changed'),
      `Should include 'changed'. Got values: ${JSON.stringify(agg.values)}`
    );
  });
});
