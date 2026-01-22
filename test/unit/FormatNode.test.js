/**
 * Tests for formatNode utility - REG-125
 *
 * TDD: Write tests first, then implement.
 * These tests define the contract for semantic ID display in CLI output.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

// Will be implemented in packages/cli/src/utils/formatNode.ts
import {
  formatNodeDisplay,
  formatNodeInline,
  formatLocation,
} from '../../packages/cli/dist/utils/formatNode.js';

describe('formatNode utility', () => {
  describe('formatNodeDisplay', () => {
    it('should format a function node with all fields', () => {
      const node = {
        id: 'src/auth/service.ts->AuthService->FUNCTION->authenticate',
        type: 'FUNCTION',
        name: 'authenticate',
        file: '/project/src/auth/service.ts',
        line: 42,
      };

      const result = formatNodeDisplay(node, { projectPath: '/project' });

      assert.ok(result.includes('[FUNCTION] authenticate'), 'Should show [TYPE] name');
      assert.ok(
        result.includes('ID: src/auth/service.ts->AuthService->FUNCTION->authenticate'),
        'Should show semantic ID'
      );
      assert.ok(result.includes('Location: src/auth/service.ts:42'), 'Should show location');
    });

    it('should handle node without line number', () => {
      const node = {
        id: 'src/index.ts->MODULE->main',
        type: 'MODULE',
        name: 'main',
        file: '/project/src/index.ts',
      };

      const result = formatNodeDisplay(node, { projectPath: '/project' });

      assert.ok(result.includes('[MODULE] main'));
      assert.ok(result.includes('Location: src/index.ts'));
      assert.ok(!result.includes(':undefined'), 'Should not include :undefined');
    });

    it('should handle node without file', () => {
      const node = {
        id: 'external->FUNCTION->fetch',
        type: 'FUNCTION',
        name: 'fetch',
        file: '',
      };

      const result = formatNodeDisplay(node, { projectPath: '/project' });

      assert.ok(result.includes('[FUNCTION] fetch'));
      assert.ok(result.includes('ID: external->FUNCTION->fetch'));
      // Location line should be absent for nodes without file
      const lines = result.split('\n');
      assert.ok(!lines.some((l) => l.includes('Location:')), 'Should not have Location line');
    });

    it('should respect showLocation option when false', () => {
      const node = {
        id: 'src/utils.ts->FUNCTION->helper',
        type: 'FUNCTION',
        name: 'helper',
        file: '/project/src/utils.ts',
        line: 10,
      };

      const result = formatNodeDisplay(node, {
        projectPath: '/project',
        showLocation: false,
      });

      assert.ok(!result.includes('Location:'), 'Should not include Location when showLocation is false');
    });

    it('should apply indent prefix to all lines', () => {
      const node = {
        id: 'src/app.ts->FUNCTION->run',
        type: 'FUNCTION',
        name: 'run',
        file: '/project/src/app.ts',
        line: 5,
      };

      const result = formatNodeDisplay(node, {
        projectPath: '/project',
        indent: '  ',
      });

      const lines = result.split('\n');
      assert.ok(lines[0].startsWith('  [FUNCTION]'), 'First line should be indented');
      assert.ok(lines[1].startsWith('    ID:'), 'ID line should have extra indent');
      assert.ok(lines[2].startsWith('    Location:'), 'Location line should have extra indent');
    });

    it('should handle CLASS type correctly', () => {
      const node = {
        id: 'src/models/User.ts->CLASS->User',
        type: 'CLASS',
        name: 'User',
        file: '/project/src/models/User.ts',
        line: 1,
      };

      const result = formatNodeDisplay(node, { projectPath: '/project' });

      assert.ok(result.includes('[CLASS] User'));
      assert.ok(result.includes('ID: src/models/User.ts->CLASS->User'));
    });

    it('should handle VARIABLE type correctly', () => {
      const node = {
        id: 'src/config.ts->VARIABLE->API_URL',
        type: 'VARIABLE',
        name: 'API_URL',
        file: '/project/src/config.ts',
        line: 5,
      };

      const result = formatNodeDisplay(node, { projectPath: '/project' });

      assert.ok(result.includes('[VARIABLE] API_URL'));
      assert.ok(result.includes('ID: src/config.ts->VARIABLE->API_URL'));
    });

    it('should handle undefined node.id gracefully', () => {
      const node = {
        id: '',
        type: 'FUNCTION',
        name: 'unknown',
        file: '/project/src/unknown.ts',
        line: 1,
      };

      const result = formatNodeDisplay(node, { projectPath: '/project' });

      // Should still format without throwing
      assert.ok(result.includes('[FUNCTION] unknown'));
      // ID line should be present but possibly empty
      assert.ok(result.includes('ID:'));
    });
  });

  describe('formatNodeInline', () => {
    it('should return semantic ID only', () => {
      const node = {
        id: 'src/auth.ts->FUNCTION->login',
        type: 'FUNCTION',
        name: 'login',
        file: '/project/src/auth.ts',
        line: 20,
      };

      const result = formatNodeInline(node);

      assert.equal(result, 'src/auth.ts->FUNCTION->login');
    });

    it('should handle complex nested semantic IDs', () => {
      const node = {
        id: 'src/auth/service.ts->AuthService->FUNCTION->authenticate->VARIABLE->token',
        type: 'VARIABLE',
        name: 'token',
        file: '/project/src/auth/service.ts',
        line: 45,
      };

      const result = formatNodeInline(node);

      assert.equal(
        result,
        'src/auth/service.ts->AuthService->FUNCTION->authenticate->VARIABLE->token'
      );
    });

    it('should return empty string for node with no id', () => {
      const node = {
        id: '',
        type: 'FUNCTION',
        name: 'unknown',
        file: '',
      };

      const result = formatNodeInline(node);

      assert.equal(result, '');
    });
  });

  describe('formatLocation', () => {
    it('should format relative path with line number', () => {
      const result = formatLocation('/project/src/file.ts', 42, '/project');
      assert.equal(result, 'src/file.ts:42');
    });

    it('should format relative path without line number', () => {
      const result = formatLocation('/project/src/file.ts', undefined, '/project');
      assert.equal(result, 'src/file.ts');
    });

    it('should return empty string for undefined file', () => {
      const result = formatLocation(undefined, 42, '/project');
      assert.equal(result, '');
    });

    it('should return empty string for empty file', () => {
      const result = formatLocation('', 42, '/project');
      assert.equal(result, '');
    });

    it('should handle absolute paths correctly', () => {
      const result = formatLocation('/project/deep/nested/path/file.ts', 100, '/project');
      assert.equal(result, 'deep/nested/path/file.ts:100');
    });

    it('should handle paths outside project', () => {
      const result = formatLocation('/other/project/file.ts', 10, '/project');
      // Should return relative path (possibly with ..)
      assert.ok(result.includes('file.ts'));
    });
  });
});
