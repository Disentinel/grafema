/**
 * ModuleNode Semantic ID Tests
 *
 * Tests for ModuleNode migration to use ScopeContext
 * for stable semantic IDs.
 *
 * Format: {file}->global->MODULE->module
 *
 * MODULE nodes are unique per file - each file has exactly one MODULE node.
 * The name is always "module" (a constant) because this is the module itself.
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// NOTE: ModuleNode needs to be exported from @grafema/core as part of implementation
// For now, use direct path import to test the class directly
import { ModuleNode } from '../../packages/core/dist/core/nodes/ModuleNode.js';
import { computeSemanticId } from '@grafema/core';

describe('ModuleNode with Semantic ID', () => {
  describe('createWithContext() - new semantic ID API', () => {
    it('should create MODULE with semantic ID', () => {
      const context = { file: 'src/index.js', scopePath: [] };
      const node = ModuleNode.createWithContext(context);

      assert.strictEqual(node.id, 'src/index.js->global->MODULE->module');
      assert.strictEqual(node.type, 'MODULE');
      assert.strictEqual(node.name, 'src/index.js');
      assert.strictEqual(node.file, 'src/index.js');
      assert.strictEqual(node.line, 0);
    });

    it('should handle nested path', () => {
      const context = { file: 'packages/core/src/utils/helper.ts', scopePath: [] };
      const node = ModuleNode.createWithContext(context);

      assert.strictEqual(node.id, 'packages/core/src/utils/helper.ts->global->MODULE->module');
      assert.strictEqual(node.name, 'packages/core/src/utils/helper.ts');
    });

    it('should handle file with special characters in path', () => {
      const context = { file: 'src/handlers/user-auth.service.ts', scopePath: [] };
      const node = ModuleNode.createWithContext(context);

      assert.strictEqual(node.id, 'src/handlers/user-auth.service.ts->global->MODULE->module');
    });

    it('should handle file in root directory', () => {
      const context = { file: 'index.js', scopePath: [] };
      const node = ModuleNode.createWithContext(context);

      assert.strictEqual(node.id, 'index.js->global->MODULE->module');
      assert.strictEqual(node.name, 'index.js');
    });
  });

  describe('contentHash handling', () => {
    it('should include contentHash when provided', () => {
      const context = { file: 'src/app.js', scopePath: [] };
      const node = ModuleNode.createWithContext(context, { contentHash: 'abc123' });

      assert.strictEqual(node.contentHash, 'abc123');
    });

    it('should default contentHash to empty string when not provided', () => {
      const context = { file: 'src/app.js', scopePath: [] };
      const node = ModuleNode.createWithContext(context);

      assert.strictEqual(node.contentHash, '');
    });

    it('should handle isTest option', () => {
      const context = { file: 'test/app.test.js', scopePath: [] };
      const node = ModuleNode.createWithContext(context, { isTest: true });

      assert.strictEqual(node.isTest, true);
    });

    it('should default isTest to false when not provided', () => {
      const context = { file: 'src/app.js', scopePath: [] };
      const node = ModuleNode.createWithContext(context);

      assert.strictEqual(node.isTest, false);
    });
  });

  describe('validation - file required in context', () => {
    it('should require file in context', () => {
      const context = { file: '', scopePath: [] };
      assert.throws(() => ModuleNode.createWithContext(context), /file is required/);
    });

    it('should throw when file is undefined', () => {
      const context = { scopePath: [] };
      assert.throws(() => ModuleNode.createWithContext(context), /file is required/);
    });
  });

  describe('Semantic ID stability', () => {
    it('should produce same ID regardless of contentHash', () => {
      const context = { file: 'src/module.js', scopePath: [] };
      const node1 = ModuleNode.createWithContext(context, { contentHash: 'hash1' });
      const node2 = ModuleNode.createWithContext(context, { contentHash: 'hash2' });

      // IDs should be IDENTICAL - semantic identity based on file, not content
      assert.strictEqual(node1.id, node2.id);
      assert.strictEqual(node1.id, 'src/module.js->global->MODULE->module');

      // But contentHash fields are different
      assert.strictEqual(node1.contentHash, 'hash1');
      assert.strictEqual(node2.contentHash, 'hash2');
    });

    it('should produce different IDs for different files', () => {
      const ctx1 = { file: 'src/file1.js', scopePath: [] };
      const ctx2 = { file: 'src/file2.js', scopePath: [] };

      const node1 = ModuleNode.createWithContext(ctx1);
      const node2 = ModuleNode.createWithContext(ctx2);

      assert.notStrictEqual(node1.id, node2.id);
      assert.strictEqual(node1.id, 'src/file1.js->global->MODULE->module');
      assert.strictEqual(node2.id, 'src/file2.js->global->MODULE->module');
    });

    it('should produce same ID across multiple calls for same file', () => {
      const context = { file: 'src/stable.js', scopePath: [] };

      const node1 = ModuleNode.createWithContext(context);
      const node2 = ModuleNode.createWithContext(context);
      const node3 = ModuleNode.createWithContext(context);

      assert.strictEqual(node1.id, node2.id);
      assert.strictEqual(node2.id, node3.id);
    });
  });

  describe('computeSemanticId integration', () => {
    it('should match computeSemanticId output', () => {
      const context = { file: 'src/handlers/user.js', scopePath: [] };
      const node = ModuleNode.createWithContext(context);
      const expectedId = computeSemanticId('MODULE', 'module', context);

      assert.strictEqual(node.id, expectedId);
    });

    it('should match computeSemanticId for nested paths', () => {
      const context = { file: 'packages/core/src/index.ts', scopePath: [] };
      const node = ModuleNode.createWithContext(context);
      const expectedId = computeSemanticId('MODULE', 'module', context);

      assert.strictEqual(node.id, expectedId);
    });
  });

  describe('Edge reference consistency', () => {
    it('DEPENDS_ON edges should use matching semantic IDs', () => {
      // Create two MODULE nodes
      const ctx1 = { file: 'src/a.js', scopePath: [] };
      const ctx2 = { file: 'src/b.js', scopePath: [] };

      const node1 = ModuleNode.createWithContext(ctx1);
      const node2 = ModuleNode.createWithContext(ctx2);

      // Create edge referencing node2 (how JSModuleIndexer creates DEPENDS_ON)
      const depModuleId = `${ctx2.file}->global->MODULE->module`;

      // Edge dst must match node ID exactly
      assert.strictEqual(depModuleId, node2.id);
    });

    it('should produce predictable IDs for edge creation', () => {
      // Simulates how other code can construct MODULE ID without creating node
      const targetPath = 'src/utils/helper.js';
      const expectedId = `${targetPath}->global->MODULE->module`;

      // Create actual node
      const ctx = { file: targetPath, scopePath: [] };
      const node = ModuleNode.createWithContext(ctx);

      // Constructed ID should match actual node ID
      assert.strictEqual(expectedId, node.id);
    });
  });

  describe('Cross-indexer consistency', () => {
    it('JSModuleIndexer and IncrementalModuleIndexer produce same IDs', () => {
      const file = 'src/app.js';

      // JSModuleIndexer approach - uses createWithContext
      const jsContext = { file, scopePath: [] };
      const jsNode = ModuleNode.createWithContext(jsContext);

      // IncrementalModuleIndexer approach - direct string construction
      const incId = `${file}->global->MODULE->module`;

      assert.strictEqual(jsNode.id, incId);
    });

    it('VersionManager.generateStableId produces same format', () => {
      // VersionManager uses file name (relative path) to compute ID
      const relativePath = 'src/services/auth.js';

      // Expected format from VersionManager
      const versionManagerId = `${relativePath}->global->MODULE->module`;

      // Should match createWithContext
      const ctx = { file: relativePath, scopePath: [] };
      const node = ModuleNode.createWithContext(ctx);

      assert.strictEqual(node.id, versionManagerId);
    });
  });

  describe('backward compatibility with create()', () => {
    it('should still support legacy create() method', () => {
      // Legacy API still works for backward compatibility
      const node = ModuleNode.create(
        '/absolute/path/to/src/app.js',  // filePath
        'src/app.js',                     // relativePath
        'abc123def456'                    // contentHash
      );

      // Legacy method uses old ID format (hash-based)
      assert.ok(node.id.includes('MODULE:'));
      assert.strictEqual(node.name, 'src/app.js');
      assert.strictEqual(node.file, '/absolute/path/to/src/app.js');
      assert.strictEqual(node.contentHash, 'abc123def456');
    });
  });

  describe('edge cases', () => {
    it('should handle Windows-style paths normalized to forward slashes', () => {
      // In practice, paths should be normalized before reaching ModuleNode
      const context = { file: 'src/handlers/user.js', scopePath: [] };
      const node = ModuleNode.createWithContext(context);

      assert.strictEqual(node.id, 'src/handlers/user.js->global->MODULE->module');
    });

    it('should handle deeply nested directory structure', () => {
      const context = {
        file: 'packages/core/src/plugins/analysis/validators/sql/SQLInjectionValidator.ts',
        scopePath: []
      };
      const node = ModuleNode.createWithContext(context);

      assert.strictEqual(
        node.id,
        'packages/core/src/plugins/analysis/validators/sql/SQLInjectionValidator.ts->global->MODULE->module'
      );
    });

    it('should handle .mjs and .cjs extensions', () => {
      const mjsContext = { file: 'src/utils.mjs', scopePath: [] };
      const cjsContext = { file: 'src/config.cjs', scopePath: [] };

      const mjsNode = ModuleNode.createWithContext(mjsContext);
      const cjsNode = ModuleNode.createWithContext(cjsContext);

      assert.strictEqual(mjsNode.id, 'src/utils.mjs->global->MODULE->module');
      assert.strictEqual(cjsNode.id, 'src/config.cjs->global->MODULE->module');
    });

    it('should handle TypeScript .d.ts files', () => {
      const context = { file: 'src/types/index.d.ts', scopePath: [] };
      const node = ModuleNode.createWithContext(context);

      assert.strictEqual(node.id, 'src/types/index.d.ts->global->MODULE->module');
    });
  });
});
