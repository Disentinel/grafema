/**
 * Tests for grafema-ignore comment parsing (REG-332)
 *
 * Tests the getGrafemaIgnore helper function that parses comments like:
 *   // grafema-ignore STRICT_UNRESOLVED_METHOD
 *   // grafema-ignore STRICT_UNRESOLVED_METHOD - reason here
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Comment } from '@babel/types';

// Replicate the pattern and function from CallExpressionVisitor
const GRAFEMA_IGNORE_PATTERN = /grafema-ignore(?:-next-line)?\s+([\w_]+)(?:\s+-\s+(.+))?/;

interface GrafemaIgnoreAnnotation {
  code: string;
  reason?: string;
}

function getGrafemaIgnore(leadingComments: Comment[] | null | undefined): GrafemaIgnoreAnnotation | null {
  if (!leadingComments || leadingComments.length === 0) return null;

  // Check comments from last to first (closest to node wins)
  for (let i = leadingComments.length - 1; i >= 0; i--) {
    const comment = leadingComments[i];
    const text = comment.value.trim();
    const match = text.match(GRAFEMA_IGNORE_PATTERN);
    if (match) {
      return {
        code: match[1],
        reason: match[2]?.trim(),
      };
    }
  }

  return null;
}

// Helper to create comment objects
function createLineComment(value: string): Comment {
  return {
    type: 'CommentLine',
    value,
    start: 0,
    end: value.length,
    loc: { start: { line: 1, column: 0 }, end: { line: 1, column: value.length } }
  } as Comment;
}

function createBlockComment(value: string): Comment {
  return {
    type: 'CommentBlock',
    value,
    start: 0,
    end: value.length + 4,
    loc: { start: { line: 1, column: 0 }, end: { line: 1, column: value.length + 4 } }
  } as Comment;
}

describe('grafema-ignore comment parsing', () => {
  describe('line comments', () => {
    it('should parse basic grafema-ignore comment', () => {
      const comments = [createLineComment(' grafema-ignore STRICT_UNRESOLVED_METHOD')];
      const result = getGrafemaIgnore(comments);

      assert.ok(result, 'Should parse grafema-ignore');
      assert.strictEqual(result.code, 'STRICT_UNRESOLVED_METHOD');
      assert.strictEqual(result.reason, undefined);
    });

    it('should parse grafema-ignore-next-line variant', () => {
      const comments = [createLineComment(' grafema-ignore-next-line STRICT_UNRESOLVED_METHOD')];
      const result = getGrafemaIgnore(comments);

      assert.ok(result, 'Should parse grafema-ignore-next-line');
      assert.strictEqual(result.code, 'STRICT_UNRESOLVED_METHOD');
    });

    it('should parse grafema-ignore with reason', () => {
      const comments = [createLineComment(' grafema-ignore STRICT_UNRESOLVED_METHOD - known external API')];
      const result = getGrafemaIgnore(comments);

      assert.ok(result, 'Should parse grafema-ignore with reason');
      assert.strictEqual(result.code, 'STRICT_UNRESOLVED_METHOD');
      assert.strictEqual(result.reason, 'known external API');
    });

    it('should handle reason with special characters', () => {
      const comments = [createLineComment(' grafema-ignore STRICT_UNRESOLVED_METHOD - API v2.0 (legacy)')];
      const result = getGrafemaIgnore(comments);

      assert.ok(result, 'Should parse');
      assert.strictEqual(result.reason, 'API v2.0 (legacy)');
    });
  });

  describe('invalid formats', () => {
    it('should not match grafema-skip', () => {
      const comments = [createLineComment(' grafema-skip STRICT_UNRESOLVED_METHOD')];
      const result = getGrafemaIgnore(comments);

      assert.strictEqual(result, null, 'Should NOT match grafema-skip');
    });

    it('should require error code (no blanket suppression)', () => {
      const comments = [createLineComment(' grafema-ignore-next-line')];
      const result = getGrafemaIgnore(comments);

      assert.strictEqual(result, null, 'Should require error code');
    });

    it('should require error code even with trailing space', () => {
      const comments = [createLineComment(' grafema-ignore ')];
      const result = getGrafemaIgnore(comments);

      assert.strictEqual(result, null, 'Should require error code');
    });
  });

  describe('block comments', () => {
    it('should parse block comment format', () => {
      const comments = [createBlockComment(' grafema-ignore STRICT_UNRESOLVED_METHOD ')];
      const result = getGrafemaIgnore(comments);

      assert.ok(result, 'Should parse block comment');
      assert.strictEqual(result.code, 'STRICT_UNRESOLVED_METHOD');
    });

    it('should parse block comment with reason', () => {
      const comments = [createBlockComment(' grafema-ignore STRICT_UNRESOLVED_METHOD - external lib ')];
      const result = getGrafemaIgnore(comments);

      assert.ok(result, 'Should parse');
      assert.strictEqual(result.code, 'STRICT_UNRESOLVED_METHOD');
      assert.strictEqual(result.reason, 'external lib');
    });
  });

  describe('multiple comments', () => {
    it('should use last matching comment (closest to node)', () => {
      const comments = [
        createLineComment(' grafema-ignore WRONG_CODE'),
        createLineComment(' grafema-ignore STRICT_UNRESOLVED_METHOD - the correct one')
      ];
      const result = getGrafemaIgnore(comments);

      assert.ok(result, 'Should find match');
      assert.strictEqual(result.code, 'STRICT_UNRESOLVED_METHOD');
      assert.strictEqual(result.reason, 'the correct one');
    });

    it('should skip non-matching comments and find match', () => {
      const comments = [
        createLineComment(' some regular comment'),
        createLineComment(' grafema-ignore STRICT_UNRESOLVED_METHOD'),
        createLineComment(' another comment')
      ];
      const result = getGrafemaIgnore(comments);

      // Last comment doesn't match, so should find the middle one
      assert.ok(result, 'Should find grafema-ignore in middle');
      assert.strictEqual(result.code, 'STRICT_UNRESOLVED_METHOD');
    });
  });

  describe('edge cases', () => {
    it('should handle null comments', () => {
      const result = getGrafemaIgnore(null);
      assert.strictEqual(result, null);
    });

    it('should handle undefined comments', () => {
      const result = getGrafemaIgnore(undefined);
      assert.strictEqual(result, null);
    });

    it('should handle empty array', () => {
      const result = getGrafemaIgnore([]);
      assert.strictEqual(result, null);
    });

    it('should handle various error codes', () => {
      const codes = [
        'STRICT_UNRESOLVED_METHOD',
        'STRICT_UNRESOLVED_CALL',
        'STRICT_ALIAS_DEPTH_EXCEEDED',
        'SOME_CUSTOM_CODE_123'
      ];

      for (const code of codes) {
        const comments = [createLineComment(` grafema-ignore ${code}`)];
        const result = getGrafemaIgnore(comments);
        assert.ok(result, `Should parse code: ${code}`);
        assert.strictEqual(result.code, code, `Code should match: ${code}`);
      }
    });
  });
});
