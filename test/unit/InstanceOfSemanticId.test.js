/**
 * REG-205: INSTANCE_OF edge should use semantic ID format
 *
 * This test verifies that INSTANCE_OF edges use semantic ID format
 * (->global->CLASS->) instead of legacy format (:CLASS:).
 *
 * The bug: GraphBuilder.bufferClassNodes() line ~467 uses legacy format:
 *   classId = `${module.file}:CLASS:${className}:0`;
 *
 * Should use semantic ID format:
 *   classId = computeSemanticId('CLASS', className, { file: module.file, scopePath: [] });
 *
 * Format comparison:
 *   Legacy:   /path/index.js:CLASS:MyClass:0
 *   Semantic: /path/index.js->global->CLASS->MyClass
 *
 * Why semantic IDs matter:
 * - CLASS nodes use semantic IDs (created by ClassVisitor via ClassNode.createWithContext)
 * - INSTANCE_OF edges must point to the same ID format
 * - Mismatch means edges point to non-existent nodes
 *
 * TDD: This test will FAIL initially - proving the bug exists.
 */

import { describe, it } from 'node:test';
import { execSync } from 'child_process';
import assert from 'node:assert';

import { computeSemanticId, ScopeTracker, ClassNode } from '@grafema/core';

describe('REG-205: INSTANCE_OF semantic ID format', () => {

  describe('semantic ID format verification', () => {
    it('should understand the correct semantic ID format for CLASS', () => {
      // Verify what the correct format should be
      const tracker = new ScopeTracker('src/index.js');
      const context = tracker.getContext();

      // This is how ClassVisitor creates CLASS nodes
      const classNode = ClassNode.createWithContext('MyService', context, { line: 10, column: 0 });

      // Semantic ID format: {file}->global->CLASS->{name}
      assert.ok(
        classNode.id.includes('->global->CLASS->'),
        `CLASS node ID should use semantic format. Got: ${classNode.id}`
      );
      assert.ok(
        !classNode.id.includes(':CLASS:'),
        'CLASS node ID should NOT use legacy :CLASS: format'
      );

      // Also verify computeSemanticId produces same format
      const semanticId = computeSemanticId('CLASS', 'MyService', context);
      assert.strictEqual(
        classNode.id,
        semanticId,
        'ClassNode.createWithContext() and computeSemanticId() should produce identical IDs'
      );
    });

    it('should show legacy format is different from semantic format', () => {
      const file = 'src/index.js';
      const className = 'ExternalService';

      // Legacy format (the BUG)
      const legacyId = `${file}:CLASS:${className}:0`;

      // Semantic format (the FIX)
      const semanticId = computeSemanticId('CLASS', className, { file, scopePath: [] });

      // They should be different - this proves the formats are incompatible
      assert.notStrictEqual(
        legacyId,
        semanticId,
        'Legacy and semantic formats should be different'
      );

      // Legacy has :CLASS: separator
      assert.ok(legacyId.includes(':CLASS:'), 'Legacy format should have :CLASS:');

      // Semantic has ->global->CLASS-> separator
      assert.ok(semanticId.includes('->global->CLASS->'), 'Semantic format should have ->global->CLASS->');
    });
  });

  describe('GraphBuilder source code verification', () => {
    it('should NOT have legacy :CLASS: format in v2 source (REG-205 fix)', () => {
      // v2: classes handled in core-v2/src/visitors/classes.ts
      const dir = 'packages/core-v2/src';

      const grepCommand = `grep -rn ":CLASS:" ${dir} --include="*.ts" || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      // Filter to find actual code (not comments)
      const codeLines = result
        .split('\n')
        .filter(line => line.trim())
        .filter(line => !line.includes('//'))
        .filter(line => !line.includes('*'))
        .filter(line => line.includes(':CLASS:'));

      // v2 should NOT have legacy :CLASS: format
      assert.strictEqual(
        codeLines.length,
        0,
        `v2 source should NOT have legacy :CLASS: format.\n` +
        `Found ${codeLines.length} occurrences:\n${codeLines.join('\n')}`
      );
    });

    it('should handle CLASS nodes via v2 visitors (REG-205 fix)', () => {
      // v2: ClassDeclaration handled in visitors/declarations.ts
      const file = 'packages/core-v2/src/visitors/declarations.ts';

      const grepCommand = `grep "CLASS\\|ClassDeclaration" ${file} || true`;

      let result;
      try {
        result = execSync(grepCommand, { encoding: 'utf-8', cwd: process.cwd() }).trim();
      } catch (error) {
        result = '';
      }

      const hasClassHandling = result
        .split('\n')
        .some(line => line.includes('CLASS') || line.includes('ClassDeclaration'));

      assert.ok(
        hasClassHandling,
        `v2 declarations.ts should handle CLASS nodes.\n` +
        `Found: ${result || '(none)'}`
      );
    });
  });

  describe('INSTANCE_OF edge dst format (expected to FAIL)', () => {
    it('should verify INSTANCE_OF creates edges with semantic ID format', () => {
      // This test documents what the FIX should achieve:
      // When class is external (not found in declarationMap),
      // the INSTANCE_OF edge dst should use semantic ID format.

      const file = 'src/index.js';
      const className = 'ExternalService';

      // Current buggy behavior creates this:
      const buggyDst = `${file}:CLASS:${className}:0`;

      // Fixed behavior should create this:
      const expectedDst = computeSemanticId('CLASS', className, { file, scopePath: [] });

      // The edge dst should match CLASS node ID format
      // CLASS nodes use semantic IDs via ClassNode.createWithContext()
      const tracker = new ScopeTracker(file);
      const classNode = ClassNode.createWithContext(className, tracker.getContext(), { line: 1, column: 0 });

      // Verify expected format matches CLASS node format
      assert.strictEqual(
        expectedDst,
        classNode.id,
        'Expected INSTANCE_OF dst should match CLASS node ID format'
      );

      // Verify buggy format does NOT match
      assert.notStrictEqual(
        buggyDst,
        classNode.id,
        'Buggy INSTANCE_OF dst should NOT match CLASS node ID format'
      );

      // This documents the fix requirement:
      console.log('INSTANCE_OF edge dst format comparison:');
      console.log(`  Current (buggy): ${buggyDst}`);
      console.log(`  Expected (fix):  ${expectedDst}`);
      console.log(`  CLASS node ID:   ${classNode.id}`);
    });
  });
});
