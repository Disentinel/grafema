/**
 * Tests for orphaned node guarantees (Datalog-based)
 *
 * Validates that every guarantee rule in .grafema/guarantees.yaml:
 * 1. Parses correctly (no Datalog syntax errors)
 * 2. Detects violations when expected (orphaned nodes)
 * 3. Passes when nodes are properly connected
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Simple YAML parser for our guarantees file (avoids external dep)
function parseGuaranteesYaml(content: string): Array<{ name: string; check: string; rule?: string; severity: string }> {
  const guarantees: Array<{ name: string; check: string; rule?: string; severity: string }> = [];
  let current: Record<string, string> | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();
    // New guarantee entry
    if (/^\s+-\s+name:\s+/.test(line)) {
      if (current?.name) guarantees.push(current as any);
      current = { name: line.replace(/^\s+-\s+name:\s+/, '').trim() };
      continue;
    }
    if (!current) continue;

    // Single-line fields
    const fieldMatch = line.match(/^\s+(check|severity):\s+(.+)/);
    if (fieldMatch) {
      current[fieldMatch[1]] = fieldMatch[2].trim();
      continue;
    }

    // Rule field (single-line quoted or multi-line |)
    const ruleMatch = line.match(/^\s+rule:\s+(.+)/);
    if (ruleMatch) {
      let val = ruleMatch[1].trim();
      if (val === '|' || val === '>-') {
        // Multi-line: collect subsequent indented lines
        current.rule = '__MULTILINE__';
      } else {
        // Remove surrounding quotes
        if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
          val = val.slice(1, -1);
        }
        current.rule = val;
      }
      continue;
    }

    // Multi-line continuation for rule
    if (current.rule === '__MULTILINE__' && /^\s{6,}/.test(line) && line.trim()) {
      current.rule = line.trim();
      continue;
    }
    if (current.rule && current.rule !== '__MULTILINE__' && /^\s{6,}/.test(line) && line.trim()) {
      current.rule += '\n' + line.trim();
      continue;
    }
  }
  if (current?.name) guarantees.push(current as any);
  return guarantees;
}

// Load all Datalog guarantees from YAML
const guaranteesPath = join(import.meta.dirname, '../../.grafema/guarantees.yaml');
const content = readFileSync(guaranteesPath, 'utf-8');
const allGuarantees = parseGuaranteesYaml(content);
const datalogGuarantees = allGuarantees.filter(g => g.check === 'datalog');

describe('Orphaned Node Guarantees', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'];

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(cleanupAllTestDatabases);

  // =====================================================
  // Tier 0: All rules parse without errors
  // =====================================================

  describe('Rule syntax validation', () => {
    for (const g of datalogGuarantees) {
      it(`${g.name}: parses without error`, async () => {
        // checkGuarantee with no matching nodes should return []
        // If the rule has a syntax error, it throws
        const violations = await backend.checkGuarantee(g.rule);
        // Empty graph → no violations expected (no nodes to violate)
        assert.ok(Array.isArray(violations), `Rule should return array, got: ${typeof violations}`);
      });
    }
  });

  // =====================================================
  // Tier 1: Structural containment — CONTAINS checks
  // =====================================================

  describe('CONTAINS-based containment', () => {
    const containsTypes = [
      { type: 'FUNCTION', guarantee: 'function-has-contains', fields: { async: false, generator: false, exported: false, arrowFunction: false } },
      { type: 'CLASS', guarantee: 'class-has-contains', fields: { exported: false } },
      { type: 'VARIABLE', guarantee: 'variable-has-contains', fields: { kind: 'const', exported: false } },
      { type: 'PARAMETER', guarantee: 'parameter-has-contains', fields: {} },
      { type: 'CALL', guarantee: 'call-has-contains', fields: { callee: 'foo' } },
      { type: 'IMPORT', guarantee: 'import-has-contains', fields: { source: './foo', specifiers: [] } },
      { type: 'EXPORT', guarantee: 'export-has-contains', fields: { exportedName: 'foo' } },
      { type: 'EXPRESSION', guarantee: 'expression-has-contains', fields: {} },
      { type: 'LITERAL', guarantee: 'literal-has-contains', fields: {} },
      { type: 'LOOP', guarantee: 'loop-has-contains', fields: { loopType: 'for' } },
      { type: 'BRANCH', guarantee: 'branch-has-contains', fields: { branchType: 'if' } },
      { type: 'TRY_BLOCK', guarantee: 'try-has-contains', fields: {} },
      { type: 'PROPERTY_ACCESS', guarantee: 'property-access-has-contains', fields: { objectName: 'obj' } },
      { type: 'PROPERTY_ASSIGNMENT', guarantee: 'property-assignment-has-contains', fields: { objectName: 'this' } },
      { type: 'SIDE_EFFECT', guarantee: 'side-effect-has-contains', fields: {} },
    ];

    for (const { type, guarantee, fields } of containsTypes) {
      const rule = datalogGuarantees.find((g: { name: string }) => g.name === guarantee)?.rule;
      if (!rule) continue;

      it(`${guarantee}: detects orphaned ${type}`, async () => {
        // Add orphaned node (no CONTAINS edge)
        await backend.addNode({
          id: `test::orphaned-${type.toLowerCase()}`,
          type,
          name: `orphaned_${type.toLowerCase()}`,
          file: 'test.js',
          line: 1,
          column: 0,
          ...fields,
        });

        const violations = await backend.checkGuarantee(rule);
        assert.strictEqual(violations.length, 1, `Should detect 1 orphaned ${type} node`);
      });

      it(`${guarantee}: passes when ${type} is contained`, async () => {
        const moduleId = 'test::module';
        const nodeId = `test::contained-${type.toLowerCase()}`;

        await backend.addNode({
          id: moduleId,
          type: 'MODULE',
          name: 'test.js',
          file: 'test.js',
          relativePath: 'test.js',
          contentHash: 'abc123',
        });
        await backend.addNode({
          id: nodeId,
          type,
          name: `contained_${type.toLowerCase()}`,
          file: 'test.js',
          line: 1,
          column: 0,
          ...fields,
        });
        await backend.addEdge({ src: moduleId, dst: nodeId, type: 'CONTAINS' });

        const violations = await backend.checkGuarantee(rule);
        assert.strictEqual(violations.length, 0, `${type} with CONTAINS should not violate`);
      });
    }
  });

  // =====================================================
  // Tier 1: Special structural links
  // =====================================================

  describe('Special structural containment', () => {
    it('method-has-class: detects orphaned METHOD', async () => {
      await backend.addNode({
        id: 'test::orphaned-method',
        type: 'METHOD',
        name: 'doStuff',
        file: 'test.js',
        line: 5,
        column: 0,
        className: 'Foo',
        async: false,
        static: false,
        kind: 'method',
      });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'method-has-class')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 1, 'Should detect orphaned METHOD');
    });

    it('method-has-class: passes when METHOD has HAS_MEMBER', async () => {
      await backend.addNode({
        id: 'test::class',
        type: 'CLASS',
        name: 'Foo',
        file: 'test.js',
        exported: false,
      });
      await backend.addNode({
        id: 'test::method',
        type: 'METHOD',
        name: 'doStuff',
        file: 'test.js',
        className: 'Foo',
        async: false,
        static: false,
        kind: 'method',
      });
      await backend.addEdge({ src: 'test::class', dst: 'test::method', type: 'HAS_MEMBER' });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'method-has-class')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 0, 'METHOD with HAS_MEMBER should not violate');
    });

    it('case-has-branch: detects orphaned CASE', async () => {
      await backend.addNode({
        id: 'test::orphaned-case',
        type: 'CASE',
        name: 'case_add',
        file: 'test.js',
        value: 'ADD',
        isDefault: false,
        fallsThrough: false,
        isEmpty: false,
      });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'case-has-branch')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 1, 'Should detect orphaned CASE');
    });

    it('case-has-branch: passes with HAS_CASE', async () => {
      await backend.addNode({
        id: 'test::branch',
        type: 'BRANCH',
        name: 'switch',
        file: 'test.js',
        branchType: 'switch',
      });
      await backend.addNode({
        id: 'test::case',
        type: 'CASE',
        name: 'case_add',
        file: 'test.js',
        value: 'ADD',
        isDefault: false,
        fallsThrough: false,
        isEmpty: false,
      });
      await backend.addEdge({ src: 'test::branch', dst: 'test::case', type: 'HAS_CASE' });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'case-has-branch')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 0, 'CASE with HAS_CASE should not violate');
    });

    it('catch-has-try: detects orphaned CATCH_BLOCK', async () => {
      await backend.addNode({
        id: 'test::orphaned-catch',
        type: 'CATCH_BLOCK',
        name: 'catch',
        file: 'test.js',
      });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'catch-has-try')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 1);
    });

    it('finally-has-try: detects orphaned FINALLY_BLOCK', async () => {
      await backend.addNode({
        id: 'test::orphaned-finally',
        type: 'FINALLY_BLOCK',
        name: 'finally',
        file: 'test.js',
      });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'finally-has-try')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 1);
    });

    it('scope-has-parent: detects orphaned SCOPE', async () => {
      await backend.addNode({
        id: 'test::orphaned-scope',
        type: 'SCOPE',
        name: 'scope',
        file: 'test.js',
        scopeType: 'function',
      });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'scope-has-parent')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 1, 'Should detect orphaned SCOPE');
    });

    it('scope-has-parent: passes with HAS_SCOPE', async () => {
      await backend.addNode({
        id: 'test::func',
        type: 'FUNCTION',
        name: 'myFunc',
        file: 'test.js',
        async: false,
        generator: false,
        exported: false,
        arrowFunction: false,
      });
      await backend.addNode({
        id: 'test::scope',
        type: 'SCOPE',
        name: 'scope',
        file: 'test.js',
        scopeType: 'function',
      });
      await backend.addEdge({ src: 'test::func', dst: 'test::scope', type: 'HAS_SCOPE' });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'scope-has-parent')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 0, 'SCOPE with HAS_SCOPE should not violate');
    });

    it('scope-has-parent: passes with HAS_BODY (from loop)', async () => {
      await backend.addNode({
        id: 'test::loop',
        type: 'LOOP',
        name: 'for',
        file: 'test.js',
        loopType: 'for',
      });
      await backend.addNode({
        id: 'test::scope2',
        type: 'SCOPE',
        name: 'scope',
        file: 'test.js',
        scopeType: 'block',
      });
      await backend.addEdge({ src: 'test::loop', dst: 'test::scope2', type: 'HAS_BODY' });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'scope-has-parent')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 0, 'SCOPE with HAS_BODY should not violate');
    });

    it('module-has-children: detects empty MODULE', async () => {
      await backend.addNode({
        id: 'test::empty-module',
        type: 'MODULE',
        name: 'empty.js',
        file: 'empty.js',
        relativePath: 'empty.js',
        contentHash: 'abc123',
      });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'module-has-children')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 1, 'Should detect empty MODULE');
    });

    it('module-has-children: passes when MODULE has CONTAINS', async () => {
      await backend.addNode({
        id: 'test::module',
        type: 'MODULE',
        name: 'test.js',
        file: 'test.js',
        relativePath: 'test.js',
        contentHash: 'abc123',
      });
      await backend.addNode({
        id: 'test::func',
        type: 'FUNCTION',
        name: 'main',
        file: 'test.js',
        async: false,
        generator: false,
        exported: false,
        arrowFunction: false,
      });
      await backend.addEdge({ src: 'test::module', dst: 'test::func', type: 'CONTAINS' });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'module-has-children')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 0, 'MODULE with CONTAINS should not violate');
    });
  });

  // =====================================================
  // Tier 1: Namespaced types containment
  // =====================================================

  describe('Namespaced types containment', () => {
    const namespacedTests = [
      { guarantee: 'http-nodes-orphan', type: 'http:route', fields: { method: 'GET', path: '/api/users' } },
      { guarantee: 'express-nodes-orphan', type: 'express:middleware', fields: {} },
      { guarantee: 'socketio-nodes-orphan', type: 'socketio:emit', fields: {} },
      { guarantee: 'db-nodes-orphan', type: 'db:query', fields: { query: 'SELECT 1', operation: 'SELECT' } },
      { guarantee: 'redis-nodes-orphan', type: 'redis:read', fields: { method: 'get', operation: 'read', package: 'ioredis' } },
      { guarantee: 'fs-nodes-orphan', type: 'fs:read', fields: {} },
      { guarantee: 'net-nodes-orphan', type: 'net:request', fields: {} },
      { guarantee: 'event-nodes-orphan', type: 'event:listener', fields: { eventName: 'click', objectName: 'button' } },
    ];

    for (const { guarantee, type, fields } of namespacedTests) {
      const rule = datalogGuarantees.find((g: { name: string }) => g.name === guarantee)?.rule;
      if (!rule) continue;

      it(`${guarantee}: detects orphaned ${type}`, async () => {
        await backend.addNode({
          id: `test::orphaned-${type.replace(':', '-')}`,
          type,
          name: `orphaned_${type}`,
          file: 'test.js',
          ...fields,
        });

        const violations = await backend.checkGuarantee(rule);
        assert.ok(violations.length >= 1, `Should detect orphaned ${type}`);
      });

      it(`${guarantee}: passes when ${type} is contained`, async () => {
        const moduleId = 'test::module-ns';
        const nodeId = `test::contained-${type.replace(':', '-')}`;

        await backend.addNode({
          id: moduleId,
          type: 'MODULE',
          name: 'test.js',
          file: 'test.js',
          relativePath: 'test.js',
          contentHash: 'abc123',
        });
        await backend.addNode({
          id: nodeId,
          type,
          name: `contained_${type}`,
          file: 'test.js',
          ...fields,
        });
        await backend.addEdge({ src: moduleId, dst: nodeId, type: 'CONTAINS' });

        const violations = await backend.checkGuarantee(rule);
        assert.strictEqual(violations.length, 0, `${type} with CONTAINS should not violate`);
      });
    }
  });

  // =====================================================
  // Tier 2: Semantic integrity
  // =====================================================

  describe('Semantic integrity', () => {
    it('import-has-source: detects IMPORT without IMPORTS_FROM', async () => {
      await backend.addNode({
        id: 'test::module',
        type: 'MODULE',
        name: 'test.js',
        file: 'test.js',
        relativePath: 'test.js',
        contentHash: 'abc',
      });
      await backend.addNode({
        id: 'test::import',
        type: 'IMPORT',
        name: 'foo',
        file: 'test.js',
        source: './foo',
        specifiers: [],
      });
      await backend.addEdge({ src: 'test::module', dst: 'test::import', type: 'CONTAINS' });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'import-has-source')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 1, 'IMPORT without IMPORTS_FROM should violate');
    });

    it('import-has-source: passes with IMPORTS_FROM', async () => {
      await backend.addNode({
        id: 'test::module',
        type: 'MODULE',
        name: 'test.js',
        file: 'test.js',
        relativePath: 'test.js',
        contentHash: 'abc',
      });
      await backend.addNode({
        id: 'test::foo-module',
        type: 'MODULE',
        name: 'foo.js',
        file: 'foo.js',
        relativePath: 'foo.js',
        contentHash: 'def',
      });
      await backend.addNode({
        id: 'test::import',
        type: 'IMPORT',
        name: 'foo',
        file: 'test.js',
        source: './foo',
        specifiers: [],
      });
      await backend.addEdge({ src: 'test::module', dst: 'test::import', type: 'CONTAINS' });
      await backend.addEdge({ src: 'test::import', dst: 'test::foo-module', type: 'IMPORTS_FROM' });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'import-has-source')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 0);
    });

    it('export-has-target: detects EXPORT without EXPORTS', async () => {
      await backend.addNode({
        id: 'test::module',
        type: 'MODULE',
        name: 'test.js',
        file: 'test.js',
        relativePath: 'test.js',
        contentHash: 'abc',
      });
      await backend.addNode({
        id: 'test::export',
        type: 'EXPORT',
        name: 'foo',
        file: 'test.js',
        exportedName: 'foo',
      });
      await backend.addEdge({ src: 'test::module', dst: 'test::export', type: 'CONTAINS' });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'export-has-target')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 1, 'EXPORT without EXPORTS should violate');
    });

    it('loop-has-body: detects LOOP without HAS_BODY', async () => {
      await backend.addNode({
        id: 'test::module',
        type: 'MODULE',
        name: 'test.js',
        file: 'test.js',
        relativePath: 'test.js',
        contentHash: 'abc',
      });
      await backend.addNode({
        id: 'test::loop',
        type: 'LOOP',
        name: 'for',
        file: 'test.js',
        loopType: 'for',
      });
      await backend.addEdge({ src: 'test::module', dst: 'test::loop', type: 'CONTAINS' });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'loop-has-body')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 1, 'LOOP without HAS_BODY should violate');
    });

    it('try-has-handler: detects TRY without catch or finally', async () => {
      await backend.addNode({
        id: 'test::module',
        type: 'MODULE',
        name: 'test.js',
        file: 'test.js',
        relativePath: 'test.js',
        contentHash: 'abc',
      });
      await backend.addNode({
        id: 'test::try',
        type: 'TRY_BLOCK',
        name: 'try',
        file: 'test.js',
      });
      await backend.addEdge({ src: 'test::module', dst: 'test::try', type: 'CONTAINS' });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'try-has-handler')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 1, 'TRY without handler should violate');
    });

    it('try-has-handler: passes with HAS_CATCH', async () => {
      await backend.addNode({
        id: 'test::module',
        type: 'MODULE',
        name: 'test.js',
        file: 'test.js',
        relativePath: 'test.js',
        contentHash: 'abc',
      });
      await backend.addNode({
        id: 'test::try',
        type: 'TRY_BLOCK',
        name: 'try',
        file: 'test.js',
      });
      await backend.addNode({
        id: 'test::catch',
        type: 'CATCH_BLOCK',
        name: 'catch',
        file: 'test.js',
      });
      await backend.addEdge({ src: 'test::module', dst: 'test::try', type: 'CONTAINS' });
      await backend.addEdge({ src: 'test::try', dst: 'test::catch', type: 'HAS_CATCH' });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'try-has-handler')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 0, 'TRY with HAS_CATCH should not violate');
    });

    it('switch-has-cases: detects empty switch', async () => {
      await backend.addNode({
        id: 'test::module',
        type: 'MODULE',
        name: 'test.js',
        file: 'test.js',
        relativePath: 'test.js',
        contentHash: 'abc',
      });
      await backend.addNode({
        id: 'test::switch',
        type: 'BRANCH',
        name: 'switch',
        file: 'test.js',
        branchType: 'switch',
      });
      await backend.addEdge({ src: 'test::module', dst: 'test::switch', type: 'CONTAINS' });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'switch-has-cases')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 1, 'switch without HAS_CASE should violate');
    });

    it('if-has-consequent: detects if without then', async () => {
      await backend.addNode({
        id: 'test::module',
        type: 'MODULE',
        name: 'test.js',
        file: 'test.js',
        relativePath: 'test.js',
        contentHash: 'abc',
      });
      await backend.addNode({
        id: 'test::if',
        type: 'BRANCH',
        name: 'if',
        file: 'test.js',
        branchType: 'if',
      });
      await backend.addEdge({ src: 'test::module', dst: 'test::if', type: 'CONTAINS' });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'if-has-consequent')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 1, 'if without HAS_CONSEQUENT should violate');
    });

    it('route-has-handler: detects route without handler', async () => {
      await backend.addNode({
        id: 'test::module',
        type: 'MODULE',
        name: 'test.js',
        file: 'test.js',
        relativePath: 'test.js',
        contentHash: 'abc',
      });
      await backend.addNode({
        id: 'test::route',
        type: 'http:route',
        name: 'GET /api/users',
        file: 'test.js',
        method: 'GET',
        path: '/api/users',
      });
      await backend.addEdge({ src: 'test::module', dst: 'test::route', type: 'CONTAINS' });

      const rule = datalogGuarantees.find((g: { name: string }) => g.name === 'route-has-handler')?.rule;
      const violations = await backend.checkGuarantee(rule);
      assert.strictEqual(violations.length, 1, 'route without handler should violate');
    });
  });
});
