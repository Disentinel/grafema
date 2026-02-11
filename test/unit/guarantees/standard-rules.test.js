/**
 * Standard Rules Library Tests - REG-314 Phase 3
 *
 * Tests for the standard Datalog rules library that provides
 * pre-built rules for common cardinality violations.
 *
 * Test scenarios:
 * 1. Library loader tests:
 *    - getStandardRule('n-squared-same-scale') returns rule definition
 *    - getStandardRule('nonexistent') returns null
 *    - listStandardRules() returns array of rule IDs
 *
 * 2. Rule content tests:
 *    - Rule has description, rule, severity fields
 *    - Rule Datalog syntax is valid (can be parsed)
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  getStandardRule,
  listStandardRules,
} from '../../../packages/core/dist/guarantees/index.js';

// =============================================================================
// TESTS: Standard Rules Library Loader
// =============================================================================

describe('Standard Rules Library (REG-314 Phase 3)', () => {
  // ===========================================================================
  // GROUP 1: Library Loader - getStandardRule()
  // ===========================================================================

  describe('getStandardRule()', () => {
    /**
     * Test: Get existing rule by ID.
     *
     * Expected behavior:
     * - Returns rule definition object
     * - Rule has id, description, rule, severity fields
     */
    it('should return rule definition for "n-squared-same-scale"', async () => {
      const rule = getStandardRule('n-squared-same-scale');

      assert.ok(rule, 'Rule should exist');
      assert.strictEqual(typeof rule, 'object', 'Rule should be an object');
      assert.strictEqual(rule.id, 'n-squared-same-scale', 'Rule ID should match');
    });

    /**
     * Test: Get non-existent rule.
     *
     * Expected behavior:
     * - Returns null (not undefined, not throws)
     */
    it('should return null for non-existent rule', async () => {
      const rule = getStandardRule('nonexistent-rule-xyz');

      assert.strictEqual(rule, null, 'Should return null for non-existent rule');
    });

    /**
     * Test: Get rule by ID with "standard:" prefix.
     *
     * Expected behavior:
     * - Should handle the prefix gracefully (strip it)
     * - Or reject it clearly (depends on design choice)
     *
     * Note: This tests the API's robustness.
     */
    it('should handle rule ID without prefix', async () => {
      // The API should accept clean IDs without "standard:" prefix
      const rule = getStandardRule('n-squared-same-scale');

      assert.ok(rule, 'Should find rule by clean ID');
    });
  });

  // ===========================================================================
  // GROUP 2: Library Loader - listStandardRules()
  // ===========================================================================

  describe('listStandardRules()', () => {
    /**
     * Test: List all available standard rules.
     *
     * Expected behavior:
     * - Returns array of rule IDs
     * - Array is not empty (we have at least one rule)
     */
    it('should return array of rule IDs', async () => {
      const ruleIds = listStandardRules();

      assert.ok(Array.isArray(ruleIds), 'Should return an array');
      assert.ok(ruleIds.length > 0, 'Should have at least one rule');
    });

    /**
     * Test: List includes our smoke test rule.
     *
     * Expected behavior:
     * - 'n-squared-same-scale' is in the list
     */
    it('should include "n-squared-same-scale" rule', async () => {
      const ruleIds = listStandardRules();

      assert.ok(
        ruleIds.includes('n-squared-same-scale'),
        'Should include n-squared-same-scale rule'
      );
    });

    /**
     * Test: All listed rules are retrievable.
     *
     * Expected behavior:
     * - Every ID in the list can be retrieved via getStandardRule()
     */
    it('should list only retrievable rules', async () => {
      const ruleIds = listStandardRules();

      for (const ruleId of ruleIds) {
        const rule = getStandardRule(ruleId);
        assert.ok(rule, `Rule "${ruleId}" should be retrievable`);
      }
    });
  });

  // ===========================================================================
  // GROUP 3: Rule Content Validation
  // ===========================================================================

  describe('Rule content validation', () => {
    /**
     * Test: Rule has required fields.
     *
     * Expected behavior:
     * - Each rule has: id, description, rule, severity
     * - All fields are of correct type
     */
    it('should have required fields: id, description, rule, severity', async () => {
      const rule = getStandardRule('n-squared-same-scale');

      assert.ok(rule, 'Rule should exist');

      // id
      assert.strictEqual(typeof rule.id, 'string', 'id should be a string');
      assert.ok(rule.id.length > 0, 'id should not be empty');

      // description
      assert.strictEqual(typeof rule.description, 'string', 'description should be a string');
      assert.ok(rule.description.length > 0, 'description should not be empty');

      // rule (Datalog query)
      assert.strictEqual(typeof rule.rule, 'string', 'rule should be a string');
      assert.ok(rule.rule.length > 0, 'rule should not be empty');

      // severity
      assert.strictEqual(typeof rule.severity, 'string', 'severity should be a string');
      assert.ok(
        ['error', 'warning', 'info'].includes(rule.severity),
        `severity should be error/warning/info, got: ${rule.severity}`
      );
    });

    /**
     * Test: Rule Datalog syntax is valid.
     *
     * Expected behavior:
     * - Rule contains 'violation(' head
     * - Rule contains ':-' (Datalog rule separator)
     * - Rule ends with '.'
     *
     * Note: This is a basic syntax check, not a full parser.
     * Full validation would require RFDB.
     */
    it('should have valid Datalog rule syntax', async () => {
      const rule = getStandardRule('n-squared-same-scale');

      assert.ok(rule, 'Rule should exist');
      const datalog = rule.rule;

      // Should define a violation head
      assert.ok(
        datalog.includes('violation('),
        'Datalog rule should define violation() head'
      );

      // Should have rule body separator
      assert.ok(
        datalog.includes(':-'),
        'Datalog rule should have :- separator'
      );

      // Should end with period (after trimming whitespace)
      const trimmed = datalog.trim();
      assert.ok(
        trimmed.endsWith('.'),
        'Datalog rule should end with period'
      );
    });

    /**
     * Test: All rules have valid content.
     *
     * Expected behavior:
     * - Every rule in the library has valid structure
     */
    it('should have valid content for all rules', async () => {
      const ruleIds = listStandardRules();

      for (const ruleId of ruleIds) {
        const rule = getStandardRule(ruleId);
        assert.ok(rule, `Rule "${ruleId}" should exist`);

        // Required fields
        assert.strictEqual(typeof rule.id, 'string', `${ruleId}: id should be string`);
        assert.strictEqual(typeof rule.description, 'string', `${ruleId}: description should be string`);
        assert.strictEqual(typeof rule.rule, 'string', `${ruleId}: rule should be string`);
        assert.strictEqual(typeof rule.severity, 'string', `${ruleId}: severity should be string`);

        // Valid severity
        assert.ok(
          ['error', 'warning', 'info'].includes(rule.severity),
          `${ruleId}: invalid severity "${rule.severity}"`
        );

        // Basic Datalog syntax
        assert.ok(rule.rule.includes('violation('), `${ruleId}: should define violation()`);
        assert.ok(rule.rule.includes(':-'), `${ruleId}: should have :- separator`);
        assert.ok(rule.rule.trim().endsWith('.'), `${ruleId}: should end with period`);
      }
    });
  });

  // ===========================================================================
  // GROUP 4: Edge Cases
  // ===========================================================================

  describe('Edge cases', () => {
    /**
     * Test: Empty string rule ID.
     *
     * Expected behavior:
     * - Returns null (doesn't crash)
     */
    it('should return null for empty string rule ID', async () => {
      const rule = getStandardRule('');

      assert.strictEqual(rule, null, 'Should return null for empty string');
    });

    /**
     * Test: Rule ID with special characters.
     *
     * Expected behavior:
     * - Returns null (rule doesn't exist)
     * - Doesn't throw or crash
     */
    it('should handle rule ID with special characters', async () => {
      const rule = getStandardRule('rule/../../../etc/passwd');

      assert.strictEqual(rule, null, 'Should return null for invalid ID');
    });

    /**
     * Test: listStandardRules returns fresh array each call.
     *
     * Expected behavior:
     * - Mutating returned array doesn't affect next call
     */
    it('should return fresh array from listStandardRules', async () => {
      const ruleIds1 = listStandardRules();
      const originalLength = ruleIds1.length;

      // Mutate the returned array
      ruleIds1.push('fake-rule');

      // Get a new list
      const ruleIds2 = listStandardRules();

      assert.strictEqual(
        ruleIds2.length,
        originalLength,
        'Second call should not include mutated value'
      );
    });
  });
});
