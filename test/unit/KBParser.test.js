/**
 * KBParser Tests (REG-626)
 *
 * Tests the Knowledge Base parser:
 * - parseFrontmatter: splits markdown into YAML frontmatter and body
 * - parseKBNode: validates and constructs typed KB nodes
 * - serializeKBNode: writes nodes back to markdown format
 * - parseEdgesFile: parses edges.yaml
 * - appendEdge: appends edges to edges.yaml
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let testDir;
let testCounter = 0;

function createTestDir() {
  const dir = join(tmpdir(), `grafema-kb-parser-${Date.now()}-${testCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const { parseFrontmatter, parseKBNode, serializeKBNode, parseEdgesFile, appendEdge } = await import('@grafema/util');

describe('KBParser (REG-626)', () => {
  before(() => {
    testDir = createTestDir();
  });

  after(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // --- parseFrontmatter ---

  describe('parseFrontmatter', () => {
    it('should parse valid frontmatter and body', () => {
      const content = `---
id: kb:decision:test
type: DECISION
status: active
---

This is the body.
`;
      const result = parseFrontmatter(content);
      assert.strictEqual(result.frontmatter.id, 'kb:decision:test');
      assert.strictEqual(result.frontmatter.type, 'DECISION');
      assert.strictEqual(result.frontmatter.status, 'active');
      assert.ok(result.body.includes('This is the body.'));
    });

    it('should parse frontmatter with empty body', () => {
      const content = `---
id: kb:fact:empty
type: FACT
---
`;
      const result = parseFrontmatter(content);
      assert.strictEqual(result.frontmatter.id, 'kb:fact:empty');
      assert.strictEqual(result.body.trim(), '');
    });

    it('should throw on missing --- delimiters', () => {
      assert.throws(() => parseFrontmatter('no frontmatter here'), /Missing frontmatter/);
    });

    it('should throw on missing closing ---', () => {
      assert.throws(() => parseFrontmatter('---\nid: test\nbody text'), /Missing frontmatter.*closing/);
    });
  });

  // --- parseKBNode ---

  describe('parseKBNode', () => {
    it('should parse a decision with all fields', () => {
      const fm = {
        id: 'kb:decision:test-decision',
        type: 'DECISION',
        status: 'active',
        projections: ['epistemic'],
        source: 'kb:session:test',
        created: '2026-03-06',
        applies_to: ['packages/cli:CLI:MODULE'],
        relates_to: ['kb:fact:some-fact'],
      };
      const node = parseKBNode(fm, 'Decision body text.', '/path/to/declared/decisions/test.md');
      assert.strictEqual(node.id, 'kb:decision:test-decision');
      assert.strictEqual(node.type, 'DECISION');
      assert.strictEqual(node.status, 'active');
      assert.deepStrictEqual(node.applies_to, ['packages/cli:CLI:MODULE']);
      assert.strictEqual(node.lifecycle, 'declared');
      assert.strictEqual(node.content, 'Decision body text.');
    });

    it('should parse a fact with minimal fields', () => {
      const fm = {
        id: 'kb:fact:minimal',
        type: 'FACT',
        created: '2026-01-01',
      };
      const node = parseKBNode(fm, '', '/path/to/declared/facts/minimal.md');
      assert.strictEqual(node.id, 'kb:fact:minimal');
      assert.strictEqual(node.type, 'FACT');
      assert.deepStrictEqual(node.projections, []);
    });

    it('should parse a session with produced list', () => {
      const fm = {
        id: 'kb:session:2026-03-06-design',
        type: 'SESSION',
        projections: ['epistemic'],
        task_id: 'REG-626',
        produced: ['kb:decision:one', 'kb:fact:two'],
        created: '2026-03-06',
      };
      const node = parseKBNode(fm, 'Session notes.', '/path/to/declared/sessions/test.md');
      assert.strictEqual(node.type, 'SESSION');
      assert.strictEqual(node.task_id, 'REG-626');
      assert.deepStrictEqual(node.produced, ['kb:decision:one', 'kb:fact:two']);
    });

    it('should derive lifecycle from path', () => {
      const fm = { id: 'kb:commit:abc123', type: 'COMMIT', created: '2026-01-01' };
      const derived = parseKBNode(fm, '', '/project/knowledge/derived/commits/abc.md');
      assert.strictEqual(derived.lifecycle, 'derived');

      const synced = parseKBNode(fm, '', '/project/knowledge/synced/tickets/reg.md');
      assert.strictEqual(synced.lifecycle, 'synced');

      const declared = parseKBNode(fm, '', '/project/knowledge/declared/facts/test.md');
      assert.strictEqual(declared.lifecycle, 'declared');
    });

    it('should throw on missing id', () => {
      assert.throws(
        () => parseKBNode({ type: 'FACT', created: '2026-01-01' }, '', '/test.md'),
        /Missing required field "id"/,
      );
    });

    it('should throw on invalid id format', () => {
      assert.throws(
        () => parseKBNode({ id: 'not-valid', type: 'FACT', created: '2026-01-01' }, '', '/test.md'),
        /Invalid ID format/,
      );
    });

    it('should throw on invalid type', () => {
      assert.throws(
        () => parseKBNode({ id: 'kb:fact:test', type: 'INVALID', created: '2026-01-01' }, '', '/test.md'),
        /Invalid or missing type/,
      );
    });
  });

  // --- serializeKBNode + roundtrip ---

  describe('serializeKBNode', () => {
    it('should serialize and parse back a decision (roundtrip)', () => {
      const fm = {
        id: 'kb:decision:roundtrip',
        type: 'DECISION',
        status: 'active',
        projections: ['epistemic'],
        source: 'kb:session:test',
        created: '2026-03-06',
        applies_to: ['packages/cli:CLI:MODULE'],
      };
      const original = parseKBNode(fm, 'Roundtrip body.', '/test/declared/decisions/rt.md');
      const serialized = serializeKBNode(original);
      const { frontmatter, body } = parseFrontmatter(serialized);
      const restored = parseKBNode(frontmatter, body, '/test/declared/decisions/rt.md');

      assert.strictEqual(restored.id, original.id);
      assert.strictEqual(restored.type, original.type);
      assert.strictEqual(restored.status, original.status);
      assert.strictEqual(restored.content, original.content);
      assert.deepStrictEqual(restored.applies_to, original.applies_to);
    });

    it('should serialize a fact with confidence', () => {
      const fm = {
        id: 'kb:fact:with-confidence',
        type: 'FACT',
        confidence: 'high',
        projections: ['epistemic'],
        created: '2026-03-06',
      };
      const node = parseKBNode(fm, 'Fact content.', '/test/declared/facts/conf.md');
      const serialized = serializeKBNode(node);
      assert.ok(serialized.includes('confidence: high'));
      assert.ok(serialized.startsWith('---\n'));
      assert.ok(serialized.includes('\n---\n'));
    });
  });

  // --- parseEdgesFile ---

  describe('parseEdgesFile', () => {
    it('should parse valid edges.yaml', () => {
      const edgesPath = join(testDir, 'edges.yaml');
      const content = `- type: PRODUCED
  from: kb:session:test
  to: kb:decision:test

- type: IMPLEMENTS
  from: kb:ticket:REG-626
  to: kb:decision:test
  evidence: "ticket implements decision"
`;
      writeFileSync(edgesPath, content, 'utf-8');
      const edges = parseEdgesFile(edgesPath);
      assert.strictEqual(edges.length, 2);
      assert.strictEqual(edges[0].type, 'PRODUCED');
      assert.strictEqual(edges[0].from, 'kb:session:test');
      assert.strictEqual(edges[1].evidence, 'ticket implements decision');
    });

    it('should return empty for nonexistent file', () => {
      const edges = parseEdgesFile(join(testDir, 'nonexistent.yaml'));
      assert.deepStrictEqual(edges, []);
    });
  });

  // --- appendEdge ---

  describe('appendEdge', () => {
    it('should create file and append edge', () => {
      const edgesPath = join(testDir, 'append-test', 'edges.yaml');
      appendEdge(edgesPath, { type: 'PRODUCED', from: 'kb:session:s1', to: 'kb:decision:d1' });

      const content = readFileSync(edgesPath, 'utf-8');
      assert.ok(content.includes('PRODUCED'));
      assert.ok(content.includes('kb:session:s1'));

      // Parse back
      const edges = parseEdgesFile(edgesPath);
      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].type, 'PRODUCED');
    });

    it('should append to existing file', () => {
      const edgesPath = join(testDir, 'append-existing', 'edges.yaml');
      appendEdge(edgesPath, { type: 'PRODUCED', from: 'kb:session:s1', to: 'kb:decision:d1' });
      appendEdge(edgesPath, { type: 'IMPLEMENTS', from: 'kb:ticket:t1', to: 'kb:decision:d1', evidence: 'test' });

      const edges = parseEdgesFile(edgesPath);
      assert.strictEqual(edges.length, 2);
      assert.strictEqual(edges[1].type, 'IMPLEMENTS');
      assert.strictEqual(edges[1].evidence, 'test');
    });
  });
});
