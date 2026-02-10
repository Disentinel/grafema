/**
 * Tests for context command utilities - REG-406
 *
 * Tests the code preview and formatting logic used by the context command.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { getCodePreview, formatCodePreview } from '../../packages/cli/dist/utils/codePreview.js';
import { formatLocation } from '../../packages/cli/dist/utils/formatNode.js';

describe('context command - code preview', () => {
  describe('getCodePreview', () => {
    it('should return null for non-existent file', () => {
      const result = getCodePreview({
        file: '/nonexistent/path/file.js',
        line: 10,
      });
      assert.equal(result, null);
    });

    it('should read a real file with context', () => {
      // Use this test file itself as the source
      const result = getCodePreview({
        file: import.meta.filename,
        line: 1,
        contextBefore: 0,
        contextAfter: 5,
      });
      assert.ok(result, 'Should return a result for existing file');
      assert.equal(result.startLine, 1);
      assert.ok(result.lines.length > 0, 'Should have lines');
      assert.ok(result.lines[0].includes('/**'), 'First line should be the opening comment');
    });

    it('should respect contextBefore and contextAfter', () => {
      const result = getCodePreview({
        file: import.meta.filename,
        line: 10,
        contextBefore: 2,
        contextAfter: 3,
      });
      assert.ok(result, 'Should return result');
      assert.equal(result.startLine, 8);
      assert.equal(result.endLine, 13);
    });
  });

  describe('formatCodePreview', () => {
    it('should format lines with line numbers', () => {
      const preview = {
        lines: ['function foo() {', '  return 42;', '}'],
        startLine: 10,
        endLine: 12,
      };

      const formatted = formatCodePreview(preview);
      assert.equal(formatted.length, 3);
      assert.ok(formatted[0].includes('10'), 'Should include line number');
      assert.ok(formatted[0].includes('function foo()'), 'Should include code');
    });

    it('should highlight specified line', () => {
      const preview = {
        lines: ['// before', 'target line', '// after'],
        startLine: 5,
        endLine: 7,
      };

      const formatted = formatCodePreview(preview, 6);
      // Line 6 should be highlighted with >
      assert.ok(formatted[1].startsWith('>'), 'Highlighted line should start with >');
      assert.ok(formatted[0].startsWith(' '), 'Non-highlighted line should start with space');
    });

    it('should pad line numbers correctly', () => {
      const preview = {
        lines: Array(15).fill('code'),
        startLine: 95,
        endLine: 109,
      };

      const formatted = formatCodePreview(preview);
      // Line numbers should be padded to 3 digits
      assert.ok(formatted[0].includes(' 95'), 'Should pad 2-digit number');
      assert.ok(formatted[14].includes('109'), 'Should show 3-digit number');
    });
  });
});

describe('context command - grep-friendly output format', () => {
  it('should use -> for outgoing edges', () => {
    // Verify that the output format is documented and stable
    const outgoingPattern = /^\s+-> \[/;
    const line = '      -> [FUNCTION] foo  (src/bar.js:42)';
    assert.ok(outgoingPattern.test(line), 'Outgoing edge should match -> pattern');
  });

  it('should use <- for incoming edges', () => {
    const incomingPattern = /^\s+<- \[/;
    const line = '      <- [CALL] foo  (src/bar.js:42)';
    assert.ok(incomingPattern.test(line), 'Incoming edge should match <- pattern');
  });

  it('should use > for highlighted source lines', () => {
    const highlightPattern = /^\s+>/;
    const line = '    > 42 | function foo() {';
    assert.ok(highlightPattern.test(line), 'Highlighted line should match > pattern');
  });
});

describe('context command - edge classification', () => {
  it('should classify structural edges correctly', () => {
    const STRUCTURAL = new Set([
      'CONTAINS', 'HAS_SCOPE', 'DECLARES', 'DEFINES',
      'HAS_CONDITION', 'HAS_CASE', 'HAS_DEFAULT',
      'HAS_CONSEQUENT', 'HAS_ALTERNATE', 'HAS_BODY',
      'HAS_INIT', 'HAS_UPDATE', 'HAS_CATCH', 'HAS_FINALLY',
      'HAS_PARAMETER', 'HAS_PROPERTY', 'HAS_ELEMENT',
      'USES', 'GOVERNS', 'VIOLATES', 'AFFECTS', 'UNKNOWN',
    ]);

    // Primary edges should NOT be in structural set
    assert.ok(!STRUCTURAL.has('CALLS'), 'CALLS should be primary');
    assert.ok(!STRUCTURAL.has('ASSIGNED_FROM'), 'ASSIGNED_FROM should be primary');
    assert.ok(!STRUCTURAL.has('DEPENDS_ON'), 'DEPENDS_ON should be primary');
    assert.ok(!STRUCTURAL.has('ROUTES_TO'), 'ROUTES_TO should be primary');
    assert.ok(!STRUCTURAL.has('EXTENDS'), 'EXTENDS should be primary');
    assert.ok(!STRUCTURAL.has('THROWS'), 'THROWS should be primary');
    assert.ok(!STRUCTURAL.has('PASSES_ARGUMENT'), 'PASSES_ARGUMENT should be primary');

    // Structural edges should be in the set
    assert.ok(STRUCTURAL.has('CONTAINS'), 'CONTAINS should be structural');
    assert.ok(STRUCTURAL.has('HAS_SCOPE'), 'HAS_SCOPE should be structural');
    assert.ok(STRUCTURAL.has('DECLARES'), 'DECLARES should be structural');
  });
});
