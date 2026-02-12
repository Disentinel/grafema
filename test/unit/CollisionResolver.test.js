/**
 * CollisionResolver Tests
 *
 * Tests for graduated disambiguation of v2 semantic IDs.
 * CollisionResolver runs after all visitors complete for a file,
 * before GraphBuilder processes the data.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { CollisionResolver } from '@grafema/core';

/**
 * Helper: create a PendingNode with auto-incrementing insertion order.
 */
function makePending(baseId, contentHints = {}, insertionOrder = 0) {
  const collectionRef = { id: baseId };
  return { baseId, contentHints, collectionRef, insertionOrder };
}

describe('CollisionResolver', () => {
  describe('resolve()', () => {
    it('should not change unique base IDs', () => {
      const resolver = new CollisionResolver();
      const nodes = [
        makePending('app.js->FUNCTION->processData', {}, 0),
        makePending('app.js->FUNCTION->fetchData', {}, 1),
        makePending('app.js->CONSTANT->API_URL', {}, 2)
      ];

      resolver.resolve(nodes);

      assert.strictEqual(nodes[0].collectionRef.id, 'app.js->FUNCTION->processData');
      assert.strictEqual(nodes[1].collectionRef.id, 'app.js->FUNCTION->fetchData');
      assert.strictEqual(nodes[2].collectionRef.id, 'app.js->CONSTANT->API_URL');
    });

    it('should disambiguate two same-name calls with different args', () => {
      const resolver = new CollisionResolver();
      const nodes = [
        makePending('app.js->CALL->console.log[in:processData]',
          { arity: 1, firstLiteralArg: 'hello' }, 0),
        makePending('app.js->CALL->console.log[in:processData]',
          { arity: 1, firstLiteralArg: 'world' }, 1)
      ];

      resolver.resolve(nodes);

      // Both should have hashes, no counter (unique hashes)
      assert.ok(nodes[0].collectionRef.id.includes(',h:'), `Expected hash in: ${nodes[0].collectionRef.id}`);
      assert.ok(nodes[1].collectionRef.id.includes(',h:'), `Expected hash in: ${nodes[1].collectionRef.id}`);
      assert.notStrictEqual(nodes[0].collectionRef.id, nodes[1].collectionRef.id);
      // No counter
      assert.ok(!nodes[0].collectionRef.id.includes('#'));
      assert.ok(!nodes[1].collectionRef.id.includes('#'));
    });

    it('should use counter for identical content (same hash)', () => {
      const resolver = new CollisionResolver();
      const nodes = [
        makePending('app.js->CALL->doWork[in:retry]',
          { arity: 0 }, 0),
        makePending('app.js->CALL->doWork[in:retry]',
          { arity: 0 }, 1),
        makePending('app.js->CALL->doWork[in:retry]',
          { arity: 0 }, 2)
      ];

      resolver.resolve(nodes);

      // All should have same hash, differentiated by counter
      const ids = nodes.map(n => n.collectionRef.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, 3, `Expected 3 unique IDs, got: ${JSON.stringify(ids)}`);

      // First should NOT have counter (counter 0 is omitted)
      assert.ok(!ids[0].includes('#'), `First should not have counter: ${ids[0]}`);
      // Second should have #1
      assert.ok(ids[1].endsWith('#1'), `Second should end with #1: ${ids[1]}`);
      // Third should have #2
      assert.ok(ids[2].endsWith('#2'), `Third should end with #2: ${ids[2]}`);
    });

    it('should handle three same-name calls, two identical', () => {
      const resolver = new CollisionResolver();
      const nodes = [
        makePending('app.js->CALL->console.log[in:main]',
          { arity: 1, firstLiteralArg: 'hello' }, 0),
        makePending('app.js->CALL->console.log[in:main]',
          { arity: 2, firstLiteralArg: 'world' }, 1),
        makePending('app.js->CALL->console.log[in:main]',
          { arity: 1, firstLiteralArg: 'hello' }, 2)  // Same as first
      ];

      resolver.resolve(nodes);

      const ids = nodes.map(n => n.collectionRef.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, 3, `Expected 3 unique IDs, got: ${JSON.stringify(ids)}`);

      // node1 has unique hash -> no counter
      assert.ok(!ids[1].includes('#'), `Unique hash node should not have counter: ${ids[1]}`);

      // node0 and node2 share hash -> counter differentiates
      // node0 is first (counter 0 omitted), node2 gets #1
      assert.ok(!ids[0].includes('#'), `First of pair should not have counter: ${ids[0]}`);
      assert.ok(ids[2].endsWith('#1'), `Second of pair should have #1: ${ids[2]}`);
    });

    it('should handle base ID without brackets', () => {
      const resolver = new CollisionResolver();
      const nodes = [
        makePending('app.js->CALL->init',
          { arity: 0 }, 0),
        makePending('app.js->CALL->init',
          { arity: 1, firstLiteralArg: 'config' }, 1)
      ];

      resolver.resolve(nodes);

      // Should add [h:xxxx] to bare base ID
      assert.ok(nodes[0].collectionRef.id.includes('[h:'));
      assert.ok(nodes[1].collectionRef.id.includes('[h:'));
      assert.notStrictEqual(nodes[0].collectionRef.id, nodes[1].collectionRef.id);
    });

    it('should handle base ID with brackets (has namedParent)', () => {
      const resolver = new CollisionResolver();
      const nodes = [
        makePending('app.js->CALL->log[in:handler]',
          { arity: 1, firstLiteralArg: 'start' }, 0),
        makePending('app.js->CALL->log[in:handler]',
          { arity: 1, firstLiteralArg: 'end' }, 1)
      ];

      resolver.resolve(nodes);

      // Should add ,h:xxxx before closing bracket
      assert.ok(nodes[0].collectionRef.id.includes('[in:handler,h:'));
      assert.ok(nodes[1].collectionRef.id.includes('[in:handler,h:'));
    });

    it('should preserve insertion order for counter assignment', () => {
      const resolver = new CollisionResolver();
      // Insertion order: 2, 0, 1 (scrambled)
      const nodes = [
        makePending('app.js->CALL->fn[in:main]', { arity: 0 }, 2),
        makePending('app.js->CALL->fn[in:main]', { arity: 0 }, 0),
        makePending('app.js->CALL->fn[in:main]', { arity: 0 }, 1)
      ];

      resolver.resolve(nodes);

      // Should be sorted by insertionOrder: node[1]=0, node[2]=1, node[0]=2
      const ids = nodes.map(n => n.collectionRef.id);
      // node[1] (order 0) -> no counter
      assert.ok(!ids[1].includes('#'), `Order 0 should have no counter: ${ids[1]}`);
      // node[2] (order 1) -> #1
      assert.ok(ids[2].endsWith('#1'), `Order 1 should have #1: ${ids[2]}`);
      // node[0] (order 2) -> #2
      assert.ok(ids[0].endsWith('#2'), `Order 2 should have #2: ${ids[0]}`);
    });

    it('should handle empty input', () => {
      const resolver = new CollisionResolver();
      // Should not throw
      resolver.resolve([]);
    });

    it('should handle single node', () => {
      const resolver = new CollisionResolver();
      const nodes = [makePending('app.js->FUNCTION->main', {}, 0)];

      resolver.resolve(nodes);

      assert.strictEqual(nodes[0].collectionRef.id, 'app.js->FUNCTION->main');
    });

    it('should handle mixed colliding and unique groups', () => {
      const resolver = new CollisionResolver();
      const nodes = [
        makePending('app.js->FUNCTION->processData', {}, 0),  // unique
        makePending('app.js->CALL->console.log[in:processData]',
          { arity: 1, firstLiteralArg: 'a' }, 1),  // collides with next
        makePending('app.js->CALL->console.log[in:processData]',
          { arity: 1, firstLiteralArg: 'b' }, 2),  // collides with prev
        makePending('app.js->CONSTANT->API_URL', {}, 3)  // unique
      ];

      resolver.resolve(nodes);

      // Unique nodes unchanged
      assert.strictEqual(nodes[0].collectionRef.id, 'app.js->FUNCTION->processData');
      assert.strictEqual(nodes[3].collectionRef.id, 'app.js->CONSTANT->API_URL');

      // Colliding nodes disambiguated
      assert.ok(nodes[1].collectionRef.id.includes(',h:'));
      assert.ok(nodes[2].collectionRef.id.includes(',h:'));
      assert.notStrictEqual(nodes[1].collectionRef.id, nodes[2].collectionRef.id);
    });

    it('should produce IDs that are parseable by parseSemanticIdV2', async () => {
      const { parseSemanticIdV2 } = await import('@grafema/core');
      const resolver = new CollisionResolver();
      const nodes = [
        makePending('app.js->CALL->console.log[in:main]',
          { arity: 1, firstLiteralArg: 'hello' }, 0),
        makePending('app.js->CALL->console.log[in:main]',
          { arity: 1, firstLiteralArg: 'world' }, 1),
        makePending('app.js->CALL->console.log[in:main]',
          { arity: 1, firstLiteralArg: 'hello' }, 2)
      ];

      resolver.resolve(nodes);

      for (const node of nodes) {
        const parsed = parseSemanticIdV2(node.collectionRef.id);
        assert.ok(parsed, `Failed to parse resolved ID: ${node.collectionRef.id}`);
        assert.strictEqual(parsed.name, 'console.log');
        assert.strictEqual(parsed.namedParent, 'main');
        assert.ok(parsed.contentHash, `Should have content hash: ${node.collectionRef.id}`);
      }
    });
  });
});
