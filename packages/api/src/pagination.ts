/**
 * Cursor-based Pagination Utilities
 *
 * Implements Relay Connection spec for cursor-based pagination.
 */

/**
 * Encode a cursor from an ID.
 * Format: base64("cursor:${id}")
 */
export function encodeCursor(id: string): string {
  return Buffer.from(`cursor:${id}`).toString('base64');
}

/**
 * Decode a cursor to get the ID.
 * Returns null if cursor is invalid.
 */
export function decodeCursor(cursor: string): string | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    if (decoded.startsWith('cursor:')) {
      return decoded.slice(7);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * PageInfo structure per Relay spec.
 */
export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

/**
 * Edge structure for connections.
 */
export interface Edge<T> {
  node: T;
  cursor: string;
}

/**
 * Connection structure per Relay spec.
 */
export interface Connection<T> {
  edges: Edge<T>[];
  pageInfo: PageInfo;
  totalCount: number;
}

/**
 * Apply cursor-based pagination to an array.
 *
 * @param items - All items (already filtered)
 * @param first - Number of items to return (default: 50, max: 250)
 * @param after - Cursor to start after
 * @param getId - Function to get ID from item for cursor encoding
 * @returns Connection structure
 */
export function paginateArray<T>(
  items: T[],
  first: number | null | undefined,
  after: string | null | undefined,
  getId: (item: T) => string
): Connection<T> {
  const limit = Math.min(first ?? 50, 250);

  // Find start index based on cursor
  let startIndex = 0;
  if (after) {
    const afterId = decodeCursor(after);
    if (afterId) {
      const afterIndex = items.findIndex((item) => getId(item) === afterId);
      if (afterIndex !== -1) {
        startIndex = afterIndex + 1;
      }
    }
  }

  // Slice items
  const slicedItems = items.slice(startIndex, startIndex + limit);

  // Build edges
  const edges: Edge<T>[] = slicedItems.map((item) => ({
    node: item,
    cursor: encodeCursor(getId(item)),
  }));

  // Build pageInfo
  const pageInfo: PageInfo = {
    hasNextPage: startIndex + limit < items.length,
    hasPreviousPage: startIndex > 0,
    startCursor: edges.length > 0 ? edges[0].cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
  };

  return {
    edges,
    pageInfo,
    totalCount: items.length,
  };
}
