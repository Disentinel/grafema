/**
 * Tests for node display formatting utilities - REG-325
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  formatNodeDisplay,
  formatNodeInline,
  getNodeDisplayName,
  type DisplayableNode
} from '../src/utils/formatNode.js';

describe('formatNode utilities', () => {
  const projectPath = '/project';

  describe('getNodeDisplayName', () => {
    it('should show METHOD PATH for http:route nodes', () => {
      const node: DisplayableNode = {
        id: 'http:route#GET:/api/users',
        type: 'http:route',
        name: '',  // empty name
        file: '/project/routes.js',
        method: 'GET',
        path: '/api/users'
      };

      const displayName = getNodeDisplayName(node);
      assert.strictEqual(displayName, 'GET /api/users');
    });

    it('should show METHOD URL for http:request nodes', () => {
      const node: DisplayableNode = {
        id: 'http:request#POST:/api/data',
        type: 'http:request',
        name: '',  // empty name
        file: '/project/client.js',
        method: 'POST',
        url: '/api/data'
      };

      const displayName = getNodeDisplayName(node);
      assert.strictEqual(displayName, 'POST /api/data');
    });

    it('should use name for regular nodes', () => {
      const node: DisplayableNode = {
        id: 'src/auth.js->FUNCTION->authenticate',
        type: 'FUNCTION',
        name: 'authenticate',
        file: '/project/src/auth.js'
      };

      const displayName = getNodeDisplayName(node);
      assert.strictEqual(displayName, 'authenticate');
    });

    it('should fallback when name is corrupted JSON', () => {
      // This is the bug we're fixing - name contains JSON metadata
      const node: DisplayableNode = {
        id: 'http:route#GET:/invitations/received#file.js#346',
        type: 'http:route',
        name: '{"originalId":"LITERAL#return#...","value":true,"valueType":"boolean","line":108}',
        file: '/project/routes.js',
        method: 'GET',
        path: '/invitations/received'
      };

      const displayName = getNodeDisplayName(node);
      // Should use method + path, not the corrupted name
      assert.strictEqual(displayName, 'GET /invitations/received');
    });

    it('should fallback to semantic ID extraction when name is corrupted and no method/path', () => {
      // If a node somehow has corrupted name but no method/path fields
      const node: DisplayableNode = {
        id: 'http:route#GET:/invitations/received#file.js#346',
        type: 'http:route',
        name: '{"corrupted": "json"}',
        file: '/project/routes.js'
        // no method/path
      };

      const displayName = getNodeDisplayName(node);
      // Should extract from semantic ID
      assert.strictEqual(displayName, 'GET:/invitations/received');
    });
  });

  describe('formatNodeDisplay', () => {
    it('should format http:route with method and path', () => {
      const node: DisplayableNode = {
        id: 'http:route#GET:/api/users',
        type: 'http:route',
        name: '',
        file: '/project/routes.js',
        line: 42,
        method: 'GET',
        path: '/api/users'
      };

      const output = formatNodeDisplay(node, { projectPath });
      assert.ok(output.includes('[http:route] GET /api/users'));
      assert.ok(output.includes('ID: http:route#GET:/api/users'));
      assert.ok(output.includes('Location: routes.js:42'));
    });

    it('should not show corrupted JSON in output', () => {
      const node: DisplayableNode = {
        id: 'http:route#GET:/invitations/received#file.js#346',
        type: 'http:route',
        name: '{"originalId":"LITERAL#return#...","value":true}',
        file: '/project/routes.js',
        line: 108,
        method: 'GET',
        path: '/invitations/received'
      };

      const output = formatNodeDisplay(node, { projectPath });
      // Should NOT contain the corrupted JSON in the first line
      assert.ok(!output.includes('"originalId"'), 'Should not contain JSON metadata');
      // Should show proper display name
      assert.ok(output.includes('[http:route] GET /invitations/received'));
    });
  });

  describe('formatNodeInline', () => {
    it('should return semantic ID', () => {
      const node: DisplayableNode = {
        id: 'src/auth.js->FUNCTION->authenticate',
        type: 'FUNCTION',
        name: 'authenticate',
        file: '/project/src/auth.js'
      };

      const inline = formatNodeInline(node);
      assert.strictEqual(inline, 'src/auth.js->FUNCTION->authenticate');
    });
  });
});
