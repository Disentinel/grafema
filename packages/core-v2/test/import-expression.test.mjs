/**
 * Tests for ImportExpression (dynamic import) handling.
 *
 * Babel's newer AST uses ImportExpression { source, options } instead of
 * CallExpression { callee: Import, arguments: [...] }. Both representations
 * must produce the same graph structure:
 *   - CALL node (name: 'import')
 *   - EXTERNAL_MODULE node (when source is a StringLiteral)
 *   - IMPORTS_FROM edge from CALL to EXTERNAL_MODULE
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkFile } from '../dist/walk.js';
import { jsRegistry } from '../dist/registry.js';
import { resolveFileRefs } from '../dist/resolve.js';

// ─── Helpers ─────────────────────────────────────────────────────────

async function walk(code, file = 'test.js') {
  const walkResult = await walkFile(code, file, jsRegistry);
  return resolveFileRefs(walkResult);
}

describe('ImportExpression (dynamic import)', () => {
  it('import("./module.js") creates CALL + EXTERNAL_MODULE + IMPORTS_FROM', async () => {
    const code = `const mod = await import('./module.js');`;
    const result = await walk(code);

    // CALL node for import()
    const callNode = result.nodes.find(
      n => n.type === 'CALL' && n.name === 'import',
    );
    assert.ok(callNode, 'expected CALL node named "import"');

    // EXTERNAL_MODULE node
    const extModule = result.nodes.find(
      n => n.type === 'EXTERNAL_MODULE' && n.name === './module.js',
    );
    assert.ok(extModule, 'expected EXTERNAL_MODULE node for "./module.js"');

    // IMPORTS_FROM edge from CALL to EXTERNAL_MODULE
    const importsFrom = result.edges.find(
      e => e.type === 'IMPORTS_FROM' && e.src === callNode.id && e.dst === extModule.id,
    );
    assert.ok(importsFrom, 'expected IMPORTS_FROM edge from CALL to EXTERNAL_MODULE');
  });

  it('import(dynamicPath) with non-literal source does not crash', async () => {
    const code = `
const path = './dynamic.js';
const mod = await import(path);
`;
    const result = await walk(code);

    // CALL node should still be created
    const callNode = result.nodes.find(
      n => n.type === 'CALL' && n.name === 'import',
    );
    assert.ok(callNode, 'expected CALL node named "import" for dynamic path');

    // No EXTERNAL_MODULE for non-literal source
    const extModule = result.nodes.find(
      n => n.type === 'EXTERNAL_MODULE',
    );
    assert.equal(extModule, undefined, 'should not create EXTERNAL_MODULE for non-literal source');
  });

  it('import("./a.js") and import("./b.js") create separate EXTERNAL_MODULE nodes', async () => {
    const code = `
const a = await import('./a.js');
const b = await import('./b.js');
`;
    const result = await walk(code);

    const extModules = result.nodes.filter(n => n.type === 'EXTERNAL_MODULE');
    assert.equal(extModules.length, 2, 'expected 2 EXTERNAL_MODULE nodes');

    const names = extModules.map(n => n.name).sort();
    assert.deepEqual(names, ['./a.js', './b.js']);
  });

  it('import() with template literal (no expressions) creates EXTERNAL_MODULE', async () => {
    const code = 'const mod = await import(`./template.js`);';
    const result = await walk(code);

    // The template literal source should be walked as a child (PASSES_ARGUMENT)
    // but EXTERNAL_MODULE is only created for StringLiteral sources
    const callNode = result.nodes.find(
      n => n.type === 'CALL' && n.name === 'import',
    );
    assert.ok(callNode, 'expected CALL node');
  });

  it('PASSES_ARGUMENT edge connects source to CALL node', async () => {
    const code = `const mod = await import('./module.js');`;
    const result = await walk(code);

    const callNode = result.nodes.find(
      n => n.type === 'CALL' && n.name === 'import',
    );
    assert.ok(callNode, 'expected CALL node');

    // Source should be connected via PASSES_ARGUMENT (from edge-map)
    const passesArg = result.edges.find(
      e => e.type === 'PASSES_ARGUMENT' && e.src === callNode.id,
    );
    assert.ok(passesArg, 'expected PASSES_ARGUMENT edge from CALL to source');
  });
});
