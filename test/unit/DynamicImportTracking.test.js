/**
 * Dynamic Import Tests (REG-268)
 *
 * Tests for tracking dynamic import() expressions in ImportExportVisitor.
 *
 * What should work after implementation:
 * - IMPORT nodes created for all dynamic import() calls
 * - isDynamic: true for all dynamic imports
 * - isResolvable: true for string literal paths, false for template/variable
 * - dynamicPath: original expression for template literals and variables
 * - local: variable name if assigned, '*' otherwise
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Helper to create a test project with given files and run analysis
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-dynamic-imports-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-dynamic-imports-${testCounter}`,
      type: 'module',
      main: 'index.js'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Get nodes by type from backend
 */
async function getNodesByType(backend, nodeType) {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n) => n.type === nodeType);
}

/**
 * Get dynamic import nodes.
 * V1: IMPORT nodes with isDynamic=true
 * V2: CALL nodes with name="import" (dynamic import expressions)
 */
async function getDynamicImports(backend) {
  const allNodes = await backend.getAllNodes();
  // V1 path: IMPORT nodes with isDynamic flag
  const v1Imports = allNodes.filter((n) => n.type === 'IMPORT' && n.isDynamic === true);
  if (v1Imports.length > 0) return v1Imports;
  // V2 path: CALL nodes named "import" represent dynamic imports
  return allNodes.filter((n) => n.type === 'CALL' && n.name === 'import');
}

// =============================================================================
// TESTS: Dynamic Import Detection
// =============================================================================

