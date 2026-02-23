/**
 * EXPORT node column tests (REG-549)
 *
 * Bug: Named export specifiers all get column=0 (the export keyword position)
 * instead of each specifier's own column.
 *
 * Expected: `export { foo, bar }` should produce EXPORT nodes at the column
 * of each specifier name, not both at column 0.
 *
 * These tests run the full pipeline (parse -> visit -> build -> assert node position)
 * following the same pattern as ExpressionNodeColumn.test.js.
 *
 * TDD: Tests written first. They should FAIL until the fix is implemented.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { analyzeProject } from '../helpers/createTestOrchestrator.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

after(cleanupAllTestDatabases);

describe('EXPORT node column values (REG-549)', () => {
  let testCounter = 0;

  async function setupTest(files) {
    const testDir = join(tmpdir(), `grafema-test-export-col-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'export-column-test',
      version: '1.0.0',
      type: 'module'
    }));

    for (const [name, content] of Object.entries(files)) {
      const filePath = join(testDir, name);
      const dir = join(filePath, '..');
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, content);
    }

    const db = await createTestDatabase();
    const backend = db.backend;

    await analyzeProject(backend, testDir);
    await backend.flush();

    return { backend, testDir };
  }

  async function cleanup(backend, testDir) {
    await backend.close();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  /**
   * Helper: find all EXPORT nodes, optionally filtered by name.
   */
  async function findExportNodes(backend, name) {
    const results = [];
    for await (const node of backend.queryNodes({ type: 'EXPORT' })) {
      if (name === undefined || node.name === name) {
        results.push(node);
      }
    }
    return results;
  }

  // =========================================================================
  // Test 1: Single specifier column
  // =========================================================================

  it('should store column of specifier name, not column 0 (single specifier)', async () => {
    // "export { foo }" — foo is NOT at column 0
    const { backend, testDir } = await setupTest({
      'index.js': `const foo = 42;
export { foo };
`
    });

    try {
      const exports = await findExportNodes(backend, 'foo');
      assert.strictEqual(exports.length, 1, 'Should find exactly one EXPORT node for foo');

      const fooExport = exports[0];
      // "export { foo };" — foo starts at column 9 (0-based)
      assert.ok(fooExport.column > 0,
        `EXPORT foo column should be > 0 (specifier position), got ${fooExport.column}`);
      assert.strictEqual(fooExport.column, 9,
        `EXPORT foo should be at column 9, got ${fooExport.column}`);
    } finally {
      await cleanup(backend, testDir);
    }
  });

  // =========================================================================
  // Test 2: Multiple specifiers have distinct columns
  // =========================================================================

  it('should store distinct columns for each specifier in multi-export', async () => {
    // "export { foo, bar };" — foo and bar are at different columns
    const { backend, testDir } = await setupTest({
      'index.js': `const foo = 1;
const bar = 2;
export { foo, bar };
`
    });

    try {
      const fooExports = await findExportNodes(backend, 'foo');
      const barExports = await findExportNodes(backend, 'bar');

      assert.strictEqual(fooExports.length, 1, 'Should find one EXPORT for foo');
      assert.strictEqual(barExports.length, 1, 'Should find one EXPORT for bar');

      const fooCol = fooExports[0].column;
      const barCol = barExports[0].column;

      // Both should NOT be at column 0
      assert.ok(fooCol > 0, `foo column should be > 0, got ${fooCol}`);
      assert.ok(barCol > 0, `bar column should be > 0, got ${barCol}`);

      // They must be at different columns
      assert.notStrictEqual(fooCol, barCol,
        `foo (col ${fooCol}) and bar (col ${barCol}) should have distinct columns`);

      // "export { foo, bar };" — foo at column 9, bar at column 14
      assert.strictEqual(fooCol, 9, `foo should be at column 9, got ${fooCol}`);
      assert.strictEqual(barCol, 14, `bar should be at column 14, got ${barCol}`);
    } finally {
      await cleanup(backend, testDir);
    }
  });

  // =========================================================================
  // Test 3: Re-export specifiers
  // =========================================================================

  it('should store per-specifier columns for re-exports', async () => {
    // "export { foo, bar } from './module';" — each specifier at its own column
    const { backend, testDir } = await setupTest({
      'module.js': `export const foo = 1;
export const bar = 2;
`,
      'index.js': `export { foo, bar } from './module.js';
`
    });

    try {
      // Filter to exports from index.js only (module.js also has exports)
      const allExports = await findExportNodes(backend);
      const indexExports = allExports.filter(n => n.file.endsWith('index.js'));

      const fooExport = indexExports.find(n => n.name === 'foo');
      const barExport = indexExports.find(n => n.name === 'bar');

      assert.ok(fooExport, 'Should find re-exported foo from index.js');
      assert.ok(barExport, 'Should find re-exported bar from index.js');

      assert.ok(fooExport.column > 0,
        `Re-export foo column should be > 0, got ${fooExport.column}`);
      assert.ok(barExport.column > 0,
        `Re-export bar column should be > 0, got ${barExport.column}`);
      assert.notStrictEqual(fooExport.column, barExport.column,
        `Re-export foo and bar should have distinct columns`);
    } finally {
      await cleanup(backend, testDir);
    }
  });

  // =========================================================================
  // Test 4: Type export specifiers
  // =========================================================================

  it('should store per-specifier columns for type exports', async () => {
    // "export type { Foo, Bar };" — each type name at its own column
    // Use index.ts as entrypoint that imports from types.ts so both get indexed
    const { backend, testDir } = await setupTest({
      'types.ts': `interface Foo { x: number; }
interface Bar { y: string; }
export type { Foo, Bar };
`,
      'index.ts': `import type { Foo, Bar } from './types.js';
const x: Foo = { x: 1 };
const y: Bar = { y: 'a' };
export { x, y };
`
    });

    try {
      const allExports = await findExportNodes(backend);
      const typeExports = allExports.filter(n => n.file.endsWith('types.ts'));

      const fooExport = typeExports.find(n => n.name === 'Foo');
      const barExport = typeExports.find(n => n.name === 'Bar');

      assert.ok(fooExport, 'Should find type-exported Foo');
      assert.ok(barExport, 'Should find type-exported Bar');

      assert.ok(fooExport.column > 0,
        `Type export Foo column should be > 0, got ${fooExport.column}`);
      assert.ok(barExport.column > 0,
        `Type export Bar column should be > 0, got ${barExport.column}`);
      assert.notStrictEqual(fooExport.column, barExport.column,
        `Type export Foo and Bar should have distinct columns`);
    } finally {
      await cleanup(backend, testDir);
    }
  });

  // =========================================================================
  // Test 5: Renamed specifier — column of local name
  // =========================================================================

  it('should store column of local name position for renamed specifier', async () => {
    // "export { foo as baz };" — column should be at foo (local name), not baz
    const { backend, testDir } = await setupTest({
      'index.js': `const foo = 42;
export { foo as baz };
`
    });

    try {
      const exports = await findExportNodes(backend, 'baz');
      assert.strictEqual(exports.length, 1, 'Should find EXPORT node for baz');

      const bazExport = exports[0];
      // "export { foo as baz };" — the specifier node starts at column 9 (position of "foo")
      assert.ok(bazExport.column > 0,
        `Renamed export column should be > 0, got ${bazExport.column}`);
      assert.strictEqual(bazExport.column, 9,
        `Renamed export should be at column 9 (specifier start), got ${bazExport.column}`);
    } finally {
      await cleanup(backend, testDir);
    }
  });

  // =========================================================================
  // Test 6: Multi-line export — each specifier on its own line
  // =========================================================================

  it('should store per-specifier line and column for multi-line export', async () => {
    // Each specifier on its own line should get its own line number AND column
    const { backend, testDir } = await setupTest({
      'index.js': `const alpha = 1;
const beta = 2;
const gamma = 3;
export {
  alpha,
  beta,
  gamma
};
`
    });

    try {
      const alphaExports = await findExportNodes(backend, 'alpha');
      const betaExports = await findExportNodes(backend, 'beta');
      const gammaExports = await findExportNodes(backend, 'gamma');

      assert.strictEqual(alphaExports.length, 1, 'Should find EXPORT for alpha');
      assert.strictEqual(betaExports.length, 1, 'Should find EXPORT for beta');
      assert.strictEqual(gammaExports.length, 1, 'Should find EXPORT for gamma');

      const alpha = alphaExports[0];
      const beta = betaExports[0];
      const gamma = gammaExports[0];

      // When specifiers are on separate lines, they should NOT all share
      // the same column=0 from the export keyword
      // "  alpha," starts at column 2 on its own line
      assert.ok(alpha.column > 0,
        `Multi-line alpha column should be > 0, got ${alpha.column}`);
      assert.ok(beta.column > 0,
        `Multi-line beta column should be > 0, got ${beta.column}`);
      assert.ok(gamma.column > 0,
        `Multi-line gamma column should be > 0, got ${gamma.column}`);

      // Each specifier is indented the same, so they share the same column
      assert.strictEqual(alpha.column, beta.column,
        'Identically-indented specifiers should share column');
      assert.strictEqual(beta.column, gamma.column,
        'Identically-indented specifiers should share column');
    } finally {
      await cleanup(backend, testDir);
    }
  });

  // =========================================================================
  // Test 7: Regression guard — declaration exports keep statement position
  // =========================================================================

  it('should keep column at statement position for declaration exports (regression guard)', async () => {
    // "export function foo() {}" — the export statement starts at column 0
    // This should NOT be broken by the specifier column fix.
    const { backend, testDir } = await setupTest({
      'index.js': `export function myFunc() { return 1; }
export class MyClass {}
export const myConst = 42;
`
    });

    try {
      const funcExports = await findExportNodes(backend, 'myFunc');
      const classExports = await findExportNodes(backend, 'MyClass');
      const constExports = await findExportNodes(backend, 'myConst');

      assert.strictEqual(funcExports.length, 1, 'Should find EXPORT for myFunc');
      assert.strictEqual(classExports.length, 1, 'Should find EXPORT for MyClass');
      assert.strictEqual(constExports.length, 1, 'Should find EXPORT for myConst');

      // Declaration exports: column stays at statement position (column 0)
      // because the export keyword IS the declaration start
      assert.strictEqual(funcExports[0].column, 0,
        `Declaration export function column should be 0, got ${funcExports[0].column}`);
      assert.strictEqual(classExports[0].column, 0,
        `Declaration export class column should be 0, got ${classExports[0].column}`);
      assert.strictEqual(constExports[0].column, 0,
        `Declaration export const column should be 0, got ${constExports[0].column}`);
    } finally {
      await cleanup(backend, testDir);
    }
  });

  // =========================================================================
  // Test 8: export * as ns — ExportNamespaceSpecifier type guard
  // =========================================================================

  it('should not create EXPORT node with wrong column for export * as ns', async () => {
    // "export * as utils from './mod';" — ExportNamespaceSpecifier
    // The type guard `spec.type !== 'ExportSpecifier'` should skip this.
    // If it leaks through, the column would be wrong.
    const { backend, testDir } = await setupTest({
      'mod.js': `export const a = 1;
export const b = 2;
`,
      'index.js': `export * as utils from './mod.js';
`
    });

    try {
      const allExports = await findExportNodes(backend);
      const indexExports = allExports.filter(n => n.file.endsWith('index.js'));

      // ExportNamespaceSpecifier should NOT produce an EXPORT node via the
      // specifier loop (which has `spec.type !== 'ExportSpecifier'` guard).
      // If any EXPORT node for "utils" exists with column=0, the type guard
      // failed to filter it out.
      const utilsExportFromSpecifierLoop = indexExports.find(
        n => n.name === 'utils' && n.column === 0
      );
      assert.strictEqual(utilsExportFromSpecifierLoop, undefined,
        'ExportNamespaceSpecifier should not produce an EXPORT node via specifier loop with column=0');
    } finally {
      await cleanup(backend, testDir);
    }
  });

  // =========================================================================
  // Test 9: IMPORT vs EXPORT column parity (REG-549 acceptance criteria)
  // =========================================================================

  it('should position IMPORT and EXPORT columns symmetrically at the specifier name', async () => {
    // Both import and export of the same symbols in a single file.
    // The column for each symbol should point at the specifier's name,
    // NOT at column 0 (the keyword position). This proves the convention
    // is symmetric: imports and exports follow the same positioning rule.
    const { backend, testDir } = await setupTest({
      'source.js': `export const alpha = 1;
export const beta = 2;
`,
      'index.js': `import { alpha, beta } from './source.js';
export { alpha, beta };
`
    });

    try {
      // --- Collect IMPORT nodes from index.js ---
      const allImports = [];
      for await (const node of backend.queryNodes({ type: 'IMPORT' })) {
        if (node.file.endsWith('index.js')) {
          allImports.push(node);
        }
      }
      const alphaImport = allImports.find(n => n.name === 'alpha');
      const betaImport = allImports.find(n => n.name === 'beta');

      assert.ok(alphaImport, 'Should find IMPORT node for alpha in index.js');
      assert.ok(betaImport, 'Should find IMPORT node for beta in index.js');

      // --- Collect EXPORT nodes from index.js ---
      const allExports = await findExportNodes(backend);
      const indexExports = allExports.filter(n => n.file.endsWith('index.js'));
      const alphaExport = indexExports.find(n => n.name === 'alpha');
      const betaExport = indexExports.find(n => n.name === 'beta');

      assert.ok(alphaExport, 'Should find EXPORT node for alpha in index.js');
      assert.ok(betaExport, 'Should find EXPORT node for beta in index.js');

      // --- Neither IMPORT nor EXPORT should sit at column 0 ---
      assert.ok(alphaImport.column > 0,
        `IMPORT alpha column should be > 0 (at specifier name), got ${alphaImport.column}`);
      assert.ok(betaImport.column > 0,
        `IMPORT beta column should be > 0 (at specifier name), got ${betaImport.column}`);
      assert.ok(alphaExport.column > 0,
        `EXPORT alpha column should be > 0 (at specifier name), got ${alphaExport.column}`);
      assert.ok(betaExport.column > 0,
        `EXPORT beta column should be > 0 (at specifier name), got ${betaExport.column}`);

      // --- Parity check: same identifier -> same column offset from its keyword ---
      // "import { alpha, beta } from './source.js';"
      //           ^col=9  ^col=16
      // "export { alpha, beta };"
      //           ^col=9  ^col=16
      //
      // Both lines use identical `{ alpha, beta }` layout, so the columns
      // for each name must match across IMPORT and EXPORT.
      assert.strictEqual(alphaImport.column, alphaExport.column,
        `IMPORT alpha (col ${alphaImport.column}) and EXPORT alpha (col ${alphaExport.column}) ` +
        'should have the same column — both point at the specifier name');
      assert.strictEqual(betaImport.column, betaExport.column,
        `IMPORT beta (col ${betaImport.column}) and EXPORT beta (col ${betaExport.column}) ` +
        'should have the same column — both point at the specifier name');

      // --- Distinct columns within each statement ---
      assert.notStrictEqual(alphaImport.column, betaImport.column,
        'IMPORT alpha and beta should be at different columns');
      assert.notStrictEqual(alphaExport.column, betaExport.column,
        'EXPORT alpha and beta should be at different columns');
    } finally {
      await cleanup(backend, testDir);
    }
  });
});
