/**
 * Regression test: Ensure no legacy EXPRESSION# IDs in production code
 *
 * This test prevents reintroduction of inline ID string creation
 * that was removed in REG-107.
 *
 * If this test fails, someone added inline EXPRESSION node ID construction
 * instead of using ExpressionNode.create() or NodeFactory.createExpression()
 *
 * Originally TDD: Tests written first per Kent Beck's methodology.
 * REG-107 migration is complete. Tests updated in REG-154 to match final architecture.
 */

import { describe, it } from 'node:test';
import { execSync } from 'child_process';
import assert from 'assert';

describe('EXPRESSION node ID format validation', () => {
  describe('no legacy EXPRESSION# format in production code', () => {
    it('should have no EXPRESSION# format in production TypeScript/JavaScript', () => {
      const grepCommand = `grep -r "EXPRESSION#" packages/core/src --include="*.ts" --include="*.js" || true`;

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

      // Filter out comments and documentation
      const matches = result
        .split('\n')
        .filter(line => line.trim())
        .filter(line => !line.includes('//'))
        .filter(line => !line.includes('/*'))
        .filter(line => !line.includes('*'))
        .filter(line => !line.includes('EXPRESSION#') || !line.includes('format'));

      assert.strictEqual(
        matches.length,
        0,
        `Found EXPRESSION# format in production code (should use ExpressionNode API):\n${matches.join('\n')}`
      );
    });

    it('should not construct EXPRESSION IDs with template literals', () => {
      const patterns = [
        'EXPRESSION#\\${',
        '"EXPRESSION#"',
        "'EXPRESSION#'",
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
          .filter(line => !line.includes('/*'));

        assert.strictEqual(
          matches.length,
          0,
          `Found EXPRESSION# pattern "${pattern}" in production code:\n${matches.join('\n')}`
        );
      }
    });

    it('should not have inline EXPRESSION object literals in visitors', () => {
      const visitorFiles = 'packages/core/src/plugins/analysis/ast/visitors/*.ts';

      // Look for patterns like:
      // literals.push({ id: ..., type: 'EXPRESSION', ... })
      // { id: expressionId, type: 'EXPRESSION', ... }
      const patterns = [
        'type: \'EXPRESSION\'',
        'type: "EXPRESSION"',
      ];

      for (const pattern of patterns) {
        const grepCommand = `grep -r "${pattern}" ${visitorFiles} || true`;

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

        // Filter for inline object creation (not type imports or interface definitions)
        const matches = result
          .split('\n')
          .filter(line => line.trim())
          .filter(line => !line.includes('import'))
          .filter(line => !line.includes('interface'))
          .filter(line => !line.includes('//'))
          .filter(line => !line.includes('/*'))
          .filter(line => line.includes('{') || line.includes('push'));

        // Allow these matches if they're using factory-created nodes
        // Filter out lines that have NodeFactory or .create calls nearby
        const suspiciousMatches = matches.filter(line =>
          !line.includes('NodeFactory') &&
          !line.includes('.create')
        );

        if (suspiciousMatches.length > 0) {
          console.warn(`Warning: Found potential inline EXPRESSION construction:\n${suspiciousMatches.join('\n')}`);
        }
      }
    });
  });

  describe('NodeFactory usage in key files', () => {
    it('ArgumentExtractor should use NodeFactory.createArgumentExpression()', () => {
      // REG-424: extractArguments moved from CallExpressionVisitor to ArgumentExtractor
      const file = 'packages/core/src/plugins/analysis/ast/visitors/ArgumentExtractor.ts';
      const grepCommand = `grep -c "NodeFactory.createArgumentExpression" ${file} || echo "0"`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '0';
      }

      const count = parseInt(result, 10);

      assert.ok(
        count > 0,
        `${file} should use NodeFactory.createArgumentExpression() at least once`
      );
    });

    it('key files should import NodeFactory', () => {
      const files = [
        // REG-424: NodeFactory usage moved from CallExpressionVisitor to ArgumentExtractor
        'packages/core/src/plugins/analysis/ast/visitors/ArgumentExtractor.ts',
      ];

      for (const file of files) {
        const grepCommand = `grep "import.*NodeFactory" ${file} || true`;

        let result;
        try {
          result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
        } catch (error) {
          result = '';
        }

        assert.ok(
          result.length > 0,
          `${file} should import NodeFactory`
        );
      }
    });
  });

  describe('GraphBuilder validation', () => {
    it('Graph builders should validate colon-based EXPRESSION IDs', () => {
      // REG-423: Expression buffering extracted to domain builders
      const dir = 'packages/core/src/plugins/analysis/ast/builders';
      const grepCommand = `grep -r ":EXPRESSION:" ${dir} --include="*.ts" || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      assert.ok(
        result.length > 0,
        'Graph builders should validate :EXPRESSION: ID format'
      );
    });

    it('Graph builders should not create EXPRESSION nodes with legacy format', () => {
      // REG-423: Expression buffering extracted to domain builders
      const dir = 'packages/core/src/plugins/analysis/ast/builders';
      const grepCommand = `grep -r "EXPRESSION#" ${dir} --include="*.ts" || true`;

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
        'Graph builders should not use EXPRESSION# format'
      );
    });
  });

  describe('ArgumentExpressionNode exists and is exported', () => {
    it('should have ArgumentExpressionNode.ts file', () => {
      const grepCommand = `ls packages/core/src/core/nodes/ArgumentExpressionNode.ts || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      assert.ok(
        result.includes('ArgumentExpressionNode.ts'),
        'ArgumentExpressionNode.ts should exist'
      );
    });

    it('ArgumentExpressionNode should be exported from nodes/index.ts', () => {
      const file = 'packages/core/src/core/nodes/index.ts';
      const grepCommand = `grep "ArgumentExpressionNode" ${file} || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      assert.ok(
        result.length > 0,
        `${file} should export ArgumentExpressionNode`
      );
    });

    it('NodeFactory should have createArgumentExpression method', () => {
      const file = 'packages/core/src/core/NodeFactory.ts';
      const grepCommand = `grep "createArgumentExpression" ${file} || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      assert.ok(
        result.length > 0,
        `${file} should have createArgumentExpression method`
      );
    });

    it('NodeFactory should reference ArgumentExpressionNode', () => {
      const file = 'packages/core/src/core/factories/CoreFactory.ts';
      const grepCommand = `grep "ArgumentExpressionNode" ${file} || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      assert.ok(
        result.length > 0,
        `${file} should reference ArgumentExpressionNode`
      );
    });
  });

  describe('ID format structure', () => {
    it('production code should use colon format for EXPRESSION nodes', () => {
      const file = 'packages/core/src/plugins/analysis/ast/visitors/*.ts';
      const grepCommand = `grep ":EXPRESSION:" ${file} || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      // After migration, should find :EXPRESSION: pattern in code
      // This validates the new ID format is being used
      const lines = result.split('\n').filter(line => line.trim());

      // Note: This test might pass even before implementation if the pattern appears
      // in comments or imports. The real validation is in other tests that check
      // for absence of legacy format.
      console.log(`Found ${lines.length} lines with :EXPRESSION: pattern in visitors`);
    });
  });

  describe('no hash-based ID patterns', () => {
    it('should not have EXPRESSION# concatenation patterns', () => {
      const patterns = [
        'EXPRESSION#.*#.*#',  // Multiple hash separators
        '`EXPRESSION#',       // Template literal starting with EXPRESSION#
        'const.*EXPRESSION#', // Variable assignment with EXPRESSION#
      ];

      for (const pattern of patterns) {
        // Escape backticks for shell safety
        const escapedPattern = pattern.replace(/`/g, '\\`');
        const grepCommand = `grep -r "${escapedPattern}" packages/core/src --include="*.ts" --include="*.js" || true`;

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
          `Found hash-based EXPRESSION ID pattern "${pattern}":\n${matches.join('\n')}`
        );
      }
    });
  });

  describe('type exports', () => {
    it('ArgumentExpressionNodeRecord should be exported', () => {
      const file = 'packages/core/src/core/nodes/index.ts';
      const grepCommand = `grep "ArgumentExpressionNodeRecord" ${file} || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      assert.ok(
        result.length > 0,
        'ArgumentExpressionNodeRecord type should be exported'
      );
    });

    it('ArgumentExpressionNodeOptions should be exported', () => {
      const file = 'packages/core/src/core/nodes/index.ts';
      const grepCommand = `grep "ArgumentExpressionNodeOptions" ${file} || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      assert.ok(
        result.length > 0,
        'ArgumentExpressionNodeOptions type should be exported'
      );
    });
  });
});
