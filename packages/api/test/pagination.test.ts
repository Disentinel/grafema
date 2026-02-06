/**
 * Pagination Utilities Tests
 *
 * Tests cursor-based pagination following Relay Connection spec.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  encodeCursor,
  decodeCursor,
  paginateArray,
  type Connection,
} from '../src/pagination.js';

describe('Pagination Utilities', () => {
  describe('encodeCursor / decodeCursor', () => {
    it('should encode and decode cursor correctly', () => {
      const id = 'node-123';
      const cursor = encodeCursor(id);

      // Cursor should be base64 encoded
      assert.ok(cursor.length > 0);
      assert.notStrictEqual(cursor, id);

      // Decode should return original ID
      const decoded = decodeCursor(cursor);
      assert.strictEqual(decoded, id);
    });

    it('should return null for invalid cursor', () => {
      assert.strictEqual(decodeCursor('invalid'), null);
      assert.strictEqual(decodeCursor(''), null);
    });

    it('should return null for cursor without prefix', () => {
      // Valid base64 but missing "cursor:" prefix
      const invalidCursor = Buffer.from('not-a-cursor').toString('base64');
      assert.strictEqual(decodeCursor(invalidCursor), null);
    });

    it('should handle special characters in ID', () => {
      const id = 'file.js:10->someFunction';
      const cursor = encodeCursor(id);
      const decoded = decodeCursor(cursor);
      assert.strictEqual(decoded, id);
    });
  });

  describe('paginateArray', () => {
    interface TestItem {
      id: string;
      name: string;
    }

    const getId = (item: TestItem) => item.id;

    const createItems = (count: number): TestItem[] =>
      Array.from({ length: count }, (_, i) => ({
        id: `item-${i + 1}`,
        name: `Item ${i + 1}`,
      }));

    it('should return all items when count is less than default limit', () => {
      const items = createItems(10);
      const result = paginateArray(items, null, null, getId);

      assert.strictEqual(result.edges.length, 10);
      assert.strictEqual(result.totalCount, 10);
      assert.strictEqual(result.pageInfo.hasNextPage, false);
      assert.strictEqual(result.pageInfo.hasPreviousPage, false);
    });

    it('should apply first limit', () => {
      const items = createItems(100);
      const result = paginateArray(items, 20, null, getId);

      assert.strictEqual(result.edges.length, 20);
      assert.strictEqual(result.totalCount, 100);
      assert.strictEqual(result.pageInfo.hasNextPage, true);
      assert.strictEqual(result.pageInfo.hasPreviousPage, false);
    });

    it('should respect maximum limit of 250', () => {
      const items = createItems(500);
      const result = paginateArray(items, 1000, null, getId);

      assert.strictEqual(result.edges.length, 250);
      assert.strictEqual(result.pageInfo.hasNextPage, true);
    });

    it('should use default limit of 50', () => {
      const items = createItems(100);
      const result = paginateArray(items, null, null, getId);

      assert.strictEqual(result.edges.length, 50);
    });

    it('should paginate using after cursor', () => {
      const items = createItems(50);
      const firstPage = paginateArray(items, 10, null, getId);

      assert.strictEqual(firstPage.edges.length, 10);
      assert.strictEqual(firstPage.edges[0].node.id, 'item-1');
      assert.strictEqual(firstPage.edges[9].node.id, 'item-10');

      // Get second page using endCursor
      const secondPage = paginateArray(
        items,
        10,
        firstPage.pageInfo.endCursor,
        getId
      );

      assert.strictEqual(secondPage.edges.length, 10);
      assert.strictEqual(secondPage.edges[0].node.id, 'item-11');
      assert.strictEqual(secondPage.edges[9].node.id, 'item-20');
      assert.strictEqual(secondPage.pageInfo.hasPreviousPage, true);
      assert.strictEqual(secondPage.pageInfo.hasNextPage, true);
    });

    it('should return empty edges for empty array', () => {
      const result = paginateArray<TestItem>([], 10, null, getId);

      assert.strictEqual(result.edges.length, 0);
      assert.strictEqual(result.totalCount, 0);
      assert.strictEqual(result.pageInfo.hasNextPage, false);
      assert.strictEqual(result.pageInfo.hasPreviousPage, false);
      assert.strictEqual(result.pageInfo.startCursor, null);
      assert.strictEqual(result.pageInfo.endCursor, null);
    });

    it('should return correct cursors for each edge', () => {
      const items = createItems(3);
      const result = paginateArray(items, null, null, getId);

      assert.strictEqual(result.edges.length, 3);

      // Each edge should have a valid cursor
      for (const edge of result.edges) {
        const decodedId = decodeCursor(edge.cursor);
        assert.strictEqual(decodedId, edge.node.id);
      }
    });

    it('should handle invalid cursor gracefully (start from beginning)', () => {
      const items = createItems(20);
      const result = paginateArray(items, 10, 'invalid-cursor', getId);

      // Invalid cursor means start from beginning
      assert.strictEqual(result.edges.length, 10);
      assert.strictEqual(result.edges[0].node.id, 'item-1');
    });

    it('should handle cursor pointing to non-existent item', () => {
      const items = createItems(20);
      const nonExistentCursor = encodeCursor('item-999');
      const result = paginateArray(items, 10, nonExistentCursor, getId);

      // Non-existent item means start from beginning
      assert.strictEqual(result.edges.length, 10);
      assert.strictEqual(result.edges[0].node.id, 'item-1');
    });

    it('should detect last page correctly', () => {
      const items = createItems(25);
      const firstPage = paginateArray(items, 20, null, getId);

      assert.strictEqual(firstPage.pageInfo.hasNextPage, true);

      const lastPage = paginateArray(
        items,
        20,
        firstPage.pageInfo.endCursor,
        getId
      );

      assert.strictEqual(lastPage.edges.length, 5);
      assert.strictEqual(lastPage.pageInfo.hasNextPage, false);
      assert.strictEqual(lastPage.pageInfo.hasPreviousPage, true);
    });
  });
});
