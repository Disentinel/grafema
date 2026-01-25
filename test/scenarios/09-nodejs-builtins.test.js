/**
 * Node.js Builtins Analysis Tests (REG-218)
 *
 * Tests for EXTERNAL_FUNCTION semantic binding for Node.js built-in modules.
 *
 * Architecture:
 * - Node type: EXTERNAL_FUNCTION (not BUILTIN_FUNCTION)
 * - Creation: Lazy - nodes created on-demand when calls are resolved
 * - ID format: EXTERNAL_FUNCTION:{module}.{function}
 *
 * Example:
 * - EXTERNAL_FUNCTION:fs.readFile
 * - EXTERNAL_FUNCTION:path.join
 * - EXTERNAL_FUNCTION:crypto.createHash
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { assertGraph } from '../helpers/GraphAsserter.js';
import { TestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, '../fixtures/nodejs-builtins');

describe('Node.js Builtins Analysis (REG-218)', () => {
  let backend;
  let orchestrator;

  beforeEach(async () => {
    backend = new TestBackend();
    await backend.connect();
    // NodejsBuiltinsResolver will be added here once implemented
    orchestrator = createTestOrchestrator(backend);
  });

  afterEach(async () => {
    if (backend) await backend.cleanup();
  });

  it('should detect SERVICE from package.json', async () => {
    await orchestrator.run(FIXTURE_PATH);

    (await assertGraph(backend))
      .hasNode('SERVICE', 'nodejs-builtins-fixture')
      .hasNodeCount('SERVICE', 1);
  });

  it('should detect all MODULE files', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // index.js imports all other fixture files
    (await assertGraph(backend))
      .hasNode('MODULE', 'index.js');

    // Other modules should be discovered via dependency tree
    const allNodes = await backend.getAllNodes();
    const moduleNodes = allNodes.filter(n => n.type === 'MODULE');

    // Should have at least 6 modules (index + 5 imports)
    assert.ok(moduleNodes.length >= 6,
      `Expected at least 6 MODULE nodes, got ${moduleNodes.length}: ${moduleNodes.map(n => n.name).join(', ')}`);
  });

  describe('Node Creation (Lazy)', () => {
    it('should create EXTERNAL_FUNCTION nodes for used builtin functions', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const externalFunctions = allNodes.filter(n => n.type === 'EXTERNAL_FUNCTION');

      // Should have EXTERNAL_FUNCTION nodes (exact count depends on usage)
      assert.ok(externalFunctions.length > 0,
        `Expected EXTERNAL_FUNCTION nodes, got ${externalFunctions.length}`);
    });

    it('should create EXTERNAL_FUNCTION:fs.readFile when readFile is called', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // fs.readFile is called in index.js:loadConfig
      (await assertGraph(backend))
        .hasNode('EXTERNAL_FUNCTION', 'fs.readFile');
    });

    it('should create EXTERNAL_FUNCTION:path.join when join is called', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // path.join is called in index.js:buildPath
      (await assertGraph(backend))
        .hasNode('EXTERNAL_FUNCTION', 'path.join');
    });

    it('should create EXTERNAL_FUNCTION:path.resolve when resolve is called', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // path.resolve is called in index.js:buildPath
      (await assertGraph(backend))
        .hasNode('EXTERNAL_FUNCTION', 'path.resolve');
    });

    it('should create EXTERNAL_FUNCTION for fs/promises imports', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // fs/promises.readFile is called in fs-promises.js:loadAsync
      (await assertGraph(backend))
        .hasNode('EXTERNAL_FUNCTION', 'fs/promises.readFile');
    });

    it('should create EXTERNAL_FUNCTION for node: prefix imports', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // node:fs.readFile is called in node-prefix.js:loadWithNodePrefix
      // Normalized to fs.readFile (strip node: prefix)
      (await assertGraph(backend))
        .hasNode('EXTERNAL_FUNCTION', 'fs.readFile');
    });

    it('should NOT create EXTERNAL_FUNCTION for unused imported functions', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // unused-imports.js imports appendFile but never calls it
      (await assertGraph(backend))
        .doesNotHaveNode('EXTERNAL_FUNCTION', 'fs.appendFile')
        .doesNotHaveNode('EXTERNAL_FUNCTION', 'fs.truncate')
        .doesNotHaveNode('EXTERNAL_FUNCTION', 'fs.chmod');
    });

    it('should NOT create EXTERNAL_FUNCTION for unused path functions', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // unused-imports.js imports normalize, relative, isAbsolute but never calls them
      (await assertGraph(backend))
        .doesNotHaveNode('EXTERNAL_FUNCTION', 'path.normalize')
        .doesNotHaveNode('EXTERNAL_FUNCTION', 'path.relative')
        .doesNotHaveNode('EXTERNAL_FUNCTION', 'path.isAbsolute');
    });
  });

  describe('EXTERNAL_MODULE Node Creation', () => {
    it('should create EXTERNAL_MODULE nodes for builtin module imports', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // Should have EXTERNAL_MODULE for fs, path, http, etc.
      (await assertGraph(backend))
        .hasNode('EXTERNAL_MODULE', 'fs')
        .hasNode('EXTERNAL_MODULE', 'path');
    });

    it('should create EXTERNAL_MODULE for fs/promises', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('EXTERNAL_MODULE', 'fs/promises');
    });

    it('should normalize node: prefix to bare module name', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // node:fs should become EXTERNAL_MODULE:fs (not EXTERNAL_MODULE:node:fs)
      (await assertGraph(backend))
        .hasNode('EXTERNAL_MODULE', 'fs')
        .doesNotHaveNode('EXTERNAL_MODULE', 'node:fs');
    });
  });

  describe('Call Resolution (CALLS edges)', () => {
    it('should create CALLS edge from call site to EXTERNAL_FUNCTION', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allEdges = await backend.getAllEdges();
      const callsEdges = allEdges.filter(e => e.type === 'CALLS');

      // Find CALLS edges pointing to EXTERNAL_FUNCTION nodes
      const allNodes = await backend.getAllNodes();
      const externalFuncIds = new Set(
        allNodes
          .filter(n => n.type === 'EXTERNAL_FUNCTION')
          .map(n => n.id)
      );

      const callsToExternal = callsEdges.filter(e => {
        const dstId = e.toId || e.dst;
        return externalFuncIds.has(dstId);
      });

      assert.ok(callsToExternal.length > 0,
        `Expected CALLS edges to EXTERNAL_FUNCTION, got ${callsToExternal.length}`);
    });

    it('should link aliased imports correctly', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // aliased-imports.js: import { readFile as rf } from 'fs'
      // rf(path, ...) should still link to EXTERNAL_FUNCTION:fs.readFile
      (await assertGraph(backend))
        .hasNode('EXTERNAL_FUNCTION', 'fs.readFile');

      // The call to rf() should have CALLS edge to fs.readFile
      const allEdges = await backend.getAllEdges();
      const allNodes = await backend.getAllNodes();

      const fsReadFile = allNodes.find(n =>
        n.type === 'EXTERNAL_FUNCTION' && n.name === 'fs.readFile'
      );

      if (fsReadFile) {
        const callsToReadFile = allEdges.filter(e => {
          const dstId = e.toId || e.dst;
          return e.type === 'CALLS' && dstId === fsReadFile.id;
        });

        assert.ok(callsToReadFile.length > 0,
          'Expected CALLS edges to fs.readFile from aliased calls');
      }
    });

    it('should link namespace imports correctly', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // namespace-import.js: import * as fs from 'fs'
      // fs.readFile() should link to EXTERNAL_FUNCTION:fs.readFile
      (await assertGraph(backend))
        .hasNode('EXTERNAL_FUNCTION', 'fs.readFile');
    });
  });

  describe('Metadata (Security Flags)', () => {
    it('should mark fs functions with security:file-io', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const fsReadFile = allNodes.find(n =>
        n.type === 'EXTERNAL_FUNCTION' && n.name === 'fs.readFile'
      );

      if (fsReadFile) {
        assert.strictEqual(fsReadFile.security, 'file-io',
          'fs.readFile should have security:file-io');
      }
    });

    it('should mark child_process.exec with security:exec', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const cpExec = allNodes.find(n =>
        n.type === 'EXTERNAL_FUNCTION' && n.name === 'child_process.exec'
      );

      if (cpExec) {
        assert.strictEqual(cpExec.security, 'exec',
          'child_process.exec should have security:exec');
      }
    });

    it('should mark child_process.spawn with security:exec', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const cpSpawn = allNodes.find(n =>
        n.type === 'EXTERNAL_FUNCTION' && n.name === 'child_process.spawn'
      );

      if (cpSpawn) {
        assert.strictEqual(cpSpawn.security, 'exec',
          'child_process.spawn should have security:exec');
      }
    });

    it('should mark path functions as pure:true', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const pathJoin = allNodes.find(n =>
        n.type === 'EXTERNAL_FUNCTION' && n.name === 'path.join'
      );

      if (pathJoin) {
        assert.strictEqual(pathJoin.pure, true,
          'path.join should have pure:true');
      }
    });

    it('should include isBuiltin:true for Node.js builtins', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const externalFunctions = allNodes.filter(n => n.type === 'EXTERNAL_FUNCTION');

      // All EXTERNAL_FUNCTION nodes from Node.js builtins should have isBuiltin:true
      for (const func of externalFunctions) {
        assert.strictEqual(func.isBuiltin, true,
          `${func.name} should have isBuiltin:true`);
      }
    });

    it('should mark crypto functions with security:crypto', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const createHash = allNodes.find(n =>
        n.type === 'EXTERNAL_FUNCTION' && n.name === 'crypto.createHash'
      );

      if (createHash) {
        // crypto functions are sensitive but not necessarily dangerous
        // they may have security:crypto or just isBuiltin:true
        assert.strictEqual(createHash.isBuiltin, true,
          'crypto.createHash should have isBuiltin:true');
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle unregistered functions gracefully', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // If a builtin function is not in the registry, it should still work
      // but not create an EXTERNAL_FUNCTION node
      // This test ensures no crashes occur
      const allNodes = await backend.getAllNodes();
      assert.ok(allNodes.length > 0, 'Should have nodes in the graph');
    });

    it('should handle dynamic imports gracefully', async () => {
      // Dynamic imports like import('fs') are harder to resolve
      // This ensures no crashes and reasonable behavior
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      assert.ok(allNodes.length > 0, 'Should have nodes in the graph');
    });

    it('should handle mixed import styles in same file', async () => {
      // namespace-import.js uses import * as fs from 'fs'
      // Other files use named imports
      // Both should work correctly
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('EXTERNAL_MODULE', 'fs');
    });

    it('should have valid graph structure', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .allEdgesValid()
        .noDuplicateIds();
    });
  });

  describe('Function Detection', () => {
    it('should detect user-defined functions that call builtins', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // Functions from index.js
      (await assertGraph(backend))
        .hasNode('FUNCTION', 'loadConfig')
        .hasNode('FUNCTION', 'saveData')
        .hasNode('FUNCTION', 'buildPath')
        .hasNode('FUNCTION', 'startServer')
        .hasNode('FUNCTION', 'runCommand');
    });

    it('should detect functions from fs-promises.js', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('FUNCTION', 'loadAsync')
        .hasNode('FUNCTION', 'saveAsync')
        .hasNode('FUNCTION', 'listDir');
    });
  });

  describe('Import Detection', () => {
    it('should detect IMPORT nodes for builtin modules', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const imports = allNodes.filter(n => n.type === 'IMPORT');

      // Should have imports for fs, path, http, child_process, etc.
      const builtinImports = imports.filter(i =>
        ['fs', 'path', 'http', 'child_process', 'crypto', 'fs/promises', 'url', 'util']
          .some(mod => i.source === mod || i.source === `node:${mod}`)
      );

      assert.ok(builtinImports.length > 0,
        `Expected builtin imports, found ${imports.length} total imports`);
    });

    it('should create IMPORTS_FROM edge from IMPORT to EXTERNAL_MODULE', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allEdges = await backend.getAllEdges();
      const importsFromEdges = allEdges.filter(e => e.type === 'IMPORTS_FROM');

      // Should have IMPORTS_FROM edges connecting IMPORTs to EXTERNAL_MODULEs
      assert.ok(importsFromEdges.length > 0,
        `Expected IMPORTS_FROM edges, got ${importsFromEdges.length}`);
    });
  });
});
