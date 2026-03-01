/**
 * RedisNode - contracts for Redis domain-specific nodes
 *
 * Types: redis:read, redis:write, redis:delete, redis:publish, redis:subscribe,
 *        redis:transaction, redis:connection
 *
 * Used by RedisEnricher for Redis operation tracking.
 *
 * ID format: <file>:REDIS_OP:<method>:<line>
 */

import type { BaseNodeRecord } from '@grafema/types';

export interface RedisOperationNodeRecord extends BaseNodeRecord {
  type: 'redis:read' | 'redis:write' | 'redis:delete' | 'redis:publish' | 'redis:subscribe' | 'redis:transaction' | 'redis:connection';
  file: string;
  line: number;
  column: number;
  method: string;
  object?: string;
  key?: string;
  operation: string;
  package: string;
}

const REDIS_TYPES = new Set([
  'redis:read', 'redis:write', 'redis:delete',
  'redis:publish', 'redis:subscribe',
  'redis:transaction', 'redis:connection',
]);

export class RedisNode {
  /**
   * Create a Redis operation node.
   *
   * @param file - Source file path
   * @param method - Redis method name (e.g., 'set', 'get')
   * @param line - Line number
   * @param nodeType - Semantic node type (e.g., 'redis:write')
   * @param operation - Operation category (e.g., 'write', 'read')
   * @param options - Additional metadata
   */
  static createOperation(
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
  ): RedisOperationNodeRecord {
    if (!file) throw new Error('RedisNode.createOperation: file is required');
    if (!method) throw new Error('RedisNode.createOperation: method is required');

    return {
      id: `${file}:REDIS_OP:${method}:${line}`,
      type: nodeType as RedisOperationNodeRecord['type'],
      name: options.object ? `${options.object}.${method}` : `redis.${method}`,
      file,
      line,
      column: options.column ?? 0,
      method,
      object: options.object,
      key: options.key,
      operation,
      package: options.package ?? 'ioredis',
    };
  }

  /**
   * Check if a type belongs to the Redis domain.
   */
  static isRedisType(type: string): boolean {
    return REDIS_TYPES.has(type);
  }

  /**
   * Validate a Redis domain node.
   */
  static validate(node: BaseNodeRecord): string[] {
    const errors: string[] = [];

    if (!RedisNode.isRedisType(node.type)) {
      errors.push(`Expected redis:* type, got ${node.type}`);
    }

    if (!node.id) errors.push('Missing required field: id');

    return errors;
  }
}
