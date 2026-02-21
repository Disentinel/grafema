/**
 * LiteralNode Unit Tests (REG-558)
 *
 * Tests that LITERAL nodes display their value as name,
 * not the file path.
 *
 * Formatting rules:
 * - String literals: 'value' (single-quoted)
 * - Number literals: 42
 * - Boolean literals: true / false
 * - Null literal: null
 * - Truncation: >64 chars -> truncated content + ellipsis + closing quote (64 total)
 * - Internal single quotes: escaped as \'
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { LiteralNode } from '../../packages/core/dist/core/nodes/LiteralNode.js';

const FILE = '/project/src/config.ts';
const LINE = 10;
const COLUMN = 5;

describe('LiteralNode (REG-558)', () => {
  describe('LiteralNode.formatName via create()', () => {
    it('should use string value with single quotes as name', () => {
      const node = LiteralNode.create('hello', FILE, LINE, COLUMN);

      assert.strictEqual(node.name, "'hello'", 'String literal name should be single-quoted');
    });

    it('should use number value as name', () => {
      const node = LiteralNode.create(42, FILE, LINE, COLUMN);

      assert.strictEqual(node.name, '42', 'Number literal name should be the number as string');
    });

    it('should use boolean true as name', () => {
      const node = LiteralNode.create(true, FILE, LINE, COLUMN);

      assert.strictEqual(node.name, 'true', 'Boolean true name should be "true"');
    });

    it('should use boolean false as name', () => {
      const node = LiteralNode.create(false, FILE, LINE, COLUMN);

      assert.strictEqual(node.name, 'false', 'Boolean false name should be "false"');
    });

    it('should use null as name', () => {
      const node = LiteralNode.create(null, FILE, LINE, COLUMN);

      assert.strictEqual(node.name, 'null', 'Null literal name should be "null"');
    });

    it('should handle undefined value', () => {
      const node = LiteralNode.create(undefined, FILE, LINE, COLUMN);

      assert.strictEqual(node.name, 'undefined', 'Undefined value name should be "undefined"');
    });

    it('should handle zero as name', () => {
      const node = LiteralNode.create(0, FILE, LINE, COLUMN);

      assert.strictEqual(node.name, '0', 'Zero literal name should be "0"');
    });

    it('should handle empty string with quotes as name', () => {
      const node = LiteralNode.create('', FILE, LINE, COLUMN);

      assert.strictEqual(node.name, "''", 'Empty string literal name should be two single quotes');
    });

    it('should handle negative number as name', () => {
      const node = LiteralNode.create(-1, FILE, LINE, COLUMN);

      assert.strictEqual(node.name, '-1', 'Negative number name should include minus sign');
    });

    it('should handle float as name', () => {
      const node = LiteralNode.create(3.14, FILE, LINE, COLUMN);

      assert.strictEqual(node.name, '3.14', 'Float literal name should include decimal');
    });
  });

  describe('Truncation', () => {
    it('should not truncate string exactly at 64 chars', () => {
      // With quotes: 'xxx...xxx' = 62 content chars + 2 quotes = 64 total
      const value = 'a'.repeat(62);
      const node = LiteralNode.create(value, FILE, LINE, COLUMN);

      // formatted = 'aaa...aaa' = 64 chars total (62 + 2 quotes)
      assert.strictEqual(node.name.length, 64, 'Name at exactly 64 chars should not be truncated');
      assert.ok(!node.name.endsWith('\u2026'), 'Should not have ellipsis at exactly 64 chars');
    });

    it('should truncate string longer than 64 chars with closing quote preserved', () => {
      // With quotes: 'xxx...xxx' > 64 chars
      const value = 'a'.repeat(100);
      const node = LiteralNode.create(value, FILE, LINE, COLUMN);

      assert.strictEqual(node.name.length, 64, 'Truncated name should be exactly 64 chars');
      assert.ok(node.name.endsWith("\u2026'"), 'Truncated name should end with ellipsis + closing quote');
    });

    it('should truncate to content + ellipsis + closing quote = 64 total', () => {
      const value = 'b'.repeat(200);
      const node = LiteralNode.create(value, FILE, LINE, COLUMN);

      // 'bbb...b…' = opening quote + 61 chars + ellipsis + closing quote = 64 total
      assert.strictEqual(node.name.length, 64);
      assert.strictEqual(node.name[63], "'", 'Last char should be closing quote');
      assert.strictEqual(node.name[62], '\u2026', 'Second-to-last char should be ellipsis');
      assert.strictEqual(node.name[0], "'", 'Should start with single quote');
    });

    it('should not truncate short strings', () => {
      const node = LiteralNode.create('short', FILE, LINE, COLUMN);

      assert.strictEqual(node.name, "'short'");
      assert.ok(node.name.length < 64);
    });

    it('should escape internal single quotes', () => {
      const node = LiteralNode.create("it's a test", FILE, LINE, COLUMN);

      assert.strictEqual(node.name, "'it\\'s a test'", 'Internal single quotes should be escaped');
    });

    it('should escape multiple internal single quotes', () => {
      const node = LiteralNode.create("it's Bob's", FILE, LINE, COLUMN);

      assert.strictEqual(node.name, "'it\\'s Bob\\'s'");
    });
  });

  describe('Other fields remain correct', () => {
    it('should preserve all standard fields', () => {
      const node = LiteralNode.create('test', FILE, LINE, COLUMN);

      assert.strictEqual(node.type, 'LITERAL');
      assert.strictEqual(node.file, FILE);
      assert.strictEqual(node.line, LINE);
      assert.strictEqual(node.column, COLUMN);
      assert.strictEqual(node.value, 'test');
      assert.strictEqual(node.valueType, 'string');
    });

    it('should preserve options', () => {
      const node = LiteralNode.create('test', FILE, LINE, COLUMN, {
        parentCallId: 'call-123',
        argIndex: 0,
      });

      assert.strictEqual(node.parentCallId, 'call-123');
      assert.strictEqual(node.argIndex, 0);
    });

    it('should generate correct id', () => {
      const node = LiteralNode.create('test', FILE, LINE, COLUMN);

      assert.strictEqual(
        node.id,
        `${FILE}:LITERAL:value:${LINE}:${COLUMN}`,
        'ID format should remain unchanged'
      );
    });

    it('should NOT use file path as name', () => {
      const node = LiteralNode.create('hello', FILE, LINE, COLUMN);

      assert.notStrictEqual(
        node.name,
        FILE,
        'Name must NOT be the file path (this was the bug)'
      );
    });
  });

  describe('LiteralNode.validate()', () => {
    it('should pass validation for valid node', () => {
      const node = LiteralNode.create('test', FILE, LINE, COLUMN);
      const errors = LiteralNode.validate(node);

      assert.strictEqual(errors.length, 0, 'Valid node should have no validation errors');
    });

    it('should reject node with wrong type', () => {
      const invalidNode = {
        ...LiteralNode.create('test', FILE, LINE, COLUMN),
        type: 'WRONG_TYPE',
      };

      const errors = LiteralNode.validate(invalidNode);

      assert.ok(errors.length > 0, 'Should return errors for wrong type');
    });
  });
});
