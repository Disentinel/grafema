/**
 * Regression test: Ensure no legacy CLASS# IDs in production code
 *
 * This test prevents reintroduction of inline ID string creation
 * that was removed in REG-99.
 *
 * If this test fails, someone added inline CLASS node ID construction
 * instead of using ClassNode.create() or ClassNode.createWithContext()
 *
 * Originally TDD: Tests written first per Kent Beck's methodology.
 * REG-99 migration is complete. Tests updated in REG-154 to match final architecture.
 */

import { describe, it } from 'node:test';
import { execSync } from 'child_process';
import assert from 'assert';

describe('CLASS node ID format validation', () => {
  describe('no legacy CLASS# format in production code', () => {
    it('should have no CLASS# format in production TypeScript/JavaScript', () => {
      // Grep for CLASS# in source files (exclude test files, node_modules, dist)
      const grepCommand = `grep -r "CLASS#" packages/core/src --include="*.ts" --include="*.js" || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() });
      } catch (error) {
        // grep returns exit code 1 when no matches found, which is what we want
        if (error.status === 1) {
          result = '';
        } else {
          throw error;
        }
      }

      // Filter out comments explaining the old format
      const matches = result
        .split('\n')
        .filter(line => line.trim())
        .filter(line => !line.includes('//'))      // Single-line comments
        .filter(line => !line.includes('/*'))      // Multi-line comment start
        .filter(line => !line.includes('*/'))      // Multi-line comment end
        .filter(line => !line.includes('*'))       // JSDoc lines
        .filter(line => !line.includes('CLASS#') || !line.includes('format')); // Documentation

      assert.strictEqual(
        matches.length,
        0,
        `Found CLASS# format in production code (should use ClassNode API):\n${matches.join('\n')}`
      );
    });

    it('should not construct CLASS IDs with template literals containing CLASS#', () => {
      // Look for string templates that create CLASS# IDs
      const patterns = [
        'CLASS#\\${',           // Template literal: `CLASS#${...}`
        '"CLASS#"',             // String concatenation: "CLASS#" + ...
        "'CLASS#'",             // String concatenation: 'CLASS#' + ...
        'CLASS# \\+',           // String concatenation: ... + "CLASS#" + ...
      ];

      for (const pattern of patterns) {
        const grepCommand = `grep -r "${pattern}" packages/core/src --include="*.ts" --include="*.js" || true`;

        let result;
        try {
          result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() });
        } catch (error) {
          if (error.status === 1) {
            result = '';
          } else {
            throw error;
          }
        }

        const matches = result
          .split('\n')
          .filter(line => line.trim())
          .filter(line => !line.includes('//'))
          .filter(line => !line.includes('/*'))
          .filter(line => !line.includes('*'));

        assert.strictEqual(
          matches.length,
          0,
          `Found CLASS# pattern "${pattern}" in production code:\n${matches.join('\n')}`
        );
      }
    });
  });

  describe('ClassNode API usage in key files', () => {
    it('ClassVisitor should use ClassNode.createWithContext()', () => {
      const file = 'packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts';
      const grepCommand = `grep -c "ClassNode.createWithContext" ${file} || echo "0"`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '0';
      }

      const count = parseInt(result, 10);

      assert.ok(
        count > 0,
        `${file} should use ClassNode.createWithContext() at least once`
      );
    });

    it('ASTWorker should use ClassNode.create()', () => {
      const file = 'packages/core/src/core/ASTWorker.ts';
      const grepCommand = `grep -c "ClassNode.create" ${file} || echo "0"`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '0';
      }

      const count = parseInt(result, 10);

      assert.ok(
        count > 0,
        `${file} should use ClassNode.create() at least once`
      );
    });

    it('key files should import ClassNode', () => {
      const files = [
        'packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts',
        'packages/core/src/core/ASTWorker.ts',
      ];

      for (const file of files) {
        const grepCommand = `grep "import.*ClassNode" ${file} || true`;

        let result;
        try {
          result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
        } catch (error) {
          result = '';
        }

        assert.ok(
          result.length > 0,
          `${file} should import ClassNode`
        );
      }
    });
  });

  describe('GraphBuilder should compute IDs not create placeholders', () => {
    it('GraphBuilder should NOT use NodeFactory.createClass for placeholders', () => {
      const file = 'packages/core/src/plugins/analysis/ast/GraphBuilder.ts';

      // Look for NodeFactory.createClass with isInstantiationRef flag
      const grepCommand = `grep "isInstantiationRef" ${file} || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      // Should NOT find isInstantiationRef in GraphBuilder
      assert.strictEqual(
        result,
        '',
        'GraphBuilder should NOT create placeholder nodes with isInstantiationRef flag'
      );
    });

});

  describe('no manual ID construction patterns', () => {
    it('should not have inline CLASS ID construction in visitors', () => {
      const visitorFiles = 'packages/core/src/plugins/analysis/ast/visitors/*.ts';

      // Look for pattern: `CLASS#${name}#${file}#${line}`
      const patterns = [
        'CLASS#.*#.*#',         // CLASS# followed by multiple # separators
        '`CLASS#',              // Template literal starting with CLASS#
      ];

      for (const pattern of patterns) {
        const grepCommand = `grep -r "${pattern}" ${visitorFiles} || true`;

        let result;
        try {
          result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
        } catch (error) {
          result = '';
        }

        const matches = result
          .split('\n')
          .filter(line => line.trim())
          .filter(line => !line.includes('//'))
          .filter(line => !line.includes('/*'));

        assert.strictEqual(
          matches.length,
          0,
          `Found manual CLASS ID construction pattern "${pattern}" in visitors:\n${matches.join('\n')}`
        );
      }
    });

    it('should not have inline CLASS ID construction in workers', () => {
      const workerFiles = 'packages/core/src/core/*Worker.ts';

      // Look for pattern: `CLASS#${name}#${file}#${line}`
      const patterns = [
        'CLASS#.*#.*#',
        '`CLASS#',
      ];

      for (const pattern of patterns) {
        const grepCommand = `grep -r "${pattern}" ${workerFiles} || true`;

        let result;
        try {
          result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
        } catch (error) {
          result = '';
        }

        const matches = result
          .split('\n')
          .filter(line => line.trim())
          .filter(line => !line.includes('//'))
          .filter(line => !line.includes('/*'));

        assert.strictEqual(
          matches.length,
          0,
          `Found manual CLASS ID construction pattern "${pattern}" in workers:\n${matches.join('\n')}`
        );
      }
    });
  });

  describe('ClassNodeRecord type usage', () => {
    it('ClassVisitor should use ClassNodeRecord type', () => {
      const file = 'packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts';
      const grepCommand = `grep "ClassNodeRecord" ${file} || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      assert.ok(
        result.length > 0,
        `${file} should reference ClassNodeRecord type`
      );
    });

    it('ASTWorker should use ClassNodeRecord type', () => {
      const file = 'packages/core/src/core/ASTWorker.ts';
      const grepCommand = `grep "ClassNodeRecord" ${file} || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      assert.ok(
        result.length > 0,
        `${file} should reference ClassNodeRecord type`
      );
    });
  });
});
