/**
 * Integration tests for buildHoverMarkdown — REG-513
 *
 * Tests the hover card rendering: markdown output for value origins,
 * empty state, indentation of children, and source annotations.
 *
 * Since vscode module is unavailable in Node.js test runner,
 * we mock vscode.MarkdownString with a minimal implementation
 * that captures the appended markdown text.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WireNode } from '@grafema/types';
import type { NodeMetadata } from '../../src/types.js';

// ============================================================================
// Types (defined here until src/types.ts is updated by Rob)
// ============================================================================

type SourceKind = 'user-input' | 'literal' | 'config' | 'external' | 'unknown';

interface TraceNode {
  node: WireNode;
  metadata: NodeMetadata;
  edgeType: string;
  depth: number;
  sourceKind?: SourceKind;
  children: TraceNode[];
  hasMoreChildren?: boolean;
}

// ============================================================================
// Mock vscode.MarkdownString
//
// The real vscode.MarkdownString accumulates text via appendMarkdown().
// Our mock stores it in .value so tests can inspect the rendered output.
// ============================================================================

class MockMarkdownString {
  value: string = '';
  isTrusted: boolean = false;
  supportHtml: boolean = false;

  constructor(value: string = '') {
    this.value = value;
  }

  appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }

  appendText(text: string): this {
    this.value += text;
    return this;
  }
}

// Inject mock vscode module into require cache BEFORE importing hoverProvider.
// hoverProvider.ts does `import * as vscode from 'vscode'` which becomes
// `require('vscode')` in CJS. We pre-populate the cache with a mock.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: unknown[]) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, ...args);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: {
    MarkdownString: MockMarkdownString,
    // Stubs for other vscode APIs used by hoverProvider imports
    workspace: { workspaceFolders: [] },
    languages: { registerHoverProvider: () => ({ dispose: () => {} }) },
  },
} as any;

// ============================================================================
// Helper to create WireNode
// ============================================================================

function makeNode(
  id: string,
  nodeType: string,
  name: string,
  overrides?: Partial<WireNode>,
): WireNode {
  return {
    id,
    nodeType: nodeType as WireNode['nodeType'],
    name,
    file: 'test.ts',
    exported: false,
    metadata: JSON.stringify({ line: 1 }),
    ...overrides,
  };
}

// ============================================================================
// Import buildHoverMarkdown
//
// This function must be exported from hoverProvider.ts for testing.
// It receives a MarkdownString constructor so we can inject our mock.
//
// If the module does not exist yet, the test file will fail to load.
// ============================================================================

// Use require() because vscode package is CJS (no "type":"module" in package.json)
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const hoverModule = require('../../src/hoverProvider');
const { buildHoverMarkdown } = hoverModule;

// ============================================================================
// Tests
// ============================================================================

describe('buildHoverMarkdown', () => {
  it('empty origins shows "No value origins found"', () => {
    const root = makeNode('R', 'VARIABLE', 'options.role');

    const md = buildHoverMarkdown(root, [], MockMarkdownString as any);
    const text = md.value;

    assert.ok(
      text.includes('No value origins found'),
      `Expected "No value origins found" in:\n${text}`,
    );
    assert.ok(
      text.includes('grafema.openValueTrace'),
      'Link to VALUE TRACE panel should always be present',
    );
  });

  it('two origins produce two arrow lines with names and locations', () => {
    const origins: TraceNode[] = [
      {
        node: makeNode('B1', 'VARIABLE', 'req.body.role', {
          file: 'auth.ts',
          metadata: JSON.stringify({ line: 18 }),
        }),
        metadata: { line: 18 },
        edgeType: 'ASSIGNED_FROM',
        depth: 0,
        sourceKind: undefined,
        children: [],
      },
      {
        node: makeNode('B2', 'LITERAL', '"user"', {
          file: 'defaults.ts',
          metadata: JSON.stringify({ line: 5 }),
        }),
        metadata: { line: 5 },
        edgeType: 'ASSIGNED_FROM',
        depth: 0,
        sourceKind: 'literal',
        children: [],
      },
    ];

    const root = makeNode('R', 'VARIABLE', 'options.role');
    const md = buildHoverMarkdown(root, origins, MockMarkdownString as any);
    const text = md.value;

    // Count arrow characters
    const leftArrows = (text.match(/\u2190/g) || []).length;
    assert.strictEqual(leftArrows, 2, `Expected 2 left arrows in:\n${text}`);

    assert.ok(text.includes('req.body.role'), 'Should mention first origin name');
    assert.ok(text.includes('"user"'), 'Should mention second origin name');
    assert.ok(text.includes('literal'), 'Should show literal annotation');
  });

  it('origin with children shows indented child lines', () => {
    const child: TraceNode = {
      node: makeNode('C1', 'LITERAL', '"admin"', {
        file: 'roles.ts',
        metadata: JSON.stringify({ line: 3 }),
      }),
      metadata: { line: 3 },
      edgeType: 'ASSIGNED_FROM',
      depth: 1,
      sourceKind: 'literal',
      children: [],
    };

    const parent: TraceNode = {
      node: makeNode('B1', 'VARIABLE', 'role', {
        file: 'auth.ts',
        metadata: JSON.stringify({ line: 10 }),
      }),
      metadata: { line: 10 },
      edgeType: 'ASSIGNED_FROM',
      depth: 0,
      sourceKind: undefined,
      children: [child],
    };

    const root = makeNode('R', 'VARIABLE', 'userRole');
    const md = buildHoverMarkdown(root, [parent], MockMarkdownString as any);
    const text = md.value;

    // Should have 2 arrows: one for parent, one for child
    const leftArrows = (text.match(/\u2190/g) || []).length;
    assert.strictEqual(leftArrows, 2, `Expected 2 arrows (parent + child) in:\n${text}`);

    assert.ok(text.includes('role'), 'Should mention parent origin');
    assert.ok(text.includes('"admin"'), 'Should mention child origin');
    assert.ok(text.includes('literal'), 'Should show literal annotation on child');
  });

  it('header contains Grafema branding and root node name', () => {
    const root = makeNode('R', 'VARIABLE', 'myVar');
    const md = buildHoverMarkdown(root, [], MockMarkdownString as any);
    const text = md.value;

    assert.ok(text.includes('GRAFEMA'), 'Should include GRAFEMA branding');
    assert.ok(text.includes('myVar'), 'Should include root variable name');
  });

  it('source annotations display without dashes', () => {
    const origin: TraceNode = {
      node: makeNode('P1', 'http:request', 'request', {
        file: 'server.ts',
        metadata: JSON.stringify({ line: 7 }),
      }),
      metadata: { line: 7 },
      edgeType: 'ASSIGNED_FROM',
      depth: 0,
      sourceKind: 'user-input',
      children: [],
    };

    const root = makeNode('R', 'VARIABLE', 'data');
    const md = buildHoverMarkdown(root, [origin], MockMarkdownString as any);
    const text = md.value;

    // "user-input" should be displayed as "user input" (dash replaced with space)
    assert.ok(
      text.includes('user input'),
      `Expected "user input" (space, not dash) in:\n${text}`,
    );
  });
});
