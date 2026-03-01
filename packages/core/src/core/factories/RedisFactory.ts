/**
 * RedisFactory - factory methods for Redis-related graph nodes
 *
 * Handles: redis:read, redis:write, redis:delete, redis:publish,
 *          redis:subscribe, redis:transaction, redis:connection
 */

import { RedisNode } from '../nodes/RedisNode.js';
import { brandNodeInternal } from '../brandNodeInternal.js';

export class RedisFactory {
  static createRedisOperation(
    file: string,
    method: string,
    line: number,
    nodeType: string,
    operation: string,
    options: {
      column?: number;
      object?: string;
      key?: string;
      package?: string;
    } = {}
  ) {
    return brandNodeInternal(
      RedisNode.createOperation(file, method, line, nodeType, operation, options)
    );
  }
}
