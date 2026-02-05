/**
 * Tests for Diagnostic Categories - Single Source of Truth (REG-243)
 *
 * Verifies that the canonical DIAGNOSTIC_CATEGORIES definition
 * correctly generates bidirectional mappings.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  DIAGNOSTIC_CATEGORIES,
  CODE_TO_CATEGORY,
  getCategoryForCode,
  getCodesForCategory,
  type DiagnosticCategoryKey,
} from '../../../../packages/core/src/diagnostics/categories.js';

describe('DIAGNOSTIC_CATEGORIES', () => {
  it('should define all expected categories', () => {
    const keys = Object.keys(DIAGNOSTIC_CATEGORIES) as DiagnosticCategoryKey[];
    assert.ok(keys.includes('connectivity'), 'Should have connectivity category');
    assert.ok(keys.includes('calls'), 'Should have calls category');
    assert.ok(keys.includes('dataflow'), 'Should have dataflow category');
    assert.ok(keys.includes('imports'), 'Should have imports category');
  });

  it('should have name, description, and codes for each category', () => {
    for (const [key, category] of Object.entries(DIAGNOSTIC_CATEGORIES)) {
      assert.ok(category.name, `${key} should have name`);
      assert.ok(category.description, `${key} should have description`);
      assert.ok(Array.isArray(category.codes), `${key} should have codes array`);
      assert.ok(category.codes.length > 0, `${key} should have at least one code`);
    }
  });

  it('should not have duplicate codes across categories', () => {
    const allCodes: string[] = [];
    for (const category of Object.values(DIAGNOSTIC_CATEGORIES)) {
      allCodes.push(...category.codes);
    }
    const uniqueCodes = new Set(allCodes);
    assert.strictEqual(
      allCodes.length,
      uniqueCodes.size,
      'No code should appear in multiple categories'
    );
  });
});

describe('CODE_TO_CATEGORY (derived mapping)', () => {
  it('should create mapping for all codes in DIAGNOSTIC_CATEGORIES', () => {
    for (const [categoryKey, category] of Object.entries(DIAGNOSTIC_CATEGORIES)) {
      for (const code of category.codes) {
        const mapping = CODE_TO_CATEGORY[code];
        assert.ok(mapping, `${code} should have a mapping`);
        assert.ok(mapping.name, `${code} mapping should have name`);
        assert.strictEqual(
          mapping.checkCommand,
          `grafema check ${categoryKey}`,
          `${code} should have correct checkCommand`
        );
      }
    }
  });

  it('should have proper name format (lowercase)', () => {
    for (const [code, info] of Object.entries(CODE_TO_CATEGORY)) {
      assert.strictEqual(
        info.name,
        info.name.toLowerCase(),
        `${code} name should be lowercase`
      );
    }
  });
});

describe('getCategoryForCode()', () => {
  it('should return category info for known codes', () => {
    const info = getCategoryForCode('ERR_DISCONNECTED_NODES');
    assert.ok(info);
    assert.strictEqual(info.checkCommand, 'grafema check connectivity');
  });

  it('should return undefined for unknown codes', () => {
    const info = getCategoryForCode('UNKNOWN_CODE');
    assert.strictEqual(info, undefined);
  });
});

describe('getCodesForCategory()', () => {
  it('should return codes for connectivity category', () => {
    const codes = getCodesForCategory('connectivity');
    assert.ok(codes.includes('ERR_DISCONNECTED_NODES'));
    assert.ok(codes.includes('ERR_DISCONNECTED_NODE'));
  });

  it('should return codes for dataflow category', () => {
    const codes = getCodesForCategory('dataflow');
    assert.ok(codes.includes('ERR_MISSING_ASSIGNMENT'));
    assert.ok(codes.includes('ERR_BROKEN_REFERENCE'));
    assert.ok(codes.includes('ERR_NO_LEAF_NODE'));
  });

  it('should return codes for imports category', () => {
    const codes = getCodesForCategory('imports');
    assert.ok(codes.includes('ERR_BROKEN_IMPORT'));
    assert.ok(codes.includes('ERR_UNDEFINED_SYMBOL'));
  });
});

describe('bidirectional consistency', () => {
  it('should have every code in CODE_TO_CATEGORY point back to the correct category', () => {
    for (const [categoryKey, category] of Object.entries(DIAGNOSTIC_CATEGORIES)) {
      for (const code of category.codes) {
        const mapping = CODE_TO_CATEGORY[code];
        assert.ok(
          mapping.checkCommand.endsWith(categoryKey),
          `${code} should map back to ${categoryKey}`
        );
      }
    }
  });
});
