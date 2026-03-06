/**
 * KnowledgeBase Tests (REG-626)
 *
 * Tests the KnowledgeBase class:
 * - load: scanning, parsing, collision detection, empty/missing dirs
 * - getNode: exact lookup
 * - queryNodes: filtering by type, projection, text, status, combined
 * - activeDecisionsFor: module matching
 * - addNode: file creation, index update, collision, auto-slug, relates_to edges
 * - supersedeFact: versioning, type check, existence check
 * - getEdges: all and filtered
 * - getStats: correct counts
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let testCounter = 0;

function createTestDir() {
  const dir = join(tmpdir(), `grafema-kb-${Date.now()}-${testCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeKBFile(dir, lifecycle, typeDir, filename, content) {
  const fullDir = join(dir, lifecycle, typeDir);
  mkdirSync(fullDir, { recursive: true });
  const filePath = join(fullDir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

const { KnowledgeBase } = await import('@grafema/util');

describe('KnowledgeBase (REG-626)', () => {

  // --- load() ---

  describe('load()', () => {
    it('should scan fixture directory and parse all files', async () => {
      const dir = createTestDir();
      try {
        writeKBFile(dir, 'declared', 'decisions', 'test-decision.md',
`---
id: kb:decision:test-decision
type: DECISION
status: active
projections: [epistemic]
created: 2026-03-06
applies_to:
  - "packages/cli:CLI:MODULE"
---

Test decision content.
`);
        writeKBFile(dir, 'declared', 'facts', 'test-fact.md',
`---
id: kb:fact:test-fact
type: FACT
confidence: high
projections: [epistemic]
created: 2026-03-06
---

Test fact content.
`);

        const kb = new KnowledgeBase(dir);
        await kb.load();

        assert.strictEqual(kb.getNode('kb:decision:test-decision')?.type, 'DECISION');
        assert.strictEqual(kb.getNode('kb:fact:test-fact')?.type, 'FACT');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should throw on ID collision', async () => {
      const dir = createTestDir();
      try {
        writeKBFile(dir, 'declared', 'decisions', 'one.md',
`---
id: kb:decision:same-id
type: DECISION
status: active
created: 2026-03-06
---

First.
`);
        writeKBFile(dir, 'declared', 'decisions', 'two.md',
`---
id: kb:decision:same-id
type: DECISION
status: active
created: 2026-03-06
---

Second.
`);

        const kb = new KnowledgeBase(dir);
        await assert.rejects(() => kb.load(), /ID collision/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should succeed with empty directory', async () => {
      const dir = createTestDir();
      try {
        const kb = new KnowledgeBase(dir);
        await kb.load();
        assert.strictEqual((await kb.getStats()).totalNodes, 0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should succeed with missing directory', async () => {
      const dir = join(tmpdir(), `grafema-kb-nonexistent-${Date.now()}`);
      const kb = new KnowledgeBase(dir);
      await kb.load();
      assert.strictEqual((await kb.getStats()).totalNodes, 0);
    });
  });

  // --- getNode() ---

  describe('getNode()', () => {
    it('should return node by ID and undefined for missing', async () => {
      const dir = createTestDir();
      try {
        writeKBFile(dir, 'declared', 'facts', 'lookup.md',
`---
id: kb:fact:lookup-test
type: FACT
created: 2026-03-06
---

Lookup content.
`);
        const kb = new KnowledgeBase(dir);
        await kb.load();

        assert.strictEqual(kb.getNode('kb:fact:lookup-test')?.id, 'kb:fact:lookup-test');
        assert.strictEqual(kb.getNode('kb:fact:nonexistent'), undefined);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // --- queryNodes() ---

  describe('queryNodes()', () => {
    let dir;
    let kb;

    before(async () => {
      dir = createTestDir();
      writeKBFile(dir, 'declared', 'decisions', 'd1.md',
`---
id: kb:decision:query-d1
type: DECISION
status: active
projections: [epistemic]
created: 2026-03-06
---

Active decision about auth.
`);
      writeKBFile(dir, 'declared', 'decisions', 'd2.md',
`---
id: kb:decision:query-d2
type: DECISION
status: superseded
projections: [temporal]
created: 2026-03-06
---

Superseded decision.
`);
      writeKBFile(dir, 'declared', 'facts', 'f1.md',
`---
id: kb:fact:query-f1
type: FACT
projections: [epistemic]
created: 2026-03-06
relates_to:
  - "kb:decision:query-d1"
---

Fact about auth and security.
`);
      kb = new KnowledgeBase(dir);
      await kb.load();
    });

    after(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('should filter by type', async () => {
      const decisions = await kb.queryNodes({ type: 'DECISION' });
      assert.strictEqual(decisions.length, 2);

      const facts = await kb.queryNodes({ type: 'FACT' });
      assert.strictEqual(facts.length, 1);
    });

    it('should filter by projection', async () => {
      const epistemic = await kb.queryNodes({ projection: 'epistemic' });
      assert.strictEqual(epistemic.length, 2); // d1 + f1

      const temporal = await kb.queryNodes({ projection: 'temporal' });
      assert.strictEqual(temporal.length, 1); // d2
    });

    it('should filter by text (case-insensitive)', async () => {
      const auth = await kb.queryNodes({ text: 'AUTH' });
      assert.strictEqual(auth.length, 2); // d1 + f1
    });

    it('should filter by status', async () => {
      const active = await kb.queryNodes({ status: 'active' });
      assert.strictEqual(active.length, 1);
      assert.strictEqual(active[0].id, 'kb:decision:query-d1');
    });

    it('should combine filters', async () => {
      const result = await kb.queryNodes({ type: 'DECISION', status: 'active', text: 'auth' });
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'kb:decision:query-d1');
    });

    it('should filter by relates_to', async () => {
      const related = await kb.queryNodes({ relates_to: 'kb:decision:query-d1' });
      assert.strictEqual(related.length, 1);
      assert.strictEqual(related[0].id, 'kb:fact:query-f1');
    });
  });

  // --- activeDecisionsFor() ---

  describe('activeDecisionsFor()', () => {
    it('should match module address', async () => {
      const dir = createTestDir();
      try {
        writeKBFile(dir, 'declared', 'decisions', 'cli.md',
`---
id: kb:decision:cli-specific
type: DECISION
status: active
projections: [epistemic]
created: 2026-03-06
applies_to:
  - "packages/cli:CLI:MODULE"
---

CLI-specific decision.
`);
        const kb = new KnowledgeBase(dir);
        await kb.load();

        const cliDecisions = await kb.activeDecisionsFor('packages/cli:CLI:MODULE');
        assert.strictEqual(cliDecisions.length, 1);

        const noMatch = await kb.activeDecisionsFor('nonexistent');
        assert.strictEqual(noMatch.length, 0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // --- addNode() ---

  describe('addNode()', () => {
    it('should create file and appear in index', async () => {
      const dir = createTestDir();
      try {
        const kb = new KnowledgeBase(dir);
        await kb.load();

        const node = await kb.addNode({
          type: 'FACT',
          content: 'New fact about testing.',
          slug: 'testing-fact',
          projections: ['epistemic'],
          confidence: 'high',
        });

        assert.strictEqual(node.id, 'kb:fact:testing-fact');
        assert.strictEqual(node.type, 'FACT');
        assert.strictEqual(kb.getNode('kb:fact:testing-fact')?.content, 'New fact about testing.');

        // File should exist on disk
        assert.ok(existsSync(node.filePath));
        const content = readFileSync(node.filePath, 'utf-8');
        assert.ok(content.includes('testing-fact'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should throw on slug collision', async () => {
      const dir = createTestDir();
      try {
        const kb = new KnowledgeBase(dir);
        await kb.load();

        await kb.addNode({ type: 'FACT', content: 'First', slug: 'collision' });
        await assert.rejects(
          () => kb.addNode({ type: 'FACT', content: 'Second', slug: 'collision' }),
          /Slug collision/
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should auto-generate slug from content', async () => {
      const dir = createTestDir();
      try {
        const kb = new KnowledgeBase(dir);
        await kb.load();

        const node = await kb.addNode({
          type: 'FACT',
          content: 'Auth uses bcrypt for password hashing',
        });

        assert.ok(node.id.startsWith('kb:fact:'));
        assert.ok(node.id.includes('auth'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should create edges for relates_to', async () => {
      const dir = createTestDir();
      try {
        const kb = new KnowledgeBase(dir);
        await kb.load();

        await kb.addNode({
          type: 'FACT',
          content: 'Related fact',
          slug: 'related-fact',
          relates_to: ['kb:decision:some-decision'],
        });

        const edges = kb.getEdges('kb:fact:related-fact');
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].type, 'RELATES_TO');
        assert.strictEqual(edges[0].to, 'kb:decision:some-decision');

        // Edge should be persisted in edges.yaml
        const edgesPath = join(dir, 'edges.yaml');
        assert.ok(existsSync(edgesPath));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // --- supersedeFact() ---

  describe('supersedeFact()', () => {
    it('should create new and update old', async () => {
      const dir = createTestDir();
      try {
        const kb = new KnowledgeBase(dir);
        await kb.load();

        await kb.addNode({
          type: 'FACT',
          content: 'Old fact about auth.',
          slug: 'old-auth-fact',
          confidence: 'high',
        });

        const { old: oldFact, new: newFact } = await kb.supersedeFact(
          'kb:fact:old-auth-fact',
          'Updated fact about auth with argon2.',
          'new-auth-fact',
        );

        assert.strictEqual(oldFact.superseded_by, 'kb:fact:new-auth-fact');
        assert.strictEqual(newFact.id, 'kb:fact:new-auth-fact');
        assert.strictEqual(newFact.content, 'Updated fact about auth with argon2.');

        // Old file should be updated on disk
        const oldContent = readFileSync(oldFact.filePath, 'utf-8');
        assert.ok(oldContent.includes('superseded_by'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should throw if not a FACT', async () => {
      const dir = createTestDir();
      try {
        const kb = new KnowledgeBase(dir);
        await kb.load();

        await kb.addNode({ type: 'DECISION', content: 'A decision', slug: 'not-a-fact', status: 'active' });
        await assert.rejects(
          () => kb.supersedeFact('kb:decision:not-a-fact', 'new content'),
          /not FACT/
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should throw if fact does not exist', async () => {
      const dir = createTestDir();
      try {
        const kb = new KnowledgeBase(dir);
        await kb.load();

        await assert.rejects(
          () => kb.supersedeFact('kb:fact:nonexistent', 'new content'),
          /not found/
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // --- getEdges() ---

  describe('getEdges()', () => {
    it('should return all and filtered edges', async () => {
      const dir = createTestDir();
      try {
        // Create edges.yaml manually
        const edgesContent =
`- type: PRODUCED
  from: kb:session:s1
  to: kb:decision:d1

- type: IMPLEMENTS
  from: kb:ticket:t1
  to: kb:decision:d1
`;
        writeFileSync(join(dir, 'edges.yaml'), edgesContent, 'utf-8');

        const kb = new KnowledgeBase(dir);
        await kb.load();

        const all = kb.getEdges();
        assert.strictEqual(all.length, 2);

        const d1Edges = kb.getEdges('kb:decision:d1');
        assert.strictEqual(d1Edges.length, 2);

        const s1Edges = kb.getEdges('kb:session:s1');
        assert.strictEqual(s1Edges.length, 1);

        const noEdges = kb.getEdges('kb:fact:nonexistent');
        assert.strictEqual(noEdges.length, 0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // --- getStats() ---

  describe('getStats()', () => {
    it('should return correct counts', async () => {
      const dir = createTestDir();
      try {
        writeKBFile(dir, 'declared', 'decisions', 'sd1.md',
`---
id: kb:decision:stats-d1
type: DECISION
status: active
created: 2026-03-06
---

Decision.
`);
        writeKBFile(dir, 'declared', 'facts', 'sf1.md',
`---
id: kb:fact:stats-f1
type: FACT
created: 2026-03-06
---

Fact.
`);
        writeKBFile(dir, 'derived', 'commits', 'sc1.md',
`---
id: kb:commit:abc123
type: COMMIT
created: 2026-03-06
---

Commit.
`);

        const edgesContent =
`- type: PRODUCED
  from: kb:session:nonexistent
  to: kb:decision:stats-d1
`;
        writeFileSync(join(dir, 'edges.yaml'), edgesContent, 'utf-8');

        const kb = new KnowledgeBase(dir);
        await kb.load();

        const stats = await kb.getStats();
        assert.strictEqual(stats.totalNodes, 3);
        assert.strictEqual(stats.byType.DECISION, 1);
        assert.strictEqual(stats.byType.FACT, 1);
        assert.strictEqual(stats.byType.COMMIT, 1);
        assert.strictEqual(stats.byLifecycle.declared, 2);
        assert.strictEqual(stats.byLifecycle.derived, 1);
        assert.strictEqual(stats.totalEdges, 1);
        assert.strictEqual(stats.edgesByType.PRODUCED, 1);
        // kb:session:nonexistent is a dangling ref
        assert.ok(stats.danglingRefs.includes('kb:session:nonexistent'));
        // No resolver set, so danglingCodeRefs should be empty
        assert.deepStrictEqual(stats.danglingCodeRefs, []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // --- Resolver integration (REG-627) ---

  describe('SemanticAddressResolver integration (REG-627)', () => {
    function createMockBackend(nodes = []) {
      let callCount = 0;
      return {
        getCallCount() { return callCount; },
        async getAllNodes(filter) {
          callCount++;
          return nodes.filter(n => {
            if (filter?.file && n.file !== filter.file) return false;
            if (filter?.name && n.name !== filter.name) return false;
            if (filter?.nodeType && n.nodeType !== filter.nodeType) return false;
            return true;
          });
        },
      };
    }

    it('should resolve code addresses in relates_to', async () => {
      const dir = createTestDir();
      try {
        writeKBFile(dir, 'declared', 'facts', 'resolver-test.md',
`---
id: kb:fact:resolver-test
type: FACT
relates_to:
  - "src/auth.js:hashPassword:FUNCTION"
  - "kb:decision:some-decision"
created: 2026-03-06
---

Fact with code reference.
`);
        const kb = new KnowledgeBase(dir);
        await kb.load();

        const backend = createMockBackend([
          { id: 'node-1', file: 'src/auth.js', name: 'hashPassword', nodeType: 'FUNCTION' },
        ]);
        kb.setBackend(backend);

        const fact = kb.getNode('kb:fact:resolver-test');
        const resolved = await kb.resolveReferences(fact);
        assert.strictEqual(resolved.length, 1); // only code addr, not kb:
        assert.strictEqual(resolved[0].status, 'resolved');
        assert.strictEqual(resolved[0].codeNodeId, 'node-1');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should resolve applies_to on decisions', async () => {
      const dir = createTestDir();
      try {
        writeKBFile(dir, 'declared', 'decisions', 'resolver-decision.md',
`---
id: kb:decision:resolver-decision
type: DECISION
status: active
applies_to:
  - "src/auth.js:AuthService:CLASS"
created: 2026-03-06
---

Decision with applies_to code reference.
`);
        const kb = new KnowledgeBase(dir);
        await kb.load();

        const backend = createMockBackend([
          { id: 'class-1', file: 'src/auth.js', name: 'AuthService', nodeType: 'CLASS' },
        ]);
        kb.setBackend(backend);

        const decision = kb.getNode('kb:decision:resolver-decision');
        const resolved = await kb.resolveReferences(decision);
        assert.strictEqual(resolved.length, 1);
        assert.strictEqual(resolved[0].status, 'resolved');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should return dangling refs for missing code', async () => {
      const dir = createTestDir();
      try {
        writeKBFile(dir, 'declared', 'facts', 'orphan.md',
`---
id: kb:fact:orphan
type: FACT
relates_to:
  - "src/deleted.js:gone:FUNCTION"
created: 2026-03-06
---

References deleted code.
`);
        const kb = new KnowledgeBase(dir);
        await kb.load();

        const backend = createMockBackend([]); // empty graph
        kb.setBackend(backend);

        const dangling = await kb.getDanglingCodeRefs();
        assert.strictEqual(dangling.length, 1);
        assert.strictEqual(dangling[0].nodeId, 'kb:fact:orphan');
        assert.strictEqual(dangling[0].address, 'src/deleted.js:gone:FUNCTION');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should invalidate cache and re-resolve', async () => {
      const dir = createTestDir();
      try {
        writeKBFile(dir, 'declared', 'facts', 'cache-test.md',
`---
id: kb:fact:cache-test
type: FACT
relates_to:
  - "src/auth.js:hashPassword:FUNCTION"
created: 2026-03-06
---

Cache test.
`);
        const kb = new KnowledgeBase(dir);
        await kb.load();

        const backend = createMockBackend([
          { id: 'node-1', file: 'src/auth.js', name: 'hashPassword', nodeType: 'FUNCTION' },
        ]);
        kb.setBackend(backend);

        const fact = kb.getNode('kb:fact:cache-test');

        await kb.resolveReferences(fact);
        assert.strictEqual(backend.getCallCount(), 1);

        // Cached — no new query
        await kb.resolveReferences(fact);
        assert.strictEqual(backend.getCallCount(), 1);

        // Invalidate
        kb.invalidateResolutionCache();
        await kb.resolveReferences(fact);
        assert.strictEqual(backend.getCallCount(), 2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should include danglingCodeRefs in getStats', async () => {
      const dir = createTestDir();
      try {
        writeKBFile(dir, 'declared', 'facts', 'stats-orphan.md',
`---
id: kb:fact:stats-orphan
type: FACT
relates_to:
  - "src/gone.js:missing:FUNCTION"
created: 2026-03-06
---

Orphan for stats.
`);
        const kb = new KnowledgeBase(dir);
        await kb.load();

        const backend = createMockBackend([]); // nothing resolves
        kb.setBackend(backend);

        const stats = await kb.getStats();
        assert.ok(stats.danglingCodeRefs.length >= 1);
        assert.ok(stats.danglingCodeRefs.some(r => r.address === 'src/gone.js:missing:FUNCTION'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should filter by include_dangling_only in queryNodes', async () => {
      const dir = createTestDir();
      try {
        writeKBFile(dir, 'declared', 'facts', 'ok-fact.md',
`---
id: kb:fact:ok-fact
type: FACT
relates_to:
  - "src/auth.js:hashPassword:FUNCTION"
created: 2026-03-06
---

Resolvable fact.
`);
        writeKBFile(dir, 'declared', 'facts', 'bad-fact.md',
`---
id: kb:fact:bad-fact
type: FACT
relates_to:
  - "src/gone.js:deleted:FUNCTION"
created: 2026-03-06
---

Dangling fact.
`);
        const kb = new KnowledgeBase(dir);
        await kb.load();

        const backend = createMockBackend([
          { id: 'node-1', file: 'src/auth.js', name: 'hashPassword', nodeType: 'FUNCTION' },
        ]);
        kb.setBackend(backend);

        const danglingOnly = await kb.queryNodes({ include_dangling_only: true });
        assert.strictEqual(danglingOnly.length, 1);
        assert.strictEqual(danglingOnly[0].id, 'kb:fact:bad-fact');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should return empty for include_dangling_only without resolver', async () => {
      const dir = createTestDir();
      try {
        writeKBFile(dir, 'declared', 'facts', 'no-resolver.md',
`---
id: kb:fact:no-resolver
type: FACT
relates_to:
  - "src/auth.js:hashPassword:FUNCTION"
created: 2026-03-06
---

No resolver set.
`);
        const kb = new KnowledgeBase(dir);
        await kb.load();
        // No setBackend call

        const result = await kb.queryNodes({ include_dangling_only: true });
        assert.strictEqual(result.length, 0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
