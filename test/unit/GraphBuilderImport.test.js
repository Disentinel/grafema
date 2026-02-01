/**
 * GraphBuilder IMPORT node creation via NodeFactory
 *
 * Integration tests to verify that GraphBuilder correctly creates IMPORT nodes
 * using NodeFactory, with semantic IDs and proper graph structure.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

describe('GraphBuilder Import Nodes', () => {
  let backend;
  let testCounter = 0;

  beforeEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
    backend = createTestBackend();
    await backend.connect();
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  /**
   * Create test project and analyze it
   */
  async function setupTest(files, baseDir = null) {
    const testDir = baseDir || join(tmpdir(), `grafema-test-import-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: `test-import-${testCounter}`, type: 'module' })
    );

    for (const [filename, content] of Object.entries(files)) {
      const filePath = join(testDir, filename);
      const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (fileDir !== testDir) {
        mkdirSync(fileDir, { recursive: true });
      }
      writeFileSync(filePath, content);
    }

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(testDir);

    return { testDir };
  }

  describe('IMPORT node creation with semantic IDs', () => {
    it('should create IMPORT nodes with semantic ID format', async () => {
      await setupTest({
        'index.js': `
          import React from 'react';
          import { useState } from 'react';
          import * as fs from 'fs';
        `
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      assert.ok(imports.length >= 3,
        `Should have at least 3 IMPORT nodes, got ${imports.length}`);

      // Check semantic ID format (no line numbers)
      const idPattern = /^.*:IMPORT:.*:.*$/;  // file:IMPORT:source:local
      for (const imp of imports) {
        assert.match(imp.id, idPattern,
          `ID should match semantic pattern: ${imp.id}`);

        // Verify exactly 4 parts: file, IMPORT, source, local
        const parts = imp.id.split(':');
        assert.ok(parts.length >= 4,
          `ID should have at least 4 parts, got ${parts.length}: ${imp.id}`);
        assert.ok(parts.includes('IMPORT'),
          `ID should contain 'IMPORT': ${imp.id}`);
      }
    });

    it('should auto-detect importType for default imports', async () => {
      await setupTest({
        'index.js': `import React from 'react';`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const reactDefault = imports.find(i => i.imported === 'default');

      assert.ok(reactDefault, 'Should have default import');
      assert.strictEqual(reactDefault.importType, 'default');
      assert.strictEqual(reactDefault.importBinding, 'value');
      assert.strictEqual(reactDefault.local, 'React');
      assert.strictEqual(reactDefault.source, 'react');
      assert.ok(reactDefault.line, 'Line should be stored as field');
    });

    it('should auto-detect importType for named imports', async () => {
      await setupTest({
        'index.js': `import { useState } from 'react';`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const useState = imports.find(i => i.imported === 'useState');

      assert.ok(useState, 'Should have named import');
      assert.strictEqual(useState.importType, 'named');
      assert.strictEqual(useState.local, 'useState');
    });

    it('should auto-detect importType for namespace imports', async () => {
      await setupTest({
        'index.js': `import * as fs from 'fs';`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const fsNamespace = imports.find(i => i.imported === '*');

      assert.ok(fsNamespace, 'Should have namespace import');
      assert.strictEqual(fsNamespace.importType, 'namespace');
      assert.strictEqual(fsNamespace.local, 'fs');
    });
  });

  describe('Semantic ID stability across code changes', () => {
    it('should create stable IDs when line numbers change', async () => {
      // Use fixed directory for both analyses
      const fixedDir = join(tmpdir(), `grafema-test-stable-id-${Date.now()}`);

      // First analysis - import on line 1
      await setupTest({
        'index.js': `import React from 'react';`
      }, fixedDir);

      const imports1 = await backend.getAllNodes({ type: 'IMPORT' });
      const reactImport1 = imports1.find(i => i.source === 'react');
      assert.ok(reactImport1, 'Should have React import');
      const id1 = reactImport1.id;
      const line1 = reactImport1.line;

      // Clear backend for second analysis
      await backend.cleanup();
      backend = createTestBackend();
      await backend.connect();

      // Second analysis - empty line added, import on line 2
      await setupTest({
        'index.js': `
import React from 'react';`
      }, fixedDir);

      const imports2 = await backend.getAllNodes({ type: 'IMPORT' });
      const reactImport2 = imports2.find(i => i.source === 'react');
      assert.ok(reactImport2, 'Should have React import in second analysis');
      const id2 = reactImport2.id;
      const line2 = reactImport2.line;

      // IDs should be same despite line number change
      assert.strictEqual(id1, id2,
        'Semantic IDs should not change when line numbers change');

      // But line fields should be different
      assert.notStrictEqual(line1, line2,
        'Line fields should reflect actual position');
    });
  });

  describe('Graph structure with IMPORT nodes', () => {
    it('should create MODULE -> CONTAINS -> IMPORT edges', async () => {
      await setupTest({
        'index.js': `import React from 'react';`
      });

      const modules = await backend.getAllNodes({ type: 'MODULE' });
      assert.ok(modules.length > 0, 'Should have MODULE nodes');

      const indexModule = modules.find(m => m.file?.includes('index.js'));
      assert.ok(indexModule, 'Should have index.js MODULE');

      const edges = await backend.getOutgoingEdges(indexModule.id, ['CONTAINS']);
      const containsImport = edges.find(e => e.dst.includes(':IMPORT:'));

      assert.ok(containsImport,
        'Should have MODULE -> CONTAINS -> IMPORT edge');
    });

    it('should create EXTERNAL_MODULE nodes for external imports', async () => {
      await setupTest({
        'index.js': `import React from 'react';`
      });

      const externalModules = await backend.getAllNodes({ type: 'EXTERNAL_MODULE' });
      const reactModule = externalModules.find(m => m.name === 'react');

      assert.ok(reactModule,
        'Should create EXTERNAL_MODULE node for external package');
    });

    it('should NOT create EXTERNAL_MODULE for relative imports', async () => {
      await setupTest({
        'index.js': `import { utils } from './utils';`,
        'utils.js': `export const utils = {};`
      });

      const externalModules = await backend.getAllNodes({ type: 'EXTERNAL_MODULE' });
      const utilsExternal = externalModules.find(m => m.name === './utils');

      // Relative imports should NOT create EXTERNAL_MODULE
      assert.ok(!utilsExternal,
        'Should not create EXTERNAL_MODULE for relative imports');
    });
  });

  describe('Multiple imports from same source', () => {
    it('should create separate IMPORT nodes for each binding', async () => {
      await setupTest({
        'index.js': `import { useState, useEffect, useCallback } from 'react';`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const reactImports = imports.filter(i => i.source === 'react');

      assert.ok(reactImports.length >= 3,
        `Should have at least 3 React imports, got ${reactImports.length}`);

      // Check each has unique ID
      const ids = new Set(reactImports.map(i => i.id));
      assert.strictEqual(ids.size, reactImports.length,
        'Each import should have unique ID');

      // Verify they are all named imports
      for (const imp of reactImports) {
        assert.strictEqual(imp.importType, 'named');
        assert.strictEqual(imp.source, 'react');
      }
    });

    it('should handle mixed import styles from same source', async () => {
      await setupTest({
        'index.js': `
          import React, { useState } from 'react';
        `
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const reactImports = imports.filter(i => i.source === 'react');

      assert.ok(reactImports.length >= 2,
        `Should have at least 2 React imports, got ${reactImports.length}`);

      const defaultImport = reactImports.find(i => i.importType === 'default');
      const namedImport = reactImports.find(i => i.importType === 'named');

      assert.ok(defaultImport, 'Should have default import');
      assert.ok(namedImport, 'Should have named import');

      assert.strictEqual(defaultImport.local, 'React');
      assert.strictEqual(namedImport.local, 'useState');
    });
  });

  describe('Import variations', () => {
    it('should handle relative path imports', async () => {
      await setupTest({
        'index.js': `import { utils } from './utils';`,
        'utils.js': `export const utils = {};`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const utilsImport = imports.find(i => i.source === './utils');

      assert.ok(utilsImport, 'Should have relative import');
      assert.strictEqual(utilsImport.source, './utils');
    });

    it('should handle parent directory imports', async () => {
      await setupTest({
        'index.js': `import { nested } from './src/nested';`,
        'src/nested.js': `import { config } from '../config';
export const nested = {};`,
        'config.js': `export const config = {};`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const configImport = imports.find(i => i.source === '../config');

      assert.ok(configImport, 'Should have parent directory import');
      assert.strictEqual(configImport.source, '../config');
    });

    it('should handle scoped package imports', async () => {
      await setupTest({
        'index.js': `import { useQuery } from '@tanstack/react-query';`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const scopedImport = imports.find(i => i.source === '@tanstack/react-query');

      assert.ok(scopedImport, 'Should have scoped package import');
      assert.strictEqual(scopedImport.source, '@tanstack/react-query');
    });

    it('should handle aliased imports', async () => {
      await setupTest({
        'index.js': `import { useState as useStateHook } from 'react';`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const aliasedImport = imports.find(i => i.local === 'useStateHook');

      assert.ok(aliasedImport, 'Should have aliased import');
      assert.strictEqual(aliasedImport.imported, 'useState');
      assert.strictEqual(aliasedImport.local, 'useStateHook');
      // ID uses local binding
      assert.ok(aliasedImport.id.includes(':useStateHook'),
        `ID should include local binding: ${aliasedImport.id}`);
    });
  });

  describe('ID format consistency', () => {
    it('should use file:IMPORT:source:local format consistently', async () => {
      await setupTest({
        'index.js': `
          import React from 'react';
          import { useState } from 'react';
          import * as fs from 'fs';
          import { utils } from './utils';
        `,
        'utils.js': `export const utils = {};`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });

      for (const imp of imports) {
        const parts = imp.id.split(':');

        // Should have at least 4 parts
        assert.ok(parts.length >= 4,
          `ID should have at least 4 parts: ${imp.id}`);

        // Second part should always be 'IMPORT'
        assert.ok(parts.includes('IMPORT'),
          `ID should contain 'IMPORT': ${imp.id}`);

        // Should NOT end with a number (no line number)
        const lastPart = parts[parts.length - 1];
        assert.ok(!/^\d+$/.test(lastPart),
          `ID should not end with line number: ${imp.id}`);
      }
    });
  });

  describe('Field completeness', () => {
    it('should populate all required fields', async () => {
      await setupTest({
        'index.js': `import React from 'react';`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const reactImport = imports[0];

      // Required fields
      assert.ok(reactImport.id, 'Should have id');
      assert.strictEqual(reactImport.type, 'IMPORT');
      assert.ok(reactImport.name, 'Should have name');
      assert.ok(reactImport.file, 'Should have file');
      assert.ok(reactImport.line, 'Should have line');
      assert.ok(reactImport.source, 'Should have source');

      // New fields
      assert.ok(reactImport.importType, 'Should have importType');
      assert.ok(reactImport.importBinding, 'Should have importBinding');
      assert.ok(reactImport.imported, 'Should have imported');
      assert.ok(reactImport.local, 'Should have local');
    });

    it('should store line and column as fields', async () => {
      await setupTest({
        'index.js': `import React from 'react';`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const reactImport = imports.find(i => i.source === 'react');

      assert.ok(reactImport.line > 0, 'Line should be positive number');
      assert.ok(typeof reactImport.column === 'number',
        'Column should be a number');
    });
  });

  describe('No field name regressions', () => {
    it('should NOT have old importKind field', async () => {
      await setupTest({
        'index.js': `import React from 'react';`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const reactImport = imports[0];

      // Old field should not exist
      assert.strictEqual(reactImport.importKind, undefined,
        'Old importKind field should not exist');

      // New field should exist
      assert.ok(reactImport.importBinding,
        'New importBinding field should exist');
    });
  });

  describe('Side-effect-only imports (REG-273)', () => {
    it('should create IMPORT node for side-effect imports', async () => {
      await setupTest({
        'index.js': `import './polyfill.js';`,
        'polyfill.js': `// Side effect code\nwindow.polyfilled = true;`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const sideEffectImport = imports.find(i => i.source === './polyfill.js');

      assert.ok(sideEffectImport,
        'Should create IMPORT node for side-effect import');
      assert.strictEqual(sideEffectImport.sideEffect, true,
        'sideEffect field should be true');
      assert.strictEqual(sideEffectImport.imported, '*',
        'imported should be * (no specific export)');
      assert.strictEqual(sideEffectImport.local, './polyfill.js',
        'local should be source (no local binding)');
    });

    it('should mark regular imports with sideEffect: false', async () => {
      await setupTest({
        'index.js': `import { foo } from './lib';`,
        'lib.js': `export const foo = 42;`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const regularImport = imports.find(i => i.source === './lib');

      assert.ok(regularImport, 'Should have regular import');
      assert.strictEqual(regularImport.sideEffect, false,
        'sideEffect field should be false for regular imports');
    });

    it('should create MODULE -> CONTAINS -> IMPORT edge for side-effect imports', async () => {
      await setupTest({
        'index.js': `import './polyfill.js';`,
        'polyfill.js': `window.polyfilled = true;`
      });

      const modules = await backend.getAllNodes({ type: 'MODULE' });
      const indexModule = modules.find(m => m.file?.includes('index.js'));
      assert.ok(indexModule, 'Should have index.js MODULE');

      const edges = await backend.getOutgoingEdges(indexModule.id, ['CONTAINS']);
      const containsSideEffectImport = edges.find(e =>
        e.dst.includes(':IMPORT:') && e.dst.includes('./polyfill.js')
      );

      assert.ok(containsSideEffectImport,
        'Should have MODULE -> CONTAINS -> IMPORT edge for side-effect import');
    });

    it('should create EXTERNAL_MODULE for external side-effect imports', async () => {
      await setupTest({
        'index.js': `import 'core-js/stable';`
      });

      const externalModules = await backend.getAllNodes({ type: 'EXTERNAL_MODULE' });
      const coreJsModule = externalModules.find(m => m.name === 'core-js/stable');

      assert.ok(coreJsModule,
        'Should create EXTERNAL_MODULE for external side-effect import');

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const sideEffectImport = imports.find(i => i.source === 'core-js/stable');

      assert.ok(sideEffectImport,
        'Should create IMPORT node for external side-effect import');
      assert.strictEqual(sideEffectImport.sideEffect, true,
        'External side-effect import should have sideEffect: true');
    });

    it('should create separate IMPORT nodes for multiple side-effect imports', async () => {
      await setupTest({
        'index.js': `
          import './polyfill-1.js';
          import './polyfill-2.js';
          import 'core-js/stable';
        `,
        'polyfill-1.js': `window.polyfill1 = true;`,
        'polyfill-2.js': `window.polyfill2 = true;`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const sideEffectImports = imports.filter(i => i.sideEffect === true);

      assert.ok(sideEffectImports.length >= 3,
        `Should have at least 3 side-effect imports, got ${sideEffectImports.length}`);

      // Verify each has unique ID
      const ids = new Set(sideEffectImports.map(i => i.id));
      assert.strictEqual(ids.size, sideEffectImports.length,
        'Each side-effect import should have unique ID');

      // Verify sources
      const sources = sideEffectImports.map(i => i.source).sort();
      assert.ok(sources.includes('./polyfill-1.js'),
        'Should have ./polyfill-1.js');
      assert.ok(sources.includes('./polyfill-2.js'),
        'Should have ./polyfill-2.js');
      assert.ok(sources.includes('core-js/stable'),
        'Should have core-js/stable');
    });

    it('should use source as name in semantic ID for side-effect imports', async () => {
      await setupTest({
        'index.js': `import './styles.css';`,
        'styles.css': `body { margin: 0; }`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const cssImport = imports.find(i => i.source === './styles.css');

      assert.ok(cssImport, 'Should have CSS side-effect import');

      // Semantic ID should be: file:IMPORT:source:source
      assert.ok(cssImport.id.includes(':IMPORT:'),
        'ID should contain :IMPORT:');
      assert.ok(cssImport.id.includes('./styles.css'),
        'ID should contain source');

      // Name should be source (since no local binding)
      assert.strictEqual(cssImport.name, './styles.css',
        'name should be source for side-effect imports');
    });

    it('should handle scoped package side-effect imports', async () => {
      await setupTest({
        'index.js': `import '@babel/polyfill';`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });
      const polyfillImport = imports.find(i => i.source === '@babel/polyfill');

      assert.ok(polyfillImport,
        'Should create IMPORT for scoped package side-effect import');
      assert.strictEqual(polyfillImport.sideEffect, true,
        'Scoped package side-effect import should have sideEffect: true');
      assert.strictEqual(polyfillImport.source, '@babel/polyfill');
    });

    it('should handle mixed regular and side-effect imports in same file', async () => {
      await setupTest({
        'index.js': `
          import React from 'react';
          import './polyfill.js';
          import { useState } from 'react';
          import './styles.css';
        `,
        'polyfill.js': `window.polyfilled = true;`,
        'styles.css': `body { margin: 0; }`
      });

      const imports = await backend.getAllNodes({ type: 'IMPORT' });

      const sideEffectImports = imports.filter(i => i.sideEffect === true);
      const regularImports = imports.filter(i => i.sideEffect === false);

      assert.ok(sideEffectImports.length >= 2,
        `Should have at least 2 side-effect imports, got ${sideEffectImports.length}`);
      assert.ok(regularImports.length >= 2,
        `Should have at least 2 regular imports, got ${regularImports.length}`);

      // Verify side-effect imports
      const sideEffectSources = sideEffectImports.map(i => i.source);
      assert.ok(sideEffectSources.includes('./polyfill.js'),
        'Should have ./polyfill.js side-effect import');
      assert.ok(sideEffectSources.includes('./styles.css'),
        'Should have ./styles.css side-effect import');

      // Verify regular imports
      const regularSources = regularImports.map(i => i.source);
      assert.ok(regularSources.includes('react'),
        'Should have react regular imports');
    });
  });
});
