/**
 * Tests for onboarding instruction loading.
 *
 * Verifies that getOnboardingInstruction() returns valid content
 * with expected structure and references to MCP tools.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getOnboardingInstruction } from '@grafema/core';

describe('getOnboardingInstruction', () => {
  it('should return a non-empty string', () => {
    const instruction = getOnboardingInstruction();
    assert.ok(typeof instruction === 'string');
    assert.ok(instruction.length > 0);
  });

  it('should contain expected section headers', () => {
    const instruction = getOnboardingInstruction();
    assert.ok(instruction.includes('## Step 1'));
    assert.ok(instruction.includes('## Step 2'));
    assert.ok(instruction.includes('## Step 3'));
    assert.ok(instruction.includes('## Step 4'));
    assert.ok(instruction.includes('## Step 5'));
    assert.ok(instruction.includes('## Step 6'));
  });

  it('should reference MCP tool names', () => {
    const instruction = getOnboardingInstruction();
    assert.ok(instruction.includes('read_project_structure'));
    assert.ok(instruction.includes('write_config'));
    assert.ok(instruction.includes('discover_services'));
    assert.ok(instruction.includes('analyze_project'));
    assert.ok(instruction.includes('get_stats'));
    assert.ok(instruction.includes('get_coverage'));
  });

  it('should contain guidance on when to ask the user', () => {
    const instruction = getOnboardingInstruction();
    assert.ok(instruction.includes('When to ask the user'));
  });
});
