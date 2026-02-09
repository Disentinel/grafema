/**
 * Tests for MCP prompts handler logic.
 *
 * Verifies PROMPTS list and getPrompt() function behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PROMPTS, getPrompt } from '../dist/prompts.js';

describe('MCP Prompts', () => {
  describe('PROMPTS', () => {
    it('should contain onboard_project prompt', () => {
      assert.ok(PROMPTS.length >= 1);
      const onboard = PROMPTS.find(p => p.name === 'onboard_project');
      assert.ok(onboard);
      assert.ok(onboard.description.length > 0);
    });

    it('should have correct structure for onboard_project', () => {
      const onboard = PROMPTS.find(p => p.name === 'onboard_project');
      assert.ok(onboard);
      assert.strictEqual(typeof onboard.name, 'string');
      assert.strictEqual(typeof onboard.description, 'string');
      assert.ok(Array.isArray(onboard.arguments));
      assert.strictEqual(onboard.arguments.length, 0); // No arguments for onboarding
    });
  });

  describe('getPrompt', () => {
    it('should return onboarding instruction for onboard_project', () => {
      const result = getPrompt('onboard_project');
      assert.ok(result.description.length > 0);
      assert.strictEqual(result.messages.length, 1);
      assert.strictEqual(result.messages[0].role, 'user');
      assert.strictEqual(result.messages[0].content.type, 'text');
      assert.ok(result.messages[0].content.text.includes('## Step 1'));
    });

    it('should include all expected step headers in the instruction', () => {
      const result = getPrompt('onboard_project');
      const text = result.messages[0].content.text;
      assert.ok(text.includes('## Step 1'));
      assert.ok(text.includes('## Step 2'));
      assert.ok(text.includes('## Step 3'));
      assert.ok(text.includes('## Step 4'));
      assert.ok(text.includes('## Step 5'));
      assert.ok(text.includes('## Step 6'));
    });

    it('should throw error for unknown prompt name', () => {
      assert.throws(
        () => getPrompt('nonexistent'),
        /Unknown prompt: nonexistent/
      );
    });

    it('should mention available prompts in error message', () => {
      assert.throws(
        () => getPrompt('invalid_prompt'),
        /Available prompts:.*onboard_project/
      );
    });
  });
});