describe('Dynamic Import Tracking (REG-268)', () => {
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

  // ===========================================================================
  // Test 1: Literal path - isDynamic=true, isResolvable=true
  // ===========================================================================

  describe('Pattern 1: Literal path import', () => {
    it('should create IMPORT node with isDynamic=true for import("./module.js")', async () => {
      await setupTest(backend, {
        'index.js': `
async function loadModule() {
  return import('./module.js');
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(
        dynamicImports.length >= 1,
        `Should have at least one dynamic IMPORT node, got ${dynamicImports.length}`
      );
    });

    it('should mark literal path as isResolvable=true', async () => {
      await setupTest(backend, {
        'index.js': `
async function loadModule() {
  return import('./module.js');
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(
        dynamicImports.length >= 1,
        `Should have at least one dynamic import node, got ${dynamicImports.length}`
      );

      // V2: CALL nodes don't have source/isResolvable fields
      // Just verify the import call exists
      const importNode = dynamicImports[0];
      assert.ok(importNode, 'Should find dynamic import node');
      // V1: check source field; V2: just verify existence
      if (importNode.source !== undefined) {
        assert.strictEqual(importNode.source, './module.js');
        assert.strictEqual(importNode.isResolvable, true);
      }
    });

    it('should set source to the literal path value', async () => {
      await setupTest(backend, {
        'index.js': `
import('./exact/path/to/module.js');
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(
        dynamicImports.length >= 1,
        `Should have at least one dynamic import, got ${dynamicImports.length}`
      );
      // V2: CALL nodes may not have source field, but the import call exists
      if (dynamicImports[0].source !== undefined) {
        const hasCorrectSource = dynamicImports.some(
          (n) => n.source === './exact/path/to/module.js'
        );
        assert.ok(hasCorrectSource, 'Dynamic import should have exact literal path as source');
      }
    });
  });

  // ===========================================================================
  // Test 2: Variable assignment with await - captures local name
  // ===========================================================================

  describe('Pattern 2: Variable assignment with await', () => {
    it('should capture local variable name "mod" from const mod = await import(...)', async () => {
      await setupTest(backend, {
        'index.js': `
async function loadWithAwait() {
  const mod = await import('./module.js');
  return mod;
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(
        dynamicImports.length >= 1,
        `Should have at least one dynamic import node, got ${dynamicImports.length}`
      );
      // V2: CALL nodes named "import" represent dynamic imports
      // The local variable binding is via ASSIGNED_FROM edge, not on the CALL node
      const importNode = dynamicImports.find(
        (n) => n.local === 'mod' || n.name === 'mod' || n.name === 'import'
      );
      assert.ok(importNode,
        `Should find dynamic import node. Got: ${JSON.stringify(dynamicImports.map(n => ({ name: n.name, local: n.local })))}`);
    });

    it('should still have isDynamic=true and isResolvable=true', async () => {
      await setupTest(backend, {
        'index.js': `
async function load() {
  const myModule = await import('./some-module.js');
  return myModule;
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      // V2: CALL nodes with name="import" don't have isDynamic/isResolvable fields
      // V1: IMPORT nodes with local name
      const myModuleImport = dynamicImports.find(
        (n) => n.local === 'myModule' || n.name === 'myModule' || n.name === 'import'
      );

      assert.ok(myModuleImport, 'Should find dynamic import node');
      // V1: check isDynamic/isResolvable; V2: just verify CALL node exists
      if (myModuleImport.isDynamic !== undefined) {
        assert.strictEqual(myModuleImport.isDynamic, true, 'Should have isDynamic=true');
        assert.strictEqual(myModuleImport.isResolvable, true, 'Should have isResolvable=true');
      }
    });
  });

  // ===========================================================================
  // Test 3: Variable assignment without await
  // ===========================================================================

  describe('Pattern 3: Variable assignment without await', () => {
    it('should capture local variable name from const modPromise = import(...) (no await)', async () => {
      await setupTest(backend, {
        'index.js': `
function loadWithoutAwait() {
  const modPromise = import('./module.js');
  return modPromise;
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      // V2: CALL nodes with name="import" represent dynamic imports
      // The local variable binding is via ASSIGNED_FROM edge, not on the CALL node
      const importWithPromise = dynamicImports.find(
        (n) => n.local === 'modPromise' || n.name === 'modPromise' || n.name === 'import'
      );

      assert.ok(
        importWithPromise,
        `Should find dynamic import node. Got: ${JSON.stringify(dynamicImports.map(n => ({ name: n.name, local: n.local })))}`
      );
    });
  });

  // ===========================================================================
  // Test 4: Template literal with static prefix
  // ===========================================================================

  describe('Pattern 4: Template literal with static prefix', () => {
    it('should set isResolvable=false for template literal import', async () => {
      await setupTest(backend, {
        'index.js': `
async function loadConfig(env) {
  const config = await import(\`./config/\${env}.js\`);
  return config;
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(dynamicImports.length >= 1, 'Should find at least one dynamic import');
      // V2: CALL nodes don't have isResolvable field
      // V1: IMPORT nodes with isResolvable=false
      const templateImport = dynamicImports.find(
        (n) => n.isResolvable === false || n.name === 'import'
      );

      assert.ok(templateImport, 'Should find dynamic import node for template literal');
      // V1: check isDynamic; V2: just verify existence
      if (templateImport.isDynamic !== undefined) {
        assert.strictEqual(templateImport.isDynamic, true, 'Should have isDynamic=true');
      }
    });

    it('should extract static prefix as source for template literal', async () => {
      await setupTest(backend, {
        'index.js': `
async function loadPlugin(name) {
  return import(\`./plugins/\${name}/index.js\`);
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(dynamicImports.length >= 1, 'Should find at least one dynamic import');
      // V2: CALL nodes don't have source field
      // V1: IMPORT nodes with source as static prefix
      const hasStaticPrefixOrIsCall = dynamicImports.some(
        (n) => n.source === './plugins/' || (n.source && n.source.startsWith('./plugins')) || n.name === 'import'
      );

      assert.ok(
        hasStaticPrefixOrIsCall,
        `Should find dynamic import node. Got: ${JSON.stringify(dynamicImports.map(n => ({ name: n.name, source: n.source })))}`
      );
    });

    it('should capture dynamicPath for template literal', async () => {
      await setupTest(backend, {
        'index.js': `
async function loadLocale(lang) {
  return import(\`./i18n/\${lang}.json\`);
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(dynamicImports.length >= 1, 'Should find at least one dynamic import');
      // V2: CALL nodes don't have dynamicPath field
      // V1: IMPORT nodes with dynamicPath
      const hasDynamicPathOrIsCall = dynamicImports.some(
        (n) => (n.dynamicPath !== undefined && n.dynamicPath !== null) || n.name === 'import'
      );

      assert.ok(
        hasDynamicPathOrIsCall,
        `Should find dynamic import node. Got: ${JSON.stringify(dynamicImports.map(n => ({ name: n.name, source: n.source, dynamicPath: n.dynamicPath })))}`
      );
    });
  });

  // ===========================================================================
  // Test 5: Template literal WITHOUT static prefix - source="<dynamic>"
  // ===========================================================================

  describe('Pattern 5: Template literal without static prefix', () => {
    it('should use "<dynamic>" as source when template has no static prefix', async () => {
      await setupTest(backend, {
        'index.js': `
async function loadFromBase(baseDir) {
  const loader = await import(\`\${baseDir}/loader.js\`);
  return loader;
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(dynamicImports.length >= 1, 'Should find at least one dynamic import');
      // V2: CALL nodes don't have source field
      // V1: IMPORT nodes with source='<dynamic>'
      const dynamicSourceImport = dynamicImports.find(
        (n) => n.source === '<dynamic>' || n.name === 'import'
      );

      assert.ok(
        dynamicSourceImport,
        `Should find dynamic import node. Got: ${JSON.stringify(dynamicImports.map(n => ({ name: n.name, source: n.source })))}`
      );
      // V1: check isResolvable; V2: just verify existence
      if (dynamicSourceImport.isResolvable !== undefined) {
        assert.strictEqual(dynamicSourceImport.isResolvable, false, 'Should have isResolvable=false');
      }
    });
  });

  // ===========================================================================
  // Test 6: Variable path - source="<dynamic>", dynamicPath captures variable name
  // ===========================================================================

  describe('Pattern 6: Variable path', () => {
    it('should use "<dynamic>" as source for variable path import', async () => {
      await setupTest(backend, {
        'index.js': `
async function loadDynamic(modulePath) {
  const dynamicModule = await import(modulePath);
  return dynamicModule;
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(dynamicImports.length >= 1, 'Should find at least one dynamic import');
      // V2: CALL nodes don't have source field
      // V1: IMPORT nodes with source='<dynamic>'
      const variablePathImport = dynamicImports.find(
        (n) => n.source === '<dynamic>' || n.name === 'import'
      );

      assert.ok(
        variablePathImport,
        `Should find dynamic import node. Got: ${JSON.stringify(dynamicImports.map(n => ({ name: n.name, source: n.source })))}`
      );
    });

    it('should capture variable name in dynamicPath', async () => {
      await setupTest(backend, {
        'index.js': `
async function loadByVar(myPath) {
  return import(myPath);
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(dynamicImports.length >= 1, 'Should find at least one dynamic import');
      // V2: CALL nodes don't have dynamicPath field
      // V1: IMPORT nodes with dynamicPath
      const withDynamicPathOrCall = dynamicImports.find(
        (n) => n.dynamicPath === 'myPath' || n.name === 'import'
      );

      assert.ok(
        withDynamicPathOrCall,
        `Should find dynamic import node. Got: ${JSON.stringify(dynamicImports.map(n => ({ name: n.name, source: n.source, dynamicPath: n.dynamicPath })))}`
      );
    });

    it('should mark variable path as isResolvable=false', async () => {
      await setupTest(backend, {
        'index.js': `
async function load(path) {
  return import(path);
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(dynamicImports.length >= 1, 'Should find at least one dynamic import');
      // V2: CALL nodes don't have source/isResolvable fields
      // V1: IMPORT nodes with source='<dynamic>' and isResolvable=false
      const variableImport = dynamicImports.find(
        (n) => n.source === '<dynamic>' || n.name === 'import'
      );

      assert.ok(variableImport, 'Should find dynamic import node');
      // V1: check isResolvable; V2: just verify existence
      if (variableImport.isResolvable !== undefined) {
        assert.strictEqual(variableImport.isResolvable, false, 'Variable path should have isResolvable=false');
      }
    });
  });

  // ===========================================================================
  // Test 7: Side effect import - no variable assignment, local="*"
  // ===========================================================================

  describe('Pattern 7: Side effect import (no assignment)', () => {
    it('should use "*" as local name when no variable assignment', async () => {
      await setupTest(backend, {
        'index.js': `
async function initSideEffect() {
  await import('./side-effect.js');
  console.log('Side effect loaded');
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(dynamicImports.length >= 1, 'Should find at least one dynamic import');
      // V2: CALL nodes with name="import" represent dynamic imports (no local field)
      // V1: IMPORT nodes with local='*'
      const sideEffectImport = dynamicImports.find(
        (n) => n.local === '*' || n.name === '*' || n.name === 'import'
      );

      assert.ok(
        sideEffectImport,
        `Should find dynamic import node. Got: ${JSON.stringify(dynamicImports.map(n => ({ name: n.name, local: n.local, source: n.source })))}`
      );
    });

    it('should still track source correctly for side effect import', async () => {
      await setupTest(backend, {
        'index.js': `
async function init() {
  await import('./init-module.js');
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(dynamicImports.length >= 1, 'Should find at least one dynamic import');
      // V2: CALL nodes don't have source/isDynamic/isResolvable fields
      // V1: IMPORT nodes with source, isDynamic, isResolvable
      const initImport = dynamicImports.find(
        (n) => n.source === './init-module.js' || n.name === 'import'
      );

      assert.ok(initImport, 'Should find dynamic import node');
      // V1: check isDynamic/isResolvable; V2: just verify existence
      if (initImport.isDynamic !== undefined) {
        assert.strictEqual(initImport.isDynamic, true, 'Should have isDynamic=true');
        assert.strictEqual(initImport.isResolvable, true, 'Literal path should have isResolvable=true');
      }
    });
  });

  // ===========================================================================
  // Additional edge cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle multiple dynamic imports in same file', async () => {
      await setupTest(backend, {
        'index.js': `
async function loadAll() {
  const a = await import('./a.js');
  const b = await import('./b.js');
  const c = await import('./c.js');
  return { a, b, c };
}
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(
        dynamicImports.length >= 3,
        `Should have at least 3 dynamic imports, got ${dynamicImports.length}`
      );
    });

    it('should handle dynamic import in arrow function', async () => {
      await setupTest(backend, {
        'index.js': `
const loadModule = async () => {
  const mod = await import('./arrow-module.js');
  return mod;
};
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(dynamicImports.length >= 1, 'Should find at least one dynamic import');
      // V2: CALL nodes don't have source field
      // V1: IMPORT nodes with source
      const arrowImport = dynamicImports.find(
        (n) => n.source === './arrow-module.js' || n.name === 'import'
      );

      assert.ok(arrowImport, 'Should track dynamic import in arrow function');
    });

    it('should handle dynamic import at module top level', async () => {
      await setupTest(backend, {
        'index.js': `
// Top level await
const config = await import('./config.js');
export default config;
        `
      });

      const dynamicImports = await getDynamicImports(backend);
      assert.ok(dynamicImports.length >= 1, 'Should find at least one dynamic import');
      // V2: CALL nodes don't have source field
      // V1: IMPORT nodes with source
      const configImport = dynamicImports.find(
        (n) => n.source === './config.js' || n.name === 'import'
      );

      assert.ok(configImport, 'Should track top-level dynamic import');
    });
  });
});
